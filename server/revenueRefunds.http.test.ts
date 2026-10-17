/**
 * Revenue rule (Part A): cancellation fee + admin refund write paths — HTTP integration tests
 *
 * Run with: npx tsx server/revenueRefunds.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema incl.
 * migration 048, no rows in appointments / orders / shoot_bookings) with the Stripe stub preload:
 *
 *   RRF_TEST_BASE_URL     e.g. http://localhost:5072   (must be localhost)
 *   RRF_TEST_PG_URL       the SAME scratch database     (localhost only; seeds + cleans up)
 *   RRF_TEST_STRIPE_PORT  port for the Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *
 * Skips (exit 0) when RRF_TEST_BASE_URL is unset and refuses any non-local host.
 *
 * What it proves:
 *  - customer cancel with a flat fee charges the fee and records cancellation_fee_kept_cents
 *  - the kept fee never reaches the business's revenue; Outsyde admin revenue adds it
 *  - the canceled booking's own charge still counts for the business (nothing was refunded)
 *  - an admin-approved appointment refund writes refund_amount / refunded_at / stripe_refund_id,
 *    cancels the booking, and the refunded money leaves business revenue
 *  - after an admin refund, a customer cancel is refused (no second refund, no second points reversal)
 */
import http from 'http';

const BASE = process.env.RRF_TEST_BASE_URL;
const PG_URL = process.env.RRF_TEST_PG_URL;
const STUB_PORT = Number(process.env.RRF_TEST_STRIPE_PORT || '0');

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.7.8' };
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
  if (!BASE) { console.log('⏭  skipped: set RRF_TEST_BASE_URL (+ RRF_TEST_PG_URL, RRF_TEST_STRIPE_PORT) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost and RRF_TEST_STRIPE_PORT set');
  }

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'rrf-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const [{ n }] = await q(`SELECT ((SELECT COUNT(*) FROM appointments) + (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM shoot_bookings))::int AS n`);
  if (n !== 0) throw new Error('refusing to run: scratch DB must start with no appointments, orders or shoot bookings');

  // ── Stripe stub: only what these two routes call ──
  const stripeCalls: string[] = [];
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      stripeCalls.push(`${req.method} ${req.url?.split('?')[0]}`);
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)/);
      if (req.method === 'GET' && piM) {
        return send(200, { id: piM[1], object: 'payment_intent', status: 'succeeded', amount: 20000, amount_received: 20000, payment_method: 'pm_stub', latest_charge: { id: 'ch_stub', object: 'charge', amount_refunded: 0 } });
      }
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        return send(200, { id: `pi_fee_${Date.now()}`, object: 'payment_intent', status: 'succeeded', amount: Number(form.get('amount') || 0) });
      }
      if (req.method === 'POST' && req.url === '/v1/refunds') {
        return send(200, { id: `re_stub_${Date.now()}`, object: 'refund', status: 'succeeded', amount: Number(form.get('amount') || 0) });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const P = `rrf${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const today = new Date().toISOString().slice(0, 10);
  const inTwoHours = new Date(Date.now() + 2 * 3600 * 1000);
  const apptDate = inTwoHours.toISOString().slice(0, 10);
  const apptTime = inTwoHours.toISOString().slice(11, 16);
  const vendorId = id('vendor');
  const clientId = id('client');
  const adminId = id('admin');
  const bizId = id('biz');
  const svcId = id('svc');

  try {
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [vendorId, `${vendorId}@rrf.test`]);
    await q(`INSERT INTO users (id, username, email, stripe_customer_id) VALUES ($1::varchar, $1::text, $2, 'cus_stub_rrf')`, [clientId, `${clientId}@rrf.test`]);
    await q(`INSERT INTO users (id, username, email, is_admin) VALUES ($1::varchar, $1::text, $2, true)`, [adminId, 'info@goutsyde.com']); // scratch DB only
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'RRF Biz', 'beauty', 'approved')`, [bizId, vendorId]);
    // Policy: no refund window, flat $15 cancellation fee.
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, full_refund_window, has_cancellation_fee, cancellation_fee_type, cancellation_fee_amount)
             VALUES ($1, $2, 'Gen manicure', 20000, 60, 'never', true, 'flat', 1500)`, [svcId, bizId]);

    // f1: confirmed, no deposit, charged $200 → customer cancels, $15 fee kept by Outsyde.
    // r1: confirmed, $30 deposit → admin approves a $30 refund.
    for (const [k, dep, time] of [['f1', null, apptTime], ['r1', 3000, '23:00']] as const) {
      await q(`INSERT INTO appointments (id, business_id, client_id, service_id, appointment_date, appointment_time, total_price, deposit_amount_cents, status, settled_at, stripe_payment_intent_id, capture_method, platform_fee, vendor_net)
               VALUES ($1, $2, $3, $4, $5, $6, 20000, $7, 'confirmed', now(), $8, 'automatic', 400, 19600)`,
        [id(k), bizId, clientId, svcId, k === 'f1' ? apptDate : today, time, dep, `pi_stub_${k}`]);
    }

    const clientToken = generateAccessToken({ userId: clientId, isVendor: false });
    const vendorToken = generateAccessToken({ userId: vendorId, isVendor: true, businessId: bizId });
    const adminToken = generateAccessToken({ userId: adminId, isVendor: false, isAdmin: true });

    console.log('Customer cancel with a kept cancellation fee');
    let r = await call('POST', `/api/bookings/appointments/${id('f1')}/cancel`, { token: clientToken, body: {} });
    eq(r.status, 200, 'cancel succeeds');
    eq(r.body?.feeAmountCents, 1500, 'fee is $15');
    eq(stripeCalls.includes('POST /v1/payment_intents'), true, 'fee charged through Stripe');
    let [f1] = await q(`SELECT status, cancellation_fee_kept_cents, refund_amount FROM appointments WHERE id = $1`, [id('f1')]);
    eq([f1.status, f1.cancellation_fee_kept_cents, f1.refund_amount], ['canceled', 1500, null], 'row canceled, fee recorded, nothing refunded');

    console.log('Admin-approved appointment refund');
    const [rr] = await q(`INSERT INTO refund_requests (requester_id, requester_type, target_type, target_id, reason, amount)
                          VALUES ($1, 'consumer', 'appointment', $2, 'test', 3000) RETURNING id`, [clientId, id('r1')]);
    r = await call('PATCH', `/api/admin/refund-requests/${rr.id}`, { token: adminToken, body: { status: 'approved' } });
    eq(r.status, 200, 'approve succeeds');
    let [r1] = await q(`SELECT status, refund_amount, refunded_at IS NOT NULL AS refunded, stripe_refund_id LIKE 're_stub_%' AS has_refund_id, cancellation_reason FROM appointments WHERE id = $1`, [id('r1')]);
    eq([r1.status, r1.refund_amount, r1.refunded, r1.has_refund_id, r1.cancellation_reason],
      ['canceled', 3000, true, true, 'Refunded by Outsyde'], 'appointment marked refunded and canceled');

    r = await call('POST', `/api/bookings/appointments/${id('r1')}/cancel`, { token: clientToken, body: {} });
    eq(r.status, 400, 'customer cancel after an admin refund is refused');
    const refundsCreated = stripeCalls.filter((c) => c === 'POST /v1/refunds').length;
    eq(refundsCreated, 1, 'exactly one Stripe refund');

    console.log('Revenue after both');
    r = await call('GET', '/api/business/stats', { token: vendorToken });
    // f1 counts at $200 only if its appointment date is this month; r1 refunded in full → $0.
    const f1ThisMonth = apptDate.slice(0, 7) === today.slice(0, 7);
    eq(r.body?.stats?.monthlyRevenueCents, f1ThisMonth ? 20000 : 0, 'business revenue: canceled f1 keeps its $200 charge, no $15 fee, refunded r1 adds $0');
    r = await call('GET', '/api/admin/stats', { token: adminToken });
    eq(r.body?.stats?.totalRevenue, 215, 'admin total (dollars): $200 + Outsyde $15 fee, refunded r1 $0');
  } finally {
    await q(`DELETE FROM refund_requests WHERE target_id = ANY($1)`, [[id('f1'), id('r1')]]).catch(() => {});
    await q(`DELETE FROM booking_audit_log WHERE booking_id = ANY($1)`, [[id('f1'), id('r1')]]).catch(() => {});
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[vendorId, clientId, adminId]]).catch(() => {});
    await q(`DELETE FROM appointments WHERE business_id = $1`, [bizId]);
    await q(`DELETE FROM vendor_services WHERE id = $1`, [svcId]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [[vendorId, clientId, adminId]]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
