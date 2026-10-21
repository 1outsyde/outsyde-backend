/**
 * Provider refunds (business owner + photographer) — HTTP integration tests, 2026-10-21
 *
 * Run with: npx tsx server/providerRefund.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema)
 * with the Stripe stub preload:
 *
 *   PRF_TEST_BASE_URL     e.g. http://localhost:5072   (must be localhost)
 *   PRF_TEST_PG_URL       the SAME scratch database     (localhost only; seeds + cleans up its own rows)
 *   PRF_TEST_STRIPE_PORT  port for the Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *
 * Skips (exit 0) when PRF_TEST_BASE_URL is unset and refuses any non-local host.
 *
 * What it proves (POST /api/bookings/appointments/:id/refund and /api/bookings/photographer/:id/refund):
 *  - the app's legacy `amount` is dollars: $25 refunds 2500 cents (was 25), $25.50 refunds 2550 (was a Stripe error)
 *  - `amountCents` is cents and wins when both are sent
 *  - no amount on a business deposit booking refunds the deposit, not the whole charge (the service fee is kept)
 *  - more than the full refund, or an invalid amount, is refused with 400 before any Stripe call and leaves the booking as it was
 *  - the response carries refundedAmountCents; the row records refund_amount in cents
 *  - the owner check still applies (another user gets 403)
 */
import http from 'http';

