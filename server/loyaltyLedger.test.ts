/**
 * Loyalty points ledger (R2 points fix) — run with:
 *   POINTS_LOCAL_PG=postgresql://outsyde:outsyde@localhost:5432/outsyde DATABASE_URL=x \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/loyaltyLedger.test.ts
 *
 * SCRATCH ONLY. Needs a LOCAL Postgres built from shared/schema.ts (drizzle-kit push to 127.0.0.1)
 * plus migrations/048, reached through .dev/neon-local-proxy.mjs (the same neon-http driver as
 * production, so db.transaction() would throw here too).
 * Skips (exit 0) when POINTS_LOCAL_PG is unset; refuses any non-local database.
 */
import crypto from 'node:crypto';
import pg from 'pg';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

(async () => {
  const PG = process.env.POINTS_LOCAL_PG;
  if (!PG) { console.log('⏭  skipped: set POINTS_LOCAL_PG to run'); process.exit(0); }
  if (!['localhost', '127.0.0.1'].includes(new URL(PG).hostname)) throw new Error('refusing to run: POINTS_LOCAL_PG must be local');

  const ledger = await import('./loyaltyLedger');
  const { storage } = await import('./storage');
  const { transitionAppointmentState } = await import('./bookingStateMachine');

  const pool = new pg.Pool({ connectionString: PG });
  const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;

  async function ins(table: string, values: Record<string, unknown>): Promise<string> {
    const cols = await q(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [table]);
    const row: Record<string, unknown> = { ...values };
    for (const c of cols) {
      if (c.column_name in row) continue;
      const t = String(c.data_type);
      row[c.column_name] =
        t.includes('int') || t === 'numeric' || t.includes('double') || t === 'real' ? 0 :
        t === 'boolean' ? false :
        t.includes('timestamp') || t === 'date' ? new Date() :
        t === 'jsonb' || t === 'json' ? '{}' :
        t === 'ARRAY' ? '{}' :
        c.column_name === 'id' ? crypto.randomUUID() : `t-${c.column_name}`;
    }
    const keys = Object.keys(row);
    const res = await q(
      `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => row[k]));
    return String(res[0].id);
  }
  const S = Date.now().toString(36);
  let n = 0;
  const user = async (pts = 0) => ins('users', {
    id: crypto.randomUUID(), email: `pts-${S}-${++n}@test.local`, username: `pts${S}${n}`, loyalty_points: pts, is_active: true,
  });
  const balance = async (u: string) => Number((await q('SELECT loyalty_points FROM users WHERE id=$1', [u]))[0].loyalty_points);
  const ledgerSum = async (u: string) => Number((await q('SELECT COALESCE(SUM(points),0) s FROM point_transactions WHERE user_id=$1 AND type <> $2', [u, 'redeem']))[0].s)
    - Number((await q('SELECT COALESCE(SUM(points),0) s FROM point_transactions WHERE user_id=$1 AND type = $2', [u, 'redeem']))[0].s);
  const business = async (ownerId: string) => ins('businesses', { id: crypto.randomUUID(), owner_id: ownerId, name: `Biz ${S}` });
  const order = async (customerId: string, businessId: string, status = 'paid') => ins('orders', {
    id: crypto.randomUUID(), customer_id: customerId, business_id: businessId, status, total_amount: 1000,
  });
  const appt = async (clientId: string, businessId: string, status = 'confirmed', date = '2026-01-10') => ins('appointments', {
    id: crypto.randomUUID(), client_id: clientId, business_id: businessId, status, appointment_date: date, appointment_time: '10:00', total_price: 27500,
  });

  console.log('\n1. Formula: half the service fee, 500 points = $1');
  assert(ledger.pointsForGrossCents(1080) === 200, '$10 product (gross $10.80) earns 200 points');
  assert(ledger.pointsForGrossCents(13500) === 2500, '$125 service (fee $10) earns 2500 points = $5');
  assert(ledger.pointsForGrossCents(3240) === 600, '$30 deposit (gross $32.40) earns 600 points');
  assert(ledger.pointsValueCents(2500) === 500, '2500 points are worth $5');
  assert(ledger.promoMinimumBaseCents(500) === 5000, '$5 code needs a $50 order');
  assert(ledger.promoMinimumBaseCents(10000) === 100000, '$100 code needs a $1,000 order');

  console.log('\n2. Product earn: credited once, even on retries and parallel deliveries');
  {
    const u = await user();
    const ref = crypto.randomUUID();
    const tx = await storage.earnPoints({ userId: u, dollarAmountCents: 1080, transactionType: 'business_transaction', referenceType: 'cart_order', referenceId: ref });
    assert(tx.points === 200 && (await balance(u)) === 200, 'first delivery credits 200', { points: tx.points });
    await storage.earnPoints({ userId: u, dollarAmountCents: 1080, transactionType: 'business_transaction', referenceType: 'cart_order', referenceId: ref });
    await Promise.all([1, 2, 3, 4, 5].map(() => storage.earnPoints({ userId: u, dollarAmountCents: 1080, transactionType: 'business_transaction', referenceType: 'cart_order', referenceId: ref }).catch(() => null)));
    const rows = await q('SELECT count(*)::int n FROM point_transactions WHERE user_id=$1', [u]);
    assert((await balance(u)) === 200 && rows[0].n === 1, 'retries and 5 parallel deliveries add nothing', { bal: await balance(u), rows: rows[0].n });
    assert((await ledgerSum(u)) === (await balance(u)), 'balance equals ledger');
  }

  console.log('\n3. Booking points: pending, released on complete, rejected on cancel');
  {
    const c = await user();
    const owner = await user();
    const b = await business(owner);
    const a1 = await appt(c, b);
    await storage.createPendingPointTransaction({ userId: c, dollarAmountCents: 3240, transactionType: 'business_transaction', referenceType: 'appointment', referenceId: a1, releaseAfter: ledger.releaseAfterForBooking('2026-01-10', '10:00') });
    assert((await balance(c)) === 0, 'nothing credited at payment');
    const again = await storage.createPendingPointTransaction({ userId: c, dollarAmountCents: 3240, transactionType: 'business_transaction', referenceType: 'appointment', referenceId: a1 });
    const pend = await q('SELECT count(*)::int n FROM pending_points_transactions WHERE reference_id=$1', [a1]);
    assert(pend[0].n === 1 && again.pointsEarned === 600, 'duplicate pending is a no-op (one row, 600 points)');
    const r1 = await ledger.releasePendingForReference('appointment', a1, owner);
    assert(r1?.pointsEarned === 600 && (await balance(c)) === 600, 'complete releases 600 points', r1);
    const r2 = await ledger.releasePendingForReference('appointment', a1, owner);
    assert(r2 === null && (await balance(c)) === 600, 'second release does nothing');

    const a2 = await appt(c, b);
    await storage.createPendingPointTransaction({ userId: c, dollarAmountCents: 3240, transactionType: 'business_transaction', referenceType: 'appointment', referenceId: a2, releaseAfter: new Date(Date.now() - 1000) });
    const t = await transitionAppointmentState(a2, 'canceled' as any, { triggeredBy: c, triggerSource: 'api' } as any);
    const st = await q('SELECT status FROM pending_points_transactions WHERE reference_id=$1', [a2]);
    assert(t.success && st[0].status === 'rejected', 'cancel through the state machine rejects pending points', { t, st });
    await ledger.releaseDuePendingPoints();
    assert((await balance(c)) === 600, 'auto-release never credits a cancelled booking');

    const a3 = await appt(c, b, 'confirmed');
    await storage.createPendingPointTransaction({ userId: c, dollarAmountCents: 13500, transactionType: 'business_transaction', referenceType: 'appointment', referenceId: a3, releaseAfter: new Date(Date.now() - 1000) });
    const a4 = await appt(c, b, 'confirmed');
    await storage.createPendingPointTransaction({ userId: c, dollarAmountCents: 13500, transactionType: 'business_transaction', referenceType: 'appointment', referenceId: a4, releaseAfter: new Date(Date.now() + 86400000) });
    const a5 = await appt(c, b, 'no_show');
    await storage.createPendingPointTransaction({ userId: c, dollarAmountCents: 13500, transactionType: 'business_transaction', referenceType: 'appointment', referenceId: a5, releaseAfter: new Date(Date.now() - 1000) });
    await ledger.releaseDuePendingPoints();
    const s3 = (await q('SELECT status FROM pending_points_transactions WHERE reference_id=$1', [a3]))[0].status;
    const s4 = (await q('SELECT status FROM pending_points_transactions WHERE reference_id=$1', [a4]))[0].status;
    const s5 = (await q('SELECT status FROM pending_points_transactions WHERE reference_id=$1', [a5]))[0].status;
    assert(s3 === 'approved' && s4 === 'pending' && s5 === 'rejected' && (await balance(c)) === 3100,
      'auto-release: due+confirmed released, not-yet-due waits, no-show rejected', { s3, s4, s5, bal: await balance(c) });
    assert((await ledgerSum(c)) === (await balance(c)), 'balance equals ledger');
  }

  console.log('\n4. Redeem: points + ledger row + code together, never below zero');
  {
    const u = await user(2400);
    const short = await storage.redeemPointsForCode(u, 2500);
    assert(!short.ok && (await balance(u)) === 2400, 'short balance: refused, nothing taken', short);
    const bad = await storage.redeemPointsForCode(u, 100);
    assert(!bad.ok, 'non-tier amount refused');

    const v = await user(5000);
    const ok = await storage.redeemPointsForCode(v, 2500);
    const code = ok.ok ? (await q('SELECT status, points_cost, discount_cents FROM promo_codes WHERE id=$1', [ok.codeId]))[0] : null;
    const redeemRow = ok.ok ? (await q('SELECT points, balance_after, reference_type FROM point_transactions WHERE id=$1', [ok.transactionId]))[0] : null;
    assert(ok.ok && (await balance(v)) === 2500 && code?.status === 'active' && code?.discount_cents === 500 && redeemRow?.balance_after === 2500,
      '2500 points become one active $5 code with a ledger row', { ok, code, redeemRow });
    const dup = await storage.redeemPointsForCode(v, 2500);
    assert(!dup.ok && (await balance(v)) === 2500, 'second $5 code while one is active: refused, points kept', dup);

    const w = await user(5000);
    const results = await Promise.all([2500, 5000, 2500, 5000].map(p => storage.redeemPointsForCode(w, p).catch(e => ({ ok: false, error: String(e) }))));
    const spent = results.filter(r => r.ok).reduce((s, r: any) => s + (r.discountCents === 1000 ? 5000 : 2500), 0);
    assert((await balance(w)) === 5000 - spent && (await balance(w)) >= 0, 'parallel redemptions never overspend', { bal: await balance(w), spent });
  }

  console.log('\n5. Promo code apply: once only');
  {
    const u = await user(2500);
    const owner = await user();
    const b = await business(owner);
    const r = await storage.redeemPointsForCode(u, 2500);
    const o = await order(u, b);
    if (!r.ok) throw new Error('setup redeem failed');
    await storage.applyPromoCode(r.codeId, 'order', o);
    const ord = (await q('SELECT promo_code_used, discount_amount_cents, points_redeemed FROM orders WHERE id=$1', [o]))[0];
    const pc = (await q('SELECT status, used_on_order_id FROM promo_codes WHERE id=$1', [r.codeId]))[0];
    assert(pc.status === 'used' && pc.used_on_order_id === o && ord.discount_amount_cents === 500 && ord.points_redeemed === 2500, 'code marked used and copied onto the order', { pc, ord });
    let threw = false;
    try { await storage.applyPromoCode(r.codeId, 'order', o); } catch { threw = true; }
    assert(threw, 'applying the same code again is refused');
  }

  console.log('\n6. Refund clawback never exceeds what was earned');
  {
    const u = await user();
    const ref = crypto.randomUUID();
    await storage.earnPoints({ userId: u, dollarAmountCents: 10800, transactionType: 'business_transaction', referenceType: 'cart_order', referenceId: ref });
    const half = await storage.reversePointsForRefund(u, 'cart_order', ref, { refundFraction: 0.5 });
    const full = await storage.reversePointsForRefund(u, 'cart_order', ref);
    const extra = await storage.reversePointsForRefund(u, 'cart_order', ref);
    assert(half.pointsReversed === 1000 && full.pointsReversed === 1000 && !extra.reversed && (await balance(u)) === 0,
      '50% then full refund takes back exactly 2000, a third call nothing', { half, full, extra, bal: await balance(u) });
    assert((await ledgerSum(u)) === (await balance(u)), 'balance equals ledger');
  }

  console.log('\n7. Referrals: 500 each, only when the first purchase is final');
  {
    const A = await user();
    const B = await user();
    const code = await storage.generateReferralCode(A);
    const applied = await storage.processReferral(B, code);
    assert(applied.success && (await balance(B)) === 0 && (await balance(A)) === 0, 'applying a code pays nothing yet', applied);

    const owner = await user();
    const shop = await business(owner);
    const small = await order(B, shop);
    assert((await ledger.qualifyReferral(B, { type: 'order', id: small, grossCents: 700, final: false })) === 'skipped', 'purchase under $7 base does not qualify');

    const o = await order(B, shop);
    const res = await ledger.qualifyReferral(B, { type: 'order', id: o, grossCents: 1080, final: false });
    const pend = await q(`SELECT user_id, points_earned, status FROM pending_points_transactions WHERE reference_type LIKE 'referral_%' AND user_id = ANY($1)`, [[A, B]]);
    assert(res === 'qualified' && pend.length === 2 && pend.every((p: any) => p.points_earned === 500 && p.status === 'pending'), 'product purchase: both bonuses held as pending', pend);
    await ledger.releaseDuePendingPoints();
    assert((await balance(A)) === 0, 'not released before 3 days');
    await q(`UPDATE pending_points_transactions SET release_after = now() - interval '1 minute' WHERE reference_type LIKE 'referral_%' AND user_id = ANY($1)`, [[A, B]]);
    await ledger.releaseDuePendingPoints();
    const ref = (await q('SELECT status FROM referrals WHERE referred_user_id=$1', [B]))[0];
    assert((await balance(A)) === 500 && (await balance(B)) === 500 && ref.status === 'completed', 'after 3 days both get 500, referral completed', { a: await balance(A), b: await balance(B), ref });

    // Cancelled qualifying order: bonuses rejected, referral can qualify again later
    const C = await user();
    const D = await user();
    await storage.processReferral(D, await storage.generateReferralCode(C));
    const o2 = await order(D, shop);
    await ledger.qualifyReferral(D, { type: 'order', id: o2, grossCents: 2160, final: false });
    await q(`UPDATE orders SET status='cancelled' WHERE id=$1`, [o2]);
    await q(`UPDATE pending_points_transactions SET release_after = now() - interval '1 minute' WHERE reference_type LIKE 'referral_%' AND user_id = ANY($1)`, [[C, D]]);
    await ledger.releaseDuePendingPoints();
    const ref2 = (await q('SELECT status FROM referrals WHERE referred_user_id=$1', [D]))[0];
    assert((await balance(C)) === 0 && (await balance(D)) === 0 && ref2.status === 'pending', 'cancelled first order: no bonus, referral reopened', ref2);

    // Buying from the referrer's own business never pays
    const E = await user();
    const F = await user();
    await storage.processReferral(F, await storage.generateReferralCode(E));
    const eShop = await business(E);
    const o3 = await order(F, eShop);
    assert((await ledger.qualifyReferral(F, { type: 'order', id: o3, grossCents: 5400, final: false })) === 'skipped', "purchase from the referrer's own business does not qualify");

    // Booking: referral pays the moment the booking's points are released (final)
    const G = await user();
    const H = await user();
    await storage.processReferral(H, await storage.generateReferralCode(G));
    const ap = await appt(H, shop, 'confirmed');
    await storage.createPendingPointTransaction({ userId: H, dollarAmountCents: 3240, transactionType: 'business_transaction', referenceType: 'appointment', referenceId: ap });
    await ledger.releasePendingForReference('appointment', ap, owner);
    assert((await balance(H)) === 600 + 500 && (await balance(G)) === 500, 'completed booking: friend gets 600 purchase + 500, referrer 500', { h: await balance(H), g: await balance(G) });
    for (const x of [A, B, G, H]) assert((await ledgerSum(x)) === (await balance(x)), `balance equals ledger (${x.slice(0, 6)})`);
  }

  console.log('\n7b. Settlement (main booking path) holds points on the deposit, not the full price');
  {
    const { settleAppointmentBooking } = await import('./bookingSettlement');
    const c = await user();
    const owner = await user();
    const b = await business(owner); // no Stripe account: payout is logged as failed, points still run
    const id = await ins('appointments', {
      id: crypto.randomUUID(), client_id: c, business_id: b, status: 'confirmed', appointment_date: '2026-03-05',
      appointment_time: '14:00', total_price: 27500, deposit_amount_cents: 3000,
    });
    const r = await settleAppointmentBooking(id);
    const p = (await q('SELECT points_earned, dollar_amount_cents, status, release_after FROM pending_points_transactions WHERE reference_id=$1', [id]))[0];
    const expected = new Date('2026-03-08T14:00:00Z').getTime();
    assert(r.settled && p?.points_earned === 600 && p?.dollar_amount_cents === 3240 && p?.status === 'pending' && new Date(p.release_after).getTime() === expected,
      '$275 job with $30 deposit: 600 points pending, release 3 days after the appointment', { r, p });
    assert((await balance(c)) === 0, 'nothing credited at payment');
  }

  console.log('\n8. Admin manual credit has its own ledger row');
  {
    const u = await user();
    const c = await ledger.creditPoints({ userId: u, points: 694, dollarAmountCents: 0, referenceType: 'admin_adjustment', referenceId: crypto.randomUUID(), description: 'Manual credit' });
    assert(c?.balanceAfter === 694 && (await ledgerSum(u)) === 694, 'credit + ledger in one write');
    const missing = await ledger.creditPoints({ userId: crypto.randomUUID(), points: 5, dollarAmountCents: 0, referenceType: 'admin_adjustment', referenceId: crypto.randomUUID() }).catch(e => String(e));
    assert(String(missing).includes('not found'), 'unknown user is refused');
  }

  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
