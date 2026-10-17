/**
 * Loyalty points routes (R5 + R2 + R11 + code minimums) — HTTP integration tests
 *
 * Run with: npx tsx server/points.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migration 048 applied) with a Stripe stub. Environment variables:
 *
 *   PTS_TEST_BASE_URL      e.g. http://localhost:5062   (must be localhost)
 *   PTS_TEST_PG_URL        the SAME scratch database (localhost only)
 *   PTS_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                          STRIPE_STUB_PORT=<same> and
 *                          NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET             identical to the server's
 *
 * Skips (exit 0) when PTS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks: removing requirePlatformAdmin from POST /api/points/earn must turn section 1
 * red; removing the promoMinimumBaseCents check in /api/cart/payment-intent must turn section 4 red.
 */
import http from 'http';
import crypto from 'crypto';

const BASE = process.env.PTS_TEST_BASE_URL;
const PG_URL = process.env.PTS_TEST_PG_URL;
const STUB_PORT = Number(process.env.PTS_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u?: string) => !!u && ['localhost', '127.0.0.1'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) { console.log('⏭  skipped: set PTS_TEST_BASE_URL (+ PTS_TEST_PG_URL, PTS_TEST_STRIPE_PORT)'); process.exit(0); }
  if (!isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: base URL and database must both be local scratch instances');

  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub: records every PaymentIntent ─────────────────────────
  const pis: any[] = [];
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === 'POST' && req.url === '/v1/customers') return send(200, { id: `cus_stub_${Date.now()}`, object: 'customer' });
      if (req.method === 'GET' && req.url?.startsWith('/v1/customers/')) return send(200, { id: req.url.split('/')[3], object: 'customer' });
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        const pi = {
          id: `pi_stub_${Date.now()}_${pis.length}`, object: 'payment_intent', status: 'requires_payment_method',
          amount: Number(form.get('amount') || 0), transfer: Number(form.get('transfer_data[amount]') || 0),
          client_secret: 'secret_stub', metadata: {},
        };
        pis.push(pi);
        return send(200, pi);
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ──────────────────────────────────────────────────────────────
  const P = `pt${Date.now().toString(36)}`;
  const mkUser = async (name: string, o: { admin?: boolean; email?: string; points?: number } = {}) => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO users (id, username, email, is_admin, loyalty_points, is_active) VALUES ($1, $2, $3, $4, $5, true)`,
      [id, `${P}${name}`, o.email ?? `${P}-${name}@x.test`, !!o.admin, o.points ?? 0]);
    return id;
  };
  const existing = await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com'`);
  const adminId = existing.length ? existing[0].id : await mkUser('admin', { admin: true, email: 'info@goutsyde.com' });
  await q(`UPDATE users SET is_admin = true WHERE id = $1`, [adminId]);
  const customer = await mkUser('cust', { points: 0 });
  const rich = await mkUser('rich', { points: 6000 });
  const owner = await mkUser('owner');
  const fakeAdmin = await mkUser('fakeadmin', { admin: true });
  const bizId = crypto.randomUUID();
  await q(`INSERT INTO businesses (id, owner_id, name, category, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', 'acct_stub_1', true)`, [bizId, owner, `${P} Shop`]);
  const biz2 = crypto.randomUUID();
  await q(`INSERT INTO businesses (id, owner_id, name, category, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', 'acct_stub_2', true)`, [biz2, owner, `${P} Shop 2`]);

  const tok = (id: string, isAdmin = false) => generateAccessToken({ userId: id, isAdmin } as any);
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  };
  const balance = async (id: string) => Number((await q(`SELECT loyalty_points FROM users WHERE id=$1`, [id]))[0].loyalty_points);

  console.log('\n1. R5: customers can no longer credit themselves');
  {
    const self = await call('POST', '/api/points/earn', tok(customer), { dollarAmountCents: 999999, transactionType: 'bonus' });
    assert(self.status === 401 || self.status === 403, 'customer self-credit refused', self);
    const noAuth = await call('POST', '/api/points/earn', undefined, { dollarAmountCents: 999999, transactionType: 'bonus' });
    assert(noAuth.status === 401, 'signed-out refused', noAuth.status);
    const notAllowed = await call('POST', '/api/points/earn', tok(fakeAdmin, true), { userId: customer, points: 100, description: 'x' });
    assert(notAllowed.status === 403, 'isAdmin without an allowed admin email refused', notAllowed);
    assert((await balance(customer)) === 0, 'balance unchanged');
    const ok = await call('POST', '/api/points/earn', tok(adminId, true), { userId: customer, points: 250, description: 'Goodwill credit' });
    const row = await q(`SELECT reference_type, points FROM point_transactions WHERE user_id=$1`, [customer]);
    assert(ok.status === 200 && (await balance(customer)) === 250 && row[0]?.reference_type === 'admin_adjustment', 'platform admin can credit another user, with a ledger row', { ok, row });
  }

  console.log('\n2. Balance shows the real value (500 points = $1) and active codes');
  {
    const b = await call('GET', '/api/points/balance', tok(rich));
    assert(b.status === 200 && b.json.balance === 6000 && b.json.dollarValue === 12 && b.json.canRedeem === true && Array.isArray(b.json.activeCodes),
      '6000 points = $12.00, canRedeem, activeCodes list', b.json);
  }

  console.log('\n3. Redeem works and returns a code with its minimum order');
  let codeId = '';
  let code = '';
  {
    const r = await call('POST', '/api/points/redeem', tok(rich), { pointsToRedeem: 2500 });
    code = r.json?.code;
    assert(r.status === 200 && r.json.discountCents === 500 && r.json.newBalance === 3500 && r.json.minimumOrderCents === 5000 && (await balance(rich)) === 3500,
      '2500 points -> $5 code, balance 3500, minimum order $50', r.json);
    const bad = await call('POST', '/api/points/redeem', tok(rich), { pointsToRedeem: 100 });
    assert(bad.status === 400 && String(bad.json.error).includes('2500 pts ($5)'), 'non-tier amount: 400 with correct dollar labels', bad.json);
    const v = await call('POST', '/api/points/validate-code', tok(rich), { code });
    codeId = v.json?.codeId;
    assert(v.status === 200 && v.json.minimumOrderCents === 5000, 'validate-code returns codeId + minimum', v.json);
    const vSmall = await call('POST', '/api/points/validate-code', tok(rich), { code, baseCents: 1000 });
    assert(vSmall.status === 400 && vSmall.json.minimumOrderCents === 5000, 'validate-code with a $10 base: refused with the minimum', vSmall.json);
    const vOther = await call('POST', '/api/points/validate-code', tok(customer), { code });
    assert(vOther.status === 400, "someone else's code is refused");
  }

  console.log('\n4. Code minimums at checkout (cart PaymentIntent)');
  {
    const addr = { line1: '1 Test St', city: 'Freeport', state: 'NY', zipCode: '11520' };
    const item = (priceCents: number, vendorId = bizId) => ({ isExternalProduct: true, vendorId, priceCents, quantity: 1, name: 'Test item' });
    const before = pis.length;
    const small = await call('POST', '/api/cart/payment-intent', tok(rich), { items: [item(1000)], shippingAddress: addr, promoCodeId: codeId });
    assert(small.status === 400 && small.json?.error?.code === 'PROMO_MINIMUM_NOT_MET' && pis.length === before, '$5 code on a $10 order: refused, no PaymentIntent', small.json);
    const other = await call('POST', '/api/cart/payment-intent', tok(customer), { items: [item(6000)], shippingAddress: addr, promoCodeId: codeId });
    assert(other.status === 400 && other.json?.error?.code === 'INVALID_PROMO', "someone else's code refused at checkout", other.json);
    const multi = await call('POST', '/api/cart/payment-intent', tok(rich), { items: [item(6000), item(6000, biz2)], shippingAddress: addr, promoCodeId: codeId });
    assert(multi.status === 400 && multi.json?.error?.code === 'PROMO_SINGLE_SHOP_ONLY', 'code on a multi-shop cart: refused (was silently ignored)', multi.json);
    const okRes = await call('POST', '/api/cart/payment-intent', tok(rich), { items: [item(6000)], shippingAddress: addr, promoCodeId: codeId });
    const pi = pis[pis.length - 1];
    assert(okRes.status === 200 && pi && pi.amount === 6480 - 500 && pi.transfer === 5880 && pi.amount >= pi.transfer,
      '$5 code on a $60 order: charge $59.80, vendor transfer $58.80 unchanged', { status: okRes.status, json: okRes.json, pi });
    const noCode = await call('POST', '/api/cart/payment-intent', tok(customer), { items: [item(1000)], shippingAddress: addr });
    const pi2 = pis[pis.length - 1];
    assert(noCode.status === 200 && pi2.amount === 1080 && pi2.transfer === 980, 'no code: $10.80 charged, $9.80 transfer (money unchanged)', pi2);
    assert(noCode.json?.feeBreakdown?.outsydePointsEarned === 200 || JSON.stringify(noCode.json).includes('"outsydePointsEarned":200'),
      'checkout preview shows 200 points for $10', noCode.json);
  }

  console.log('\n5. Completing an appointment releases its pending points (no 250 bonus)');
  {
    const apptId = crypto.randomUUID();
    await q(`INSERT INTO appointments (id, client_id, business_id, service_id, status, appointment_date, appointment_time, total_price, duration_minutes)
             VALUES ($1, $2, $3, $4, 'confirmed', '2026-02-02', '11:00', 27500, 60)`, [apptId, customer, bizId, crypto.randomUUID()]).catch(async () => {
      await q(`INSERT INTO appointments (id, client_id, business_id, status, appointment_date, appointment_time, total_price)
               VALUES ($1, $2, $3, 'confirmed', '2026-02-02', '11:00', 27500)`, [apptId, customer, bizId]);
    });
    await q(`INSERT INTO pending_points_transactions (id, user_id, dollar_amount_cents, transaction_type, points_earned, outsyde_revenue_cents, reference_type, reference_id, status, release_after)
             VALUES ($1, $2, 3240, 'business_transaction', 600, 120, 'appointment', $3, 'pending', now() + interval '3 days')`, [crypto.randomUUID(), customer, apptId]);
    const before = await balance(customer);
    const notOwner = await call('PATCH', `/api/bookings/appointments/${apptId}/complete`, tok(customer));
    assert(notOwner.status === 403, 'only the business owner can complete');
    const c = await call('PATCH', `/api/bookings/appointments/${apptId}/complete`, tok(owner));
    assert(c.status === 200 && c.json.pointsAwarded === 600 && (await balance(customer)) === before + 600, 'complete: +600 released, no extra 250', { c, after: await balance(customer) });
  }

  console.log('\n6. R11: pending-points admin routes use the platform admin check');
  {
    const list = await call('GET', '/api/admin/points/pending', tok(fakeAdmin, true));
    assert(list.status === 403, 'isAdmin without an allowed email: 403', list.status);
    const list2 = await call('GET', '/api/admin/points/pending?status=approved', tok(adminId, true));
    assert(list2.status === 200 && Array.isArray(list2.json.transactions), 'platform admin can list', list2.status);
  }

  console.log('\n7. Referral apply pays nothing until the first purchase');
  {
    const A = await mkUser('refA');
    const B = await mkUser('refB');
    const codeRes = await call('GET', '/api/referral/code', tok(A));
    // /api/referral/* are session-only routes; with a Bearer token they answer 401 — exercise storage directly instead.
    if (codeRes.status === 401) {
      const { storage } = await import('./storage');
      const rc = await storage.generateReferralCode(A);
      const applied = await storage.processReferral(B, rc);
      assert(applied.success && (await balance(B)) === 0 && (await balance(A)) === 0, 'code applied, 0 points paid yet (was 250 instantly)');
    } else {
      assert(codeRes.json.bonusForReferrer === 500 && codeRes.json.bonusForNewUser === 500, 'referral copy shows 500 / 500', codeRes.json);
    }
  }

  stub.close();
  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