const BASE = process.env.PRF_TEST_BASE_URL;
const PG_URL = process.env.PRF_TEST_PG_URL;
const STUB_PORT = Number(process.env.PRF_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.7.9' };
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
  if (!BASE) { console.log('⏭  skipped: set PRF_TEST_BASE_URL (+ PRF_TEST_PG_URL, PRF_TEST_STRIPE_PORT) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost and PRF_TEST_STRIPE_PORT set');
  }

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'prf-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub: PI reads (refund cap) + refunds. Each PI was charged `received` cents. ──
  const received: Record<string, number> = {};
  const refundCalls: Array<{ pi: string; amount: number }> = [];
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)/);
      if (req.method === 'GET' && piM) {
        const amt = received[piM[1]] ?? 0;
        return send(200, { id: piM[1], object: 'payment_intent', status: 'succeeded', amount: amt, amount_received: amt, latest_charge: { id: 'ch_stub', object: 'charge', amount_refunded: 0 } });
      }
      if (req.method === 'POST' && req.url === '/v1/refunds') {
        const amount = Number(form.get('amount') || 0);
        const pi = String(form.get('payment_intent') || '');
        if (!Number.isInteger(amount)) return send(400, { error: { type: 'invalid_request_error', message: 'Invalid integer' } });
        refundCalls.push({ pi, amount });
        return send(200, { id: `re_stub_${refundCalls.length}`, object: 'refund', status: 'succeeded', amount });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const P = `prf${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const vendorId = id('vendor');
  const otherId = id('other');
  const photogUserId = id('photog-user');
  const clientId = id('client');
  const bizId = id('biz');
  const photogId = id('photog');
  const apptIds: string[] = [];
  const shootIds: string[] = [];

  try {
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [vendorId, `${vendorId}@prf.test`]);
    await q(`INSERT INTO users (id, username, email) VALUES ($1::varchar, $1::text, $2)`, [otherId, `${otherId}@prf.test`]);
    await q(`INSERT INTO users (id, username, email, is_photographer) VALUES ($1::varchar, $1::text, $2, true)`, [photogUserId, `${photogUserId}@prf.test`]);
    await q(`INSERT INTO users (id, username, email, stripe_customer_id) VALUES ($1::varchar, $1::text, $2, 'cus_stub_prf')`, [clientId, `${clientId}@prf.test`]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'PRF Biz', 'beauty', 'approved')`, [bizId, vendorId]);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate) VALUES ($1, $2, 'PRF Photog', 10000)`, [photogId, photogUserId]);

    // Confirmed $100 appointments. charged = what the PaymentIntent took (price or deposit, + 8%).
    const appt = async (k: string, deposit: number | null) => {
      const charged = Math.round((deposit ?? 10000) * 1.08);
      received[`pi_${id(k)}`] = charged;
      await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, deposit_amount_cents, status, settled_at, stripe_payment_intent_id, capture_method, platform_fee, vendor_net)
               VALUES ($1, $2, $3, '2099-01-05', '10:00', 10000, $4, 'confirmed', now(), $5, 'automatic', 0, 0)`,
        [id(k), bizId, clientId, deposit, `pi_${id(k)}`]);
      apptIds.push(id(k));
      return id(k);
    };
    const shoot = async (k: string, deposit: number | null) => {
      const charged = Math.round((deposit ?? 10000) * 1.08);
      received[`pi_${id(k)}`] = charged;
      await q(`INSERT INTO shoot_bookings (id, photographer_id, client_id, shoot_type, date, start_time, end_time, duration_hours, total_price, deposit_amount_cents, status, stripe_payment_intent_id)
               VALUES ($1, $2, $3, 'portrait', '2099-01-05', '10:00', '11:00', 1, 10000, $4, 'confirmed', $5)`,
        [id(k), photogId, clientId, deposit, `pi_${id(k)}`]);
      shootIds.push(id(k));
      return id(k);
    };

    const vendorToken = generateAccessToken({ userId: vendorId, isVendor: true, businessId: bizId });
    const otherToken = generateAccessToken({ userId: otherId, isVendor: false });
    const photogToken = generateAccessToken({ userId: photogUserId, isVendor: false, isPhotographer: true, photographerId: photogId });
    const apptRow = async (k: string) => (await q(`SELECT status, refund_amount FROM appointments WHERE id = $1`, [k]))[0];
    const shootRow = async (k: string) => (await q(`SELECT status, refund_amount FROM shoot_bookings WHERE id = $1`, [k]))[0];
    const lastRefund = () => refundCalls[refundCalls.length - 1];

    console.log('Business: the app sends dollars in `amount`');
    let a = await appt('a-dollars', null);
    let r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: vendorToken, body: { amount: 25, reason: 'test' } });
    eq(r.status, 200, '$25 partial refund succeeds');
    eq(lastRefund(), { pi: `pi_${a}`, amount: 2500 }, 'Stripe refunds 2500 cents (was 25)');
    eq([r.body?.amount, r.body?.refundedAmountCents], [2500, 2500], 'response: amount and refundedAmountCents in cents');
    eq(await apptRow(a), { status: 'canceled', refund_amount: 2500 }, 'row: refund_amount 2500, canceled (unchanged behaviour)');

    a = await appt('a-cents-dollars', null);
    r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: vendorToken, body: { amount: 25.5 } });
    eq([r.status, lastRefund()], [200, { pi: `pi_${a}`, amount: 2550 }], '$25.50 refunds 2550 cents (was a Stripe error)');

    console.log('Business: amountCents (new app builds)');
    a = await appt('a-amountcents', null);
    r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: vendorToken, body: { amountCents: 2550, amount: 25.5 } });
    eq([r.status, lastRefund()], [200, { pi: `pi_${a}`, amount: 2550 }], 'amountCents wins; refunded once at 2550');

    console.log('Business: full refund on a deposit booking keeps the service fee');
    a = await appt('a-deposit-full', 2000);
    r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: vendorToken, body: {} });
    eq([r.status, lastRefund()], [200, { pi: `pi_${a}`, amount: 2000 }], 'refunds the $20 deposit, not the $21.60 charge');
    eq(await apptRow(a), { status: 'canceled', refund_amount: 2000 }, 'row: refund_amount 2000');

    a = await appt('a-nodeposit-full', null);
    r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: vendorToken, body: {} });
    eq([r.status, lastRefund()], [200, { pi: `pi_${a}`, amount: 10000 }], 'no deposit: refunds the $100 price, fee kept');

    console.log('Business: refused before any Stripe call');
    a = await appt('a-too-big', 2000);
    let before = refundCalls.length;
    r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: vendorToken, body: { amount: 21.6 } });
    eq([r.status, r.body?.code, r.body?.maxRefundCents, r.body?.error], [400, 'REFUND_TOO_LARGE', 2000, 'The most you can refund is $20.00.'], 'more than the deposit → 400 with the most allowed');
    eq(refundCalls.length, before, 'no Stripe refund');
    eq(await apptRow(a), { status: 'confirmed', refund_amount: null }, 'booking untouched');

    r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: vendorToken, body: { amountCents: 12.5 } });
    eq([r.status, r.body?.code, refundCalls.length], [400, 'INVALID_REFUND_AMOUNT', before], 'fractional cents → 400, no Stripe call');

    r = await call('POST', `/api/bookings/appointments/${a}/refund`, { token: otherToken, body: {} });
    eq([r.status, refundCalls.length], [403, before], 'another user → 403, no Stripe call');

    console.log('Photographer: same rules');
    let s = await shoot('s-dollars', null);
    r = await call('POST', `/api/bookings/photographer/${s}/refund`, { token: photogToken, body: { amount: 40 } });
    eq([r.status, lastRefund(), r.body?.refundedAmountCents], [200, { pi: `pi_${s}`, amount: 4000 }, 4000], '$40 refunds 4000 cents (was 40)');
    eq(await shootRow(s), { status: 'canceled', refund_amount: 4000 }, 'row: refund_amount 4000');

    s = await shoot('s-deposit-full', 3000);
    r = await call('POST', `/api/bookings/photographer/${s}/refund`, { token: photogToken, body: {} });
    eq([r.status, lastRefund()], [200, { pi: `pi_${s}`, amount: 3000 }], 'full refund on a deposit shoot: the $30 deposit (unchanged)');

    s = await shoot('s-too-big', null);
    before = refundCalls.length;
    r = await call('POST', `/api/bookings/photographer/${s}/refund`, { token: photogToken, body: { amountCents: 10001 } });
    eq([r.status, r.body?.code, r.body?.maxRefundCents, refundCalls.length], [400, 'REFUND_TOO_LARGE', 10000, before], 'more than the price → 400, no Stripe call');
    eq(await shootRow(s), { status: 'confirmed', refund_amount: null }, 'shoot untouched');
  } finally {
    await q(`DELETE FROM booking_audit_log WHERE booking_id = ANY($1)`, [[...apptIds, ...shootIds]]).catch(() => {});
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[vendorId, otherId, photogUserId, clientId]]).catch(() => {});
    await q(`DELETE FROM appointments WHERE id = ANY($1)`, [apptIds]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE id = ANY($1)`, [shootIds]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [[vendorId, otherId, photogUserId, clientId]]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
