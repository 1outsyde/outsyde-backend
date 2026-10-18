/**
 * Booking payouts: fallback to the customer's charge, retry, alert (server/payouts.ts). Run with:
 *   PAYOUT_LOCAL_PG=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   DATABASE_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde STRIPE_SECRET_KEY=sk_test_stub \
 *   STRIPE_STUB_PORT=5097 NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" \
 *   npx tsx server/payouts.test.ts
 *
 * SCRATCH ONLY: a LOCAL Postgres with migration 052, through .dev/neon-local-proxy.mjs, and the
 * in-process Stripe stub below (nothing reaches Stripe). Skips when PAYOUT_LOCAL_PG is unset.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

(async () => {
  const PG = process.env.PAYOUT_LOCAL_PG;
  const STUB_PORT = Number(process.env.STRIPE_STUB_PORT || 0);
  if (!PG) { console.log('⏭  skipped: set PAYOUT_LOCAL_PG'); process.exit(0); }
  if (!['localhost', '127.0.0.1'].includes(new URL(PG).hostname) || !STUB_PORT) throw new Error('refusing: local DB and STRIPE_STUB_PORT required');

  // ── Stripe stub ───────────────────────────────────────────────────────
  let balanceCents = 0;                 // available balance; transfers without source_transaction need it
  let failAccounts = new Set<string>(); // destinations that error (not a balance problem)
  const transfers: any[] = [];
  const pis: Record<string, { amount: number; refunded: number }> = {};
  let topups: any[] = [];
  let seq = 0;
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const url = (req.url || '').split('?')[0];
      const query = new URLSearchParams((req.url || '').split('?')[1] || '');
      if (req.method === 'GET' && url === '/v1/transfers') {
        const g = query.get('transfer_group');
        return send(200, { object: 'list', data: transfers.filter(t => t.transfer_group === g), has_more: false });
      }
      if (req.method === 'POST' && url === '/v1/transfers') {
        const amount = Number(form.get('amount'));
        const dest = form.get('destination') || '';
        const src = form.get('source_transaction');
        if (failAccounts.has(dest)) return send(400, { error: { type: 'invalid_request_error', code: 'account_invalid', message: 'No such destination' } });
        if (src) {
          const pi = Object.entries(pis).find(([id]) => `ch_${id}` === src)?.[1];
          if (!pi || amount > pi.amount) return send(400, { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: 'amount exceeds source' } });
        } else if (amount > balanceCents) {
          return send(400, { error: { type: 'invalid_request_error', code: 'balance_insufficient', message: 'You have insufficient available funds in your Stripe account.' } });
        } else {
          balanceCents -= amount;
        }
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
        const t = { id: `tr_${++seq}`, object: 'transfer', amount, destination: dest, transfer_group: form.get('transfer_group'), source_transaction: src, metadata };
        transfers.push(t);
        return send(200, t);
      }
      let m = url.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        const pi = pis[m[1]];
        if (!pi) return send(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no pi' } });
        return send(200, { id: m[1], object: 'payment_intent', status: 'succeeded', amount: pi.amount, amount_received: pi.amount, latest_charge: { id: `ch_${m[1]}`, object: 'charge', amount_refunded: pi.refunded } });
      }
      if (req.method === 'GET' && url === '/v1/balance') {
        return send(200, { object: 'balance', available: [{ amount: balanceCents, currency: 'usd' }], pending: [] });
      }
      if (req.method === 'POST' && url === '/v1/topups') {
        const t = { id: `tu_${++seq}`, object: 'topup', amount: Number(form.get('amount')), status: 'pending' };
        topups.push(t);
        return send(200, t);
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>(r => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const { settleAppointmentBooking, settleShootBooking } = await import('./bookingSettlement');
  const payouts = await import('./payouts');
  const pool = new pg.Pool({ connectionString: PG });
  const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;

  const S = Date.now().toString(36);
  let n = 0;
  const ids: { users: string[]; biz: string[]; appts: string[]; shoots: string[]; photogs: string[] } = { users: [], biz: [], appts: [], shoots: [], photogs: [] };
  const user = async () => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO users (id, email, username, is_active) VALUES ($1, $2, $3, true)`, [id, `po-${S}-${++n}@test.local`, `po${S}${n}`]);
    ids.users.push(id); return id;
  };
  const owner = await user();
  const client = await user();
  const bizId = crypto.randomUUID();
  const acct = `acct_po_${S}`;
  await q(`INSERT INTO businesses (id, owner_id, name, category, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'Payout Biz', 'beauty', $3, true)`, [bizId, owner, acct]);
  ids.biz.push(bizId);
  const appt = async (piId: string, chargedCents: number, totalPrice = 5000) => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, status, stripe_payment_intent_id)
             VALUES ($1, $2, $3, '2030-01-10', '10:00', $4, 'confirmed', $5)`, [id, bizId, client, totalPrice, piId]);
    pis[piId] = { amount: chargedCents, refunded: 0 };
    ids.appts.push(id); return id;
  };
  const issues = (id: string) => q(`SELECT recipient_key, amount_cents, status, attempts, last_error, alerted_at FROM booking_payout_issues WHERE reference_id = $1 ORDER BY recipient_key`, [id]);
  const row = async (id: string) => (await q(`SELECT stripe_transfer_id, settled_at FROM appointments WHERE id = $1`, [id]))[0];

  try {
    console.log('\n1. Balance has money: same transfer as before, nothing queued');
    balanceCents = 100000;
    const a1 = await appt(`pi_po1_${S}`, 5400);
    await settleAppointmentBooking(a1);
    let t = transfers.filter(x => x.metadata.appointmentId === a1);
    assert(t.length === 1 && t[0].amount === 4900 && !t[0].source_transaction && t[0].metadata.recipient === 'business', 'one $49.00 transfer from the balance (98% of $50)', t);
    assert((await row(a1)).stripe_transfer_id === t[0].id && (await issues(a1)).length === 0, 'transfer saved on the booking, no issue');

    console.log('\n2. Balance empty: base pay goes out from the customer\'s own charge');
    balanceCents = 0;
    const a2 = await appt(`pi_po2_${S}`, 5400);
    await settleAppointmentBooking(a2);
    t = transfers.filter(x => x.metadata.appointmentId === a2);
    assert(t.length === 1 && t[0].amount === 4900 && t[0].source_transaction === `ch_pi_po2_${S}`, '$49.00 sent tied to the customer charge (Stripe pays it when the charge clears)', t);
    assert((await row(a2)).stripe_transfer_id === t[0].id && (await issues(a2)).length === 0, 'booking shows it paid, nothing waiting');

    console.log('\n3. Balance empty and a $10 points code: charge covers $44, Outsyde owes the rest');
    const a3 = await appt(`pi_po3_${S}`, 4400);
    await settleAppointmentBooking(a3);
    t = transfers.filter(x => x.metadata.appointmentId === a3);
    let iss = await issues(a3);
    assert(t.length === 1 && t[0].amount === 4400 && t[0].source_transaction, '$44.00 sent from the customer charge', t);
    assert(iss.length === 1 && iss[0].recipient_key === 'business_rewards' && iss[0].amount_cents === 500 && iss[0].status === 'open',
      'the $5.00 Outsyde adds is queued (business still gets $49.00 in total)', iss);

    console.log('\n4. Another Stripe error: whole payout queued');
    failAccounts = new Set([acct]);
    balanceCents = 100000;
    const a4 = await appt(`pi_po4_${S}`, 5400);
    await settleAppointmentBooking(a4);
    iss = await issues(a4);
    assert(iss.length === 1 && iss[0].recipient_key === 'business' && iss[0].amount_cents === 4900 && /account_invalid/.test(iss[0].last_error), 'base payout queued with the error', iss);
    assert(!(await row(a4)).stripe_transfer_id && (await row(a4)).settled_at, 'booking settled, no transfer yet');

    console.log('\n5. Hourly retry pays what it can');
    failAccounts = new Set();
    balanceCents = 100000;
    // A cancelled booking with an open issue is not paid.
    const a5 = await appt(`pi_po5_${S}`, 5400);
    await q(`INSERT INTO booking_payout_issues (reference_type, reference_id, recipient_key, is_base, connected_account_id, amount_cents) VALUES ('appointment', $1, 'business', true, $2, 4900)`, [a5, acct]);
    await q(`UPDATE appointments SET status = 'canceled' WHERE id = $1`, [a5]);
    const r = await payouts.retryOpenPayouts();
    const rewardsT = transfers.find(x => x.metadata.appointmentId === a3 && x.metadata.recipient === 'business_rewards');
    assert(rewardsT?.amount === 500 && !rewardsT.source_transaction, 'rewards part $5.00 paid from the balance', rewardsT);
    const baseT = transfers.find(x => x.metadata.appointmentId === a4 && x.metadata.recipient === 'business');
    assert(baseT?.amount === 4900 && (await row(a4)).stripe_transfer_id === baseT.id, 'queued base payout paid and saved on the booking', baseT);
    assert((await issues(a3))[0].status === 'paid' && (await issues(a4))[0].status === 'paid', 'issues marked paid');
    assert((await issues(a5))[0].status === 'dropped' && !transfers.some(x => x.metadata.appointmentId === a5), 'cancelled booking: not paid (dropped)');
    assert(r.paid >= 2 && r.dropped >= 1, 'retry counts', r);

    console.log('\n6. Retrying again pays nothing twice');
    const before = transfers.length;
    await payouts.retryOpenPayouts();
    await settleAppointmentBooking(a4);
    assert(transfers.length === before, 'no duplicate transfers', { before, after: transfers.length });

    console.log('\n7. Alerts: right away for a new issue, then at most once a day');
    failAccounts = new Set([acct]);
    const a6 = await appt(`pi_po6_${S}`, 5400);
    await settleAppointmentBooking(a6); // tries to email (no RESEND key locally: logs and moves on)
    await q(`UPDATE booking_payout_issues SET alerted_at = now() WHERE reference_id = $1`, [a6]);
    let due = await payouts.sendPayoutAlertIfDue().catch(() => 'threw');
    assert(due === false, 'no second alert within 24 hours', due);
    await q(`UPDATE booking_payout_issues SET alerted_at = now() - interval '25 hours' WHERE reference_id = $1`, [a6]);
    due = await payouts.sendPayoutAlertIfDue().catch((e: any) => /RESEND_API_KEY/.test(e?.message) ? 'would-send' : 'threw');
    assert(due === 'would-send', 'alert due again after a day (email send attempted)', due);

    console.log('\n8. Optional top up (off by default, capped)');
    balanceCents = 0;
    delete process.env.OUTSYDE_AUTO_TOPUP_MAX_CENTS;
    topups = [];
    await payouts.retryOpenPayouts().catch(() => {});
    assert(topups.length === 0, 'no top up when the setting is off');
    process.env.OUTSYDE_AUTO_TOPUP_MAX_CENTS = '3000';
    await payouts.retryOpenPayouts().catch(() => {});
    assert(topups.length === 1 && topups[0].amount === 3000, 'top up requested for the shortfall, capped at $30.00', topups);
    await payouts.retryOpenPayouts().catch(() => {});
    assert(topups.length === 1, 'not again within 3 days');
    delete process.env.OUTSYDE_AUTO_TOPUP_MAX_CENTS;

    console.log('\n9. Photographer booking: same fallback');
    failAccounts = new Set();
    balanceCents = 0;
    const phUser = await user();
    const phId = crypto.randomUUID();
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'PO Photo', 1000, $3, true)`, [phId, phUser, `acct_ph_${S}`]);
    ids.photogs.push(phId);
    const sb = crypto.randomUUID();
    const piS = `pi_pos_${S}`;
    pis[piS] = { amount: 5400, refunded: 0 };
    await q(`INSERT INTO shoot_bookings (id, photographer_id, client_id, shoot_type, date, start_time, end_time, duration_hours, total_price, platform_fee, vendor_net, status, stripe_payment_intent_id)
             VALUES ($1, $2, $3, 'Portrait', '2030-02-01', '10:00', '11:00', 1, 5000, 100, 4900, 'confirmed', $4)`, [sb, phId, client, piS]);
    ids.shoots.push(sb);
    await settleShootBooking(sb, { amount: 5400, metadata: {} });
    const st = transfers.filter(x => x.metadata.bookingId === sb);
    assert(st.length === 1 && st[0].amount === 4900 && st[0].source_transaction === `ch_${piS}` && st[0].metadata.recipient === 'photographer', 'photographer paid $49.00 from the customer charge', st);
  } finally {
    const all = [...ids.appts, ...ids.shoots];
    await q(`DELETE FROM booking_payout_issues WHERE reference_id = ANY($1::varchar[])`, [all]).catch(() => {});
    await q(`DELETE FROM pending_points_transactions WHERE reference_id = ANY($1::varchar[])`, [all]).catch(() => {});
    await q(`DELETE FROM appointments WHERE id = ANY($1::varchar[])`, [ids.appts]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE id = ANY($1::varchar[])`, [ids.shoots]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id = ANY($1::varchar[])`, [ids.photogs]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1::varchar[])`, [ids.biz]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [ids.users]).catch(() => {});
    await pool.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
