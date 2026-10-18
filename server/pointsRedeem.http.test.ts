/**
 * Points redemption at checkout (bookings + products) — HTTP + webhook integration tests
 *
 * Run with: npx tsx server/pointsRedeem.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migrations 048 + 050 applied) with a Stripe stub. Environment variables:
 *
 *   PR_TEST_BASE_URL      e.g. http://localhost:5062   (must be localhost)
 *   PR_TEST_PG_URL        the SAME scratch database (localhost only)
 *   PR_TEST_STRIPE_PORT   port for the Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *   DATABASE_URL          the same local database, and run this file with the same NODE_OPTIONS and
 *   STRIPE_STUB_PORT      (the webhook handlers are called in this process)
 *
 * Skips (exit 0) when PR_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Rules checked (decided 2026-10-17; booking 10x rule 2026-10-18):
 *   - bookings: what is paid online now (before the fee) must be at least 10x the code
 *   - the business payout never changes; points are earned on the full amount
 *   - one checkout holds a code at a time; an unpaid older checkout is cancelled and loses it;
 *     a paid / processing / awaiting-acceptance checkout keeps it
 *   - the code is used when the payment succeeds, given back when the payment is cancelled
 *     and when the purchase is cancelled with a full refund
 *   - refunds are never larger than what the customer was charged
 */
import http from 'http';
import crypto from 'crypto';

const BASE = process.env.PR_TEST_BASE_URL;
const PG_URL = process.env.PR_TEST_PG_URL;
const STUB_PORT = Number(process.env.PR_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u?: string) => !!u && ['localhost', '127.0.0.1'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.98.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log('⏭  skipped: set PR_TEST_BASE_URL (+ PR_TEST_PG_URL, PR_TEST_STRIPE_PORT)'); process.exit(0); }
  if (!isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error('refusing to run: base URL and database must both be local, stub port required');

  const { generateAccessToken } = await import('./auth');
  const { WebhookHandlers } = await import('./stripe/webhookHandlers');
  const { transitionAppointmentState } = await import('./bookingStateMachine');
  const ledger = await import('./loyaltyLedger');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub ───────────────────────────────────────────────────────
  const pis: Record<string, any> = {};
  const idemKeys: Record<string, string> = {};
  const refunds: any[] = [];
  const transfers: any[] = [];
  let seq = 0;
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const url = (req.url || '').split('?')[0];
      const meta = (into: Record<string, string>) => {
        for (const [k, v] of form.entries()) {
          if (k.startsWith('metadata[') && k.endsWith(']')) {
            const key = k.slice(9, -1);
            if (v === '') delete into[key]; else into[key] = v;
          }
        }
        return into;
      };
      const view = (pi: any) => ({
        ...pi,
        amount_received: ['succeeded'].includes(pi.status) ? pi.amount : 0,
        latest_charge: { id: `ch_${pi.id}`, amount_refunded: pi.refunded || 0, transfer: `tr_${pi.id}` },
      });
      if (req.method === 'POST' && url === '/v1/customers') return send(200, { id: `cus_stub_${++seq}`, object: 'customer' });
      if (req.method === 'GET' && url.startsWith('/v1/customers/')) return send(200, { id: url.split('/')[3], object: 'customer' });
      if (req.method === 'POST' && url === '/v1/payment_intents') {
        // Same idempotency key = Stripe returns the PaymentIntent it already made (in its current state).
        const idem = String(req.headers['idempotency-key'] || '');
        if (idem && idemKeys[idem]) return send(200, view(pis[idemKeys[idem]]));
        const pi = {
          id: `pi_stub_${Date.now()}_${++seq}`, object: 'payment_intent', status: 'requires_payment_method',
          amount: Number(form.get('amount') || 0), capture_method: form.get('capture_method') || 'automatic',
          transfer: Number(form.get('transfer_data[amount]') || 0),
          client_secret: `secret_${seq}`, metadata: meta({}),
        };
        pis[pi.id] = pi;
        if (idem) idemKeys[idem] = pi.id;
        return send(200, view(pi));
      }
      let m = url.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && m) {
        const pi = pis[m[1]];
        if (!pi) return send(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no pi' } });
        if (!['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture'].includes(pi.status)) {
          return send(400, { error: { type: 'invalid_request_error', message: `cannot cancel ${pi.status}` } });
        }
        pi.status = 'canceled';
        return send(200, view(pi));
      }
      m = url.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const pi = pis[m[1]];
        return pi ? send(200, view(pi)) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no pi' } });
      }
      if (m && req.method === 'POST') {
        const pi = pis[m[1]];
        if (!pi) return send(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no pi' } });
        if (form.get('amount')) pi.amount = Number(form.get('amount'));
        meta(pi.metadata);
        return send(200, view(pi));
      }
      if (req.method === 'POST' && url === '/v1/refunds') {
        const pi = pis[form.get('payment_intent') || ''];
        const amount = form.get('amount') ? Number(form.get('amount')) : (pi ? pi.amount - (pi.refunded || 0) : 0);
        if (pi && amount > pi.amount - (pi.refunded || 0)) return send(400, { error: { type: 'invalid_request_error', message: 'Refund amount is greater than charge' } });
        if (pi) pi.refunded = (pi.refunded || 0) + amount;
        const r = { id: `re_${++seq}`, object: 'refund', amount, payment_intent: pi?.id };
        refunds.push(r);
        return send(200, r);
      }
      if (req.method === 'GET' && url === '/v1/transfers') return send(200, { object: 'list', data: [] });
      if (req.method === 'POST' && url === '/v1/transfers') {
        const t = { id: `tr_${++seq}`, object: 'transfer', amount: Number(form.get('amount')), destination: form.get('destination'), metadata: meta({}) };
        transfers.push(t);
        return send(200, t);
      }
      if (req.method === 'POST' && /^\/v1\/transfers\/[^/]+\/reversals$/.test(url)) return send(200, { id: `trr_${++seq}`, amount: Number(form.get('amount')) });
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ──────────────────────────────────────────────────────────────
  const P = `pr${Date.now().toString(36)}`;
  const users: string[] = [];
  const mkUser = async (name: string, points = 0) => {
    const id = crypto.randomUUID();
    await q(`INSERT INTO users (id, username, email, loyalty_points, is_active) VALUES ($1, $2, $3, $4, true)`, [id, `${P}${name}`, `${P}-${name}@x.test`, points]);
    users.push(id);
    return id;
  };
  const owner = await mkUser('owner');
  const bizId = crypto.randomUUID();
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'PR Biz', 'beauty', 'approved', 'acct_prbiz', true)`, [bizId, owner]);
  const svcFull = crypto.randomUUID();     // $50, no deposit
  const svcDeposit = crypto.randomUUID();  // $300 service, $30 deposit
  const svcTiny = crypto.randomUUID();     // $5 service, no deposit
  const svcBigDep = crypto.randomUUID();   // $1,000 service, $100 deposit
  const svcHundred = crypto.randomUUID();  // $100, no deposit
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, deposit_amount_cents, is_active, status) VALUES
    ($1, $4, 'Full', 5000, 60, NULL, true, 'live'), ($2, $4, 'Deposit', 30000, 60, 3000, true, 'live'), ($3, $4, 'Tiny', 500, 30, NULL, true, 'live'),
    ($5, $4, 'BigDep', 100000, 60, 10000, true, 'live'), ($6, $4, 'Hundred', 10000, 60, NULL, true, 'live')`,
    [svcFull, svcDeposit, svcTiny, bizId, svcBigDep, svcHundred]);

  const customer = await mkUser('cust', 30000);
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false });
  const ownerToken = generateAccessToken({ userId: owner, isVendor: true, isAdmin: false });

  const holds: string[] = [];
  let slot = 0;
  const mkHold = async (serviceId: string, priceCents: number, providerType = 'business', providerId = bizId) => {
    const id = crypto.randomUUID();
    const day = new Date(Date.now() + (5 + slot) * 86400000).toISOString().slice(0, 10);
    slot++;
    await q(`INSERT INTO booking_holds (id, provider_type, provider_id, user_id, service_id, service_name, service_price_cents, duration_minutes,
              hold_date, start_time, end_time, start_at, end_at, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'Svc', $6, 60, $7, '10:00', '11:00', $8::timestamp, $9::timestamp, 'active', now() + interval '1 hour')`,
      [id, providerType, providerId, customer, serviceId, priceCents, day, `${day} 10:00`, `${day} 11:00`]);
    holds.push(id);
    return id;
  };
  const redeem = async (points: number) => {
    const r = await call('POST', '/api/points/redeem', { token, body: { pointsToRedeem: points } });
    return r;
  };
  const code = (id: string) => q(`SELECT status, used_on_reference_type AS t, used_on_order_id AS ref, expires_at FROM promo_codes WHERE id=$1`, [id]).then(r => r[0]);

  try {
    // ── 1. Redeem returns the code id ─────────────────────────────────────
    console.log('\n── 1. redeem returns codeId ──');
    let r = await redeem(2500);
    assert(r.status === 200 && typeof r.body?.codeId === 'string' && r.body?.discountCents === 500, '$5 code: 200 with codeId', r);
    const code5 = r.body?.codeId as string;
    r = await redeem(5000);
    const code10 = r.body?.codeId as string;
    assert(!!code10, '$10 code created', r);

    r = await call('GET', '/api/points/balance', { token });
    assert(r.body?.activeCodes?.some((c: any) => c.id === code5 && c.minimumOrderCents === 5000), 'balance lists the code with its id', r.body?.activeCodes);
    r = await call('GET', '/api/consumer/points', { token });
    assert(r.status === 200 && Array.isArray(r.body?.transactions) && typeof r.body?.balance === 'number' && r.body?.activeCodes?.length === 2,
      '/api/consumer/points: balance + codes + history', r.body && { balance: r.body.balance, codes: r.body.activeCodes?.length });

    // ── 2. Booking rule: 10x of what is paid online now, before the fee ───
    console.log('\n── 2. booking rule (10x of what is paid online: $50 takes $5; a $30 deposit takes none) ──');
    const code5Text = (await q(`SELECT code FROM promo_codes WHERE id=$1`, [code5]))[0].code;
    r = await call('POST', '/api/points/validate-code', { token, body: { code: code5Text, bookingDueNowCents: 5400 } });
    assert(r.status === 200 && r.body?.amountChargedNowCents === 4900 && r.body?.maxDiscountCents === 500, 'validate-code: $54 due now with $5 → $49', r.body);
    r = await call('POST', '/api/points/validate-code', { token, body: { code: code5Text, bookingDueNowCents: 3240 } });
    assert(r.status === 400 && r.body?.code === 'PROMO_TOO_LARGE' && r.body?.minimumOrderCents === 5000 && r.body?.maxDiscountCents === 300, 'validate-code: $30 deposit refuses a $5 code', r.body);

    const tinyHold = await mkHold(svcTiny, 500);
    r = await call('POST', `/api/booking/${tinyHold}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    assert(r.status === 400 && r.body?.code === 'PROMO_TOO_LARGE' && r.body?.maxDiscountCents === 50 && r.body?.minimumOrderCents === 5000, '$5 booking: a $5 code is refused (needs $50 online)', r.body);
    assert(typeof r.body?.error === 'string' && !/[\u2013\u2014]/.test(r.body.error) && !r.body.error.includes('8%'), 'refusal text: no dashes, no fee percentage', r.body?.error);
    assert((await q(`SELECT count(*)::int n FROM appointments WHERE hold_id=$1`, [tinyHold]))[0].n === 0, 'refused before any appointment was written');
    assert((await code(code5)).status === 'active', 'code still active after the refusal');

    // $300 service with a $30 deposit: the full price would qualify, but only $30 is paid online.
    const smallDepHold = await mkHold(svcDeposit, 30000);
    r = await call('POST', `/api/booking/${smallDepHold}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    assert(r.status === 400 && r.body?.code === 'PROMO_TOO_LARGE' && r.body?.minimumOrderCents === 5000, '$30 deposit on a $300 service: $5 code refused (10x of what is paid online)', r.body);
    assert((await q(`SELECT count(*)::int n FROM appointments WHERE hold_id=$1`, [smallDepHold]))[0].n === 0, 'refused before any appointment was written');
    r = await call('POST', `/api/booking/${smallDepHold}/create-payment-intent`, { token, body: { promoCodeId: null } });
    assert(r.status === 200 && pis[r.body?.paymentIntentId]?.amount === 3240, 'same deposit booking without a code: $32.40, unchanged', { s: r.status, b: r.body });

    const depHold = await mkHold(svcBigDep, 100000);
    r = await call('POST', `/api/booking/${depHold}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    assert(r.status === 200, '$100 deposit booking with $5 code → 200', r.body);
    const depAppt = r.body?.appointmentId as string;
    const depPi = pis[r.body?.paymentIntentId];
    assert(depPi?.amount === 10300, 'charged now = $108 - $5 = $103 (Stripe amount 10300)', depPi?.amount);
    assert(depPi?.metadata?.promoCodeId === code5 && depPi?.metadata?.discountCents === '500' && depPi?.metadata?.originalConsumerTotalCents === '10800', 'PaymentIntent metadata carries the code', depPi?.metadata);
    assert(r.body?.discountCents === 500 && r.body?.amountChargedNowCents === 10300 && r.body?.feeBreakdown?.grossChargeAmount === 10800,
      'response: discountCents 500, amountChargedNowCents 10300, existing fields unchanged', { d: r.body?.discountCents, a: r.body?.amountChargedNowCents, g: r.body?.feeBreakdown?.grossChargeAmount });
    let c = await code(code5);
    assert(c.status === 'reserved' && c.t === 'appointment' && c.ref === depAppt, 'code held by this appointment', c);
    const [depRow] = await q(`SELECT promo_code_used, discount_amount_cents, vendor_net FROM appointments WHERE id=$1`, [depAppt]);
    assert(depRow.discount_amount_cents === 500 && depRow.vendor_net === 9800, 'appointment row: discount 500, vendor net 9800 unchanged (10000 x 98%)', depRow);

    // ── 3. Change / remove the code on the same unpaid PaymentIntent ──────
    console.log('\n── 3. change and remove the code before paying ──');
    r = await call('POST', `/api/booking/${depHold}/create-payment-intent`, { token, body: { promoCodeId: null } });
    assert(r.status === 200 && r.body?.paymentIntentId === depPi.id && pis[depPi.id].amount === 10800 && r.body?.discountCents === 0, 'code removed (promoCodeId: null): same PaymentIntent back to $108', { s: r.status, amt: pis[depPi.id].amount, d: r.body?.discountCents });
    assert(!pis[depPi.id].metadata.promoCodeId, 'PaymentIntent metadata no longer carries a code', pis[depPi.id].metadata);
    assert((await code(code5)).status === 'active', 'code given back (active)');
    r = await call('POST', `/api/booking/${depHold}/create-payment-intent`, { token, body: { promoCodeId: code10 } });
    assert(r.status === 200 && pis[depPi.id].amount === 9800 && pis[depPi.id].metadata.promoCodeId === code10, '$10 code: same PaymentIntent now $98', { s: r.status, amt: pis[depPi.id].amount });
    assert((await code(code10)).status === 'reserved', '$10 code held');

    // ── 4. One checkout at a time ─────────────────────────────────────────
    console.log('\n── 4. takeover rules ──');
    const fullHold = await mkHold(svcHundred, 10000);
    r = await call('POST', `/api/booking/${fullHold}/create-payment-intent`, { token, body: { promoCodeId: code10 } });
    assert(r.status === 200 && pis[r.body?.paymentIntentId]?.amount === 9800, 'second booking takes the $10 code: $108 - $10 = $98', { s: r.status, b: r.body });
    const fullAppt = r.body?.appointmentId as string;
    const fullPiId = r.body?.paymentIntentId as string;
    assert(pis[depPi.id].status === 'canceled', 'the older unpaid checkout was cancelled', pis[depPi.id].status);
    c = await code(code10);
    assert(c.status === 'reserved' && c.ref === fullAppt, 'code now held by the newer booking', c);

    // A paid (or processing) checkout keeps its code.
    pis[fullPiId].status = 'processing';
    const fullHold2 = await mkHold(svcHundred, 10000);
    r = await call('POST', `/api/booking/${fullHold2}/create-payment-intent`, { token, body: { promoCodeId: code10 } });
    assert(r.status === 409 && r.body?.code === 'PROMO_IN_USE', 'a processing checkout keeps the code: 409 PROMO_IN_USE', r.body);
    c = await code(code10);
    assert(c.status === 'reserved' && c.ref === fullAppt, 'hold stays with the processing checkout', c);
    const apptFull2 = (await q(`SELECT id, promo_code_used, discount_amount_cents FROM appointments WHERE hold_id=$1`, [fullHold2]))[0];
    assert(apptFull2 && !apptFull2.promo_code_used && apptFull2.discount_amount_cents === 0, 'refused booking kept without a code (retry resumes it)', apptFull2);
    r = await call('POST', `/api/booking/${fullHold2}/create-payment-intent`, { token, body: {} });
    assert(r.status === 200 && pis[r.body?.paymentIntentId]?.amount === 10800, 'retry without a code resumes the booking at full price', { s: r.status, b: r.body });

    // ── 5. Payment succeeds: code used, payout unchanged, points on full amount ──
    console.log('\n── 5. payment succeeded ──');
    pis[fullPiId].status = 'succeeded';
    await WebhookHandlers.handlePaymentIntentSucceeded(pis[fullPiId]);
    c = await code(code10);
    assert(c.status === 'used' && c.ref === fullAppt, 'code used on the paid booking', c);
    const [paidRow] = await q(`SELECT status, promo_code_used, discount_amount_cents, points_redeemed FROM appointments WHERE id=$1`, [fullAppt]);
    assert(paidRow.status === 'confirmed' && paidRow.discount_amount_cents === 1000 && paidRow.points_redeemed === 5000, 'appointment confirmed with discount 1000, points_redeemed 5000', paidRow);
    const tr = transfers.find(t => t.metadata?.appointmentId === fullAppt);
    assert(tr?.amount === 9800, 'business transfer = $98.00 (10000 x 98%), unchanged by the code', tr);
    const [pend] = await q(`SELECT points_earned AS points FROM pending_points_transactions WHERE reference_type='appointment' AND reference_id=$1`, [fullAppt]);
    assert(pend?.points === 2000 && ledger.pointsForGrossCents(10800) === 2000, 'pending points on the full $108: 2,000 (4% of $100)', pend);
    await WebhookHandlers.handlePaymentIntentSucceeded(pis[fullPiId]);
    assert((await code(code10)).status === 'used', 'repeated webhook is a no-op');

    // Vendor + admin views
    r = await call('GET', '/api/business/bookings', { token: ownerToken });
    const vb = r.body?.bookings?.find((b: any) => b.id === fullAppt);
    assert(vb?.discountAmountCents === 1000 && vb?.customerPaidNowCents === 9800 && vb?.vendorNetAmount === 98, 'vendor bookings: discount 1000, customer paid 9800, payout 98.00', vb && { d: vb.discountAmountCents, p: vb.customerPaidNowCents, n: vb.vendorNetAmount });

    // ── 6. Payment cancelled: code given back ─────────────────────────────
    console.log('\n── 6. payment cancelled ──');
    const h6 = await mkHold(svcFull, 5000);
    r = await call('POST', `/api/booking/${h6}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    assert(r.status === 200 && (await code(code5)).status === 'reserved', '$5 code held by a new booking', r.status);
    const pi6 = pis[r.body?.paymentIntentId];
    pi6.status = 'canceled';
    await WebhookHandlers.handlePaymentIntentCanceled(pi6);
    assert((await code(code5)).status === 'active', 'cancelled payment gives the code back');

    // ── 7. Full refund gives the code back; partial does not ──────────────
    console.log('\n── 7. refunds ──');
    const before = Date.now();
    await q(`UPDATE promo_codes SET status='used', used_on_reference_type='order', used_on_order_id='ord-x', expires_at = now() + interval '2 days' WHERE id=$1`, [code5]);
    const given = await ledger.restorePromoForReference({ type: 'order', id: 'ord-x' });
    c = await code(code5);
    assert(given.length === 1 && c.status === 'active' && !c.ref && new Date(c.expires_at + 'Z').getTime() >= before + 29 * 86400000,
      'restore: active again with at least 30 days left', c);
    assert((await ledger.restorePromoForReference({ type: 'order', id: 'ord-x' })).length === 0, 'restore twice: nothing more');

    // Product order with the $5 code, then the business cancels it: refund capped at the charge, code back.
    const cartItem = { isExternalProduct: true, vendorId: bizId, priceCents: 5000, quantity: 1, name: 'Oil' };
    const addr = { line1: '1 Test St', city: 'Freeport', state: 'NY', zipCode: '11520' };
    r = await call('POST', '/api/cart/payment-intent', { token, body: { items: [cartItem], shippingAddress: addr, promoCodeId: code5 } });
    assert(r.status === 200 && r.body?.feeBreakdown?.discountCents === 500 && r.body?.feeBreakdown?.amountChargedCents === 4900, 'cart: $54 - $5 = $49 (response shows discount + charge)', r.body);
    const orderId = r.body?.orderId as string;
    const orderPiId = r.body?.paymentIntentId as string;
    c = await code(code5);
    assert(c.status === 'reserved' && c.t === 'order' && c.ref === orderId, 'code held by the order', c);

    // Second cart with the same code takes it over (older unpaid checkout cancelled).
    r = await call('POST', '/api/cart/payment-intent', { token, body: { items: [cartItem], shippingAddress: addr, promoCodeId: code5 } });
    assert(r.status === 200 && pis[orderPiId].status === 'canceled', 'second cart takes the code; first PaymentIntent cancelled', { s: r.status, st: pis[orderPiId].status });
    const order2 = r.body?.orderId as string;
    const order2Pi = r.body?.paymentIntentId as string;
    pis[order2Pi].status = 'succeeded';
    await WebhookHandlers.handlePaymentIntentSucceeded(pis[order2Pi]);
    c = await code(code5);
    assert(c.status === 'used' && c.ref === order2, 'code used on the paid order', c);

    r = await call('PATCH', `/api/business/orders/${order2}`, { token: ownerToken, body: { status: 'cancelled' } });
    const ref2 = refunds.find(x => x.payment_intent === order2Pi);
    assert(r.status === 200 && ref2?.amount === 4900, 'business cancel: refund capped at $49 charged (was asking $50 base, Stripe would refuse)', { s: r.status, b: r.body, ref2 });
    c = await code(code5);
    assert(c.status === 'active', 'cancelled order gives the code back', c);


    // ── 9. Review fixes ───────────────────────────────────────────────────
    console.log('\n── 9. retries, late events, ended bookings ──');
    // a) A retry that leaves out promoCodeId keeps the code (does not raise the price).
    const h9 = await mkHold(svcFull, 5000);
    r = await call('POST', `/api/booking/${h9}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    const appt9 = r.body?.appointmentId as string;
    const pi9 = r.body?.paymentIntentId as string;
    assert(r.status === 200 && pis[pi9].amount === 4900, 'booking with $5 code: $49', r.body);
    r = await call('POST', `/api/booking/${h9}/create-payment-intent`, { token, body: {} });
    assert(r.status === 200 && pis[pi9].amount === 4900 && r.body?.discountCents === 500, 'retry without the field keeps the code ($49 still)', { amt: pis[pi9].amount, d: r.body?.discountCents });
    r = await call('POST', `/api/booking/${h9}/create-payment-intent`, { token, body: { promoCodeId: null } });
    assert(r.status === 200 && pis[pi9].amount === 5400 && (await code(code5)).status === 'active', 'promoCodeId: null removes it ($54, code back)', { amt: pis[pi9].amount });
    r = await call('POST', `/api/booking/${h9}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    assert(r.status === 200 && pis[pi9].amount === 4900, 'code added back: $49', pis[pi9].amount);

    // b) After losing its PaymentIntent (code taken), a retry with the same code gets a fresh,
    //    payable PaymentIntent, not the cancelled one Stripe has under the same key.
    pis[pi9].status = 'canceled';
    await q(`UPDATE appointments SET stripe_payment_intent_id = NULL WHERE id = $1`, [appt9]);
    // The key the first PaymentIntent for this code used:
    idemKeys[`hold_pi_${appt9}_promo_${code5}`] = pi9;
    r = await call('POST', `/api/booking/${h9}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    const pi9b = r.body?.paymentIntentId as string;
    assert(r.status === 200 && pi9b && pi9b !== pi9 && pis[pi9b]?.status === 'requires_payment_method' && pis[pi9b]?.amount === 4900,
      'retry after a lost code: new payable PaymentIntent at $49', { s: r.status, pi9b, st: pis[pi9b]?.status });

    // c) A late cancel event for the old PaymentIntent does not free the code the booking now holds.
    await WebhookHandlers.handlePaymentIntentCanceled(pis[pi9]);
    c = await code(code5);
    assert(c.status === 'reserved' && c.ref === appt9, 'late cancel of the replaced PaymentIntent leaves the hold alone', c);

    // d) A booking that ends unpaid gives the code back only after its PaymentIntent is cancelled.
    const t = await transitionAppointmentState(appt9, 'canceled' as any, { triggeredBy: customer, triggerSource: 'api' });
    assert(t.success, 'pending booking cancelled', t);
    assert(pis[pi9b].status === 'canceled', 'its unpaid PaymentIntent was cancelled (cannot be paid with the code later)', pis[pi9b].status);
    assert((await code(code5)).status === 'active', 'code given back');

    // e) A booking that ends while its payment is processing keeps the code.
    const h9e = await mkHold(svcFull, 5000);
    r = await call('POST', `/api/booking/${h9e}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    const appt9e = r.body?.appointmentId as string;
    pis[r.body?.paymentIntentId].status = 'processing';
    await transitionAppointmentState(appt9e, 'canceled' as any, { triggeredBy: customer, triggerSource: 'api' });
    c = await code(code5);
    assert(c.status === 'reserved' && c.ref === appt9e, 'processing payment keeps its code when the booking ends', c);
    await q(`UPDATE promo_codes SET status='active', used_on_reference_type=NULL, used_on_order_id=NULL WHERE id=$1`, [code5]);

    // ── 10. Photographer booking ──────────────────────────────────────────
    console.log('\n── 10. photographer booking ──');
    const photogUser = await mkUser('photog');
    const photogId = crypto.randomUUID();
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, stripe_account_id, stripe_onboarding_complete, auto_accept_bookings) VALUES ($1, $2, 'PR Photo', 10000, 'acct_prph', true, true)`, [photogId, photogUser]);
    const pSvc = crypto.randomUUID();
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, deposit_amount_cents, is_active, status) VALUES ($1, $2, 'Portrait', 20000, 5000, true, 'live')`, [pSvc, photogId]);
    const ph = await mkHold(pSvc, 20000, 'photographer', photogId);
    r = await call('POST', `/api/booking/${ph}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    const shootId = r.body?.shootBookingId as string;
    const shootPi = r.body?.paymentIntentId as string;
    assert(r.status === 200 && r.body?.dueNowCents === 5400 && pis[shootPi]?.amount === 4900 && r.body?.discountCents === 500,
      '$50 deposit shoot: $54 due, $49 with the $5 code', { s: r.status, due: r.body?.dueNowCents, amt: pis[shootPi]?.amount, b: r.body?.error });
    assert(pis[shootPi]?.metadata?.vendorPayoutCents === '4900' && pis[shootPi]?.metadata?.originalConsumerTotalCents === '5400',
      'photographer payout 4900 (5000 x 98%) unchanged; points on $54', pis[shootPi]?.metadata);
    r = await call('POST', `/api/booking/${ph}/create-payment-intent`, { token, body: { promoCodeId: null } });
    assert(r.status === 200 && pis[shootPi].amount === 5400 && (await code(code5)).status === 'active', 'shoot: code removed on the same PaymentIntent', { amt: pis[shootPi].amount });
    r = await call('POST', `/api/booking/${ph}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    pis[shootPi].status = 'succeeded';
    await WebhookHandlers.handlePaymentIntentSucceeded(pis[shootPi]);
    c = await code(code5);
    const [shootRow] = await q(`SELECT status, discount_amount_cents, points_redeemed FROM shoot_bookings WHERE id=$1`, [shootId]);
    assert(c.status === 'used' && c.ref === shootId && shootRow.status === 'confirmed' && shootRow.discount_amount_cents === 500 && shootRow.points_redeemed === 2500,
      'shoot paid: code used, booking confirmed with the discount', { c, shootRow });
    const shootTr = transfers.find(x => x.metadata?.bookingId === shootId);
    assert(shootTr?.amount === 4900, 'photographer transfer $49.00 unchanged by the code', shootTr);
    await q(`UPDATE promo_codes SET status='active', used_on_reference_type=NULL, used_on_order_id=NULL WHERE id=$1`, [code5]);
    // Photographer refusal: a $30 deposit shoot takes no $5 code.
    const pSvc2 = crypto.randomUUID();
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, deposit_amount_cents, is_active, status) VALUES ($1, $2, 'Mini', 30000, 3000, true, 'live')`, [pSvc2, photogId]);
    const ph2 = await mkHold(pSvc2, 30000, 'photographer', photogId);
    r = await call('POST', `/api/booking/${ph2}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    assert(r.status === 400 && r.body?.code === 'PROMO_TOO_LARGE' && r.body?.minimumOrderCents === 5000, 'shoot with a $30 deposit: $5 code refused', r.body);
    assert((await q(`SELECT count(*)::int n FROM shoot_bookings WHERE photographer_id=$1 AND service_id=$2`, [photogId, pSvc2]))[0].n === 0, 'refused before any shoot booking was written');
    await q(`DELETE FROM photographer_services WHERE id=$1`, [pSvc2]).catch(() => {});

    // ── 11. Staff booking ─────────────────────────────────────────────────
    console.log('\n── 11. staff booking ──');
    const staffId = crypto.randomUUID();
    await q(`INSERT INTO staff_members (id, business_id, display_name, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'PR Staff', 'acct_prstaff', true)`, [staffId, bizId]);
    const mkStaffHold = async (priceCents: number) => {
      const staffSvc = crypto.randomUUID();
      await q(`INSERT INTO staff_services (id, staff_member_id, business_id, name, price_cents, duration_minutes) VALUES ($1, $2, $3, 'Staff Svc', $4, 60)`, [staffSvc, staffId, bizId, priceCents]);
      const h = await mkHold(staffSvc, priceCents);
      await q(`UPDATE booking_holds SET staff_member_id=$2 WHERE id=$1`, [h, staffId]);
      return h;
    };
    const sh1 = await mkStaffHold(4000);
    r = await call('POST', `/api/booking/${sh1}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    assert(r.status === 400 && r.body?.code === 'PROMO_TOO_LARGE', '$40 staff booking: $5 code refused (needs $50 online)', r.body);
    const sh2 = await mkStaffHold(6000);
    r = await call('POST', `/api/booking/${sh2}/create-payment-intent`, { token, body: { promoCodeId: code5 } });
    const staffAppt = r.body?.appointmentId as string;
    assert(r.status === 200 && pis[r.body?.paymentIntentId]?.amount === 5980 && r.body?.amountChargedNowCents === 5980, '$60 staff booking with $5 code: $64.80 - $5 = $59.80', { s: r.status, b: r.body });
    const [staffRow] = await q(`SELECT staff_member_id, discount_amount_cents, vendor_net FROM appointments WHERE id=$1`, [staffAppt]);
    assert(staffRow?.staff_member_id === staffId && staffRow?.discount_amount_cents === 500 && staffRow?.vendor_net === 5880, 'staff appointment: discount 500, payout 5880 unchanged (6000 x 98%)', staffRow);
    r = await call('POST', `/api/booking/${sh2}/create-payment-intent`, { token, body: { promoCodeId: null } });
    assert(r.status === 200 && (await code(code5)).status === 'active', 'staff booking: code removed and given back', r.status);
    await q(`DELETE FROM booking_audit_log WHERE booking_id=$1`, [staffAppt]).catch(() => {});
    await q(`DELETE FROM appointments WHERE staff_member_id=$1`, [staffId]).catch(() => {});
    await q(`DELETE FROM staff_services WHERE staff_member_id=$1`, [staffId]).catch(() => {});
    await q(`DELETE FROM staff_members WHERE id=$1`, [staffId]).catch(() => {});

    await q(`DELETE FROM photographer_availability WHERE photographer_id=$1`, [photogId]).catch(() => {});
    await q(`DELETE FROM booking_audit_log WHERE booking_id=$1`, [shootId]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE photographer_id=$1`, [photogId]);
    await q(`DELETE FROM photographer_services WHERE id=$1`, [pSvc]);
    await q(`DELETE FROM photographers WHERE id=$1`, [photogId]);

    // ── 8. Admin stats ────────────────────────────────────────────────────
    console.log('\n── 8. admin rewards total ──');
    const totals = await ledger.rewardsRedeemedTotals();
    assert(totals.cents >= 1000 && totals.count >= 1, 'rewards redeemed total counts the used $10 code', totals);
  } finally {
    const apptIds = (await q(`SELECT id FROM appointments WHERE hold_id = ANY($1::varchar[])`, [holds])).map(r => r.id);
    await q(`DELETE FROM pending_points_transactions WHERE user_id = ANY($1::varchar[])`, [users]);
    await q(`DELETE FROM point_transactions WHERE user_id = ANY($1::varchar[])`, [users]);
    await q(`DELETE FROM promo_codes WHERE user_id = ANY($1::varchar[])`, [users]);
    await q(`DELETE FROM booking_audit_log WHERE booking_id = ANY($1::varchar[])`, [apptIds]).catch(() => {});
    await q(`DELETE FROM notifications WHERE user_id = ANY($1::varchar[])`, [users]).catch(() => {});
    await q(`DELETE FROM appointments WHERE hold_id = ANY($1::varchar[])`, [holds]);
    await q(`DELETE FROM booking_holds WHERE id = ANY($1::varchar[])`, [holds]);
    await q(`DELETE FROM orders WHERE customer_id = ANY($1::varchar[])`, [users]).catch(() => {});
    await q(`DELETE FROM vendor_services WHERE business_id = $1`, [bizId]);
    await q(`DELETE FROM businesses WHERE id = $1`, [bizId]).catch(e => console.log('cleanup business:', e.message));
    await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [users]).catch(e => console.log('cleanup users:', e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
