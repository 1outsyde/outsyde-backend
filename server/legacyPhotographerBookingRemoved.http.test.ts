/**
 * R35 — the old photographer booking route is gone; real photographer bookings still work
 *
 * Run with: npx tsx server/legacyPhotographerBookingRemoved.http.test.ts
 *
 * SCRATCH ONLY. Same setup as server/pointsRedeem.http.test.ts: a backend booted on localhost
 * against a LOCAL scratch Postgres with STRIPE_STUB_PORT pointing at the stub started here. This
 * file also calls the webhook handler in process, so run it with the server's DATABASE_URL,
 * JWT_SECRET, STRIPE_STUB_PORT and NODE_OPTIONS="--import ./.dev/neon-preload.mjs
 * --import ./.dev/stripe-stub-preload.mjs".
 *   LP_TEST_BASE_URL     e.g. http://localhost:5062   (must be localhost)
 *   LP_TEST_PG_URL       the SAME scratch database (localhost only)
 *   LP_TEST_STRIPE_PORT  port for the Stripe stub started here (default 12111)
 * Skips (exit 0) when LP_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Checked (vault R35, 2026-10-31):
 *   - POST /api/bookings/photographer (price from the request, booking written before payment,
 *     never confirmable, blocks the slot) no longer creates anything, even for a signed in
 *     customer with a session cookie (the only check it had)
 *   - the app's real photographer flow still books end to end: POST /api/booking/hold →
 *     POST /api/booking/:holdId/create-payment-intent → payment_intent.succeeded → confirmed, at
 *     the service's own price
 */
import http from 'http';
import crypto from 'crypto';

const BASE = process.env.LP_TEST_BASE_URL;
const PG_URL = process.env.LP_TEST_PG_URL;
const STUB_PORT = Number(process.env.LP_TEST_STRIPE_PORT || process.env.STRIPE_STUB_PORT || '12111');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u?: string) => !!u && ['localhost', '127.0.0.1'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; body: any; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.95.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    if (o.cookie) headers['Cookie'] = o.cookie;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json: any = null; try { json = JSON.parse(b); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode || 0, body: json, setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log('⏭  skipped: set LP_TEST_BASE_URL (+ LP_TEST_PG_URL)'); process.exit(0); }
  if (!isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: base URL and database must both be local');

  const { generateAccessToken, hashPassword } = await import('./auth');
  const { WebhookHandlers } = await import('./stripe/webhookHandlers');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub (customers, PaymentIntents, checkout sessions, transfers) ──
  const pis: Record<string, any> = {};
  const checkoutSessions: any[] = [];
  let seq = 0;
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const url = (req.url || '').split('?')[0];
      const meta = (into: Record<string, string>) => {
        for (const [k, v] of form.entries()) if (k.startsWith('metadata[') && k.endsWith(']')) into[k.slice(9, -1)] = v;
        return into;
      };
      const view = (pi: any) => ({ ...pi, amount_received: pi.status === 'succeeded' ? pi.amount : 0, latest_charge: { id: `ch_${pi.id}`, amount_refunded: 0, transfer: null } });
      if (req.method === 'POST' && url === '/v1/customers') return send(200, { id: `cus_stub_${++seq}`, object: 'customer' });
      if (req.method === 'GET' && url.startsWith('/v1/customers/')) return send(200, { id: url.split('/')[3], object: 'customer' });
      if (req.method === 'POST' && url === '/v1/checkout/sessions') {
        const s = { id: `cs_stub_${++seq}`, object: 'checkout.session', url: `https://checkout.stub/${seq}`, amount_total: Number(form.get('line_items[0][price_data][unit_amount]') || 0), metadata: meta({}) };
        checkoutSessions.push(s);
        return send(200, s);
      }
      if (req.method === 'POST' && url === '/v1/payment_intents') {
        const pi = { id: `pi_stub_${Date.now()}_${++seq}`, object: 'payment_intent', status: 'requires_payment_method', amount: Number(form.get('amount') || 0),
          currency: 'usd', capture_method: form.get('capture_method') || 'automatic', client_secret: `secret_${seq}`, metadata: meta({}) };
        pis[pi.id] = pi;
        return send(200, view(pi));
      }
      let m = url.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (m && req.method === 'GET') return pis[m[1]] ? send(200, view(pis[m[1]])) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no pi' } });
      if (m && req.method === 'POST') {
        const pi = pis[m[1]];
        if (!pi) return send(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no pi' } });
        if (form.get('amount')) pi.amount = Number(form.get('amount'));
        meta(pi.metadata);
        return send(200, view(pi));
      }
      m = url.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (m && req.method === 'POST' && pis[m[1]]) { pis[m[1]].status = 'canceled'; return send(200, view(pis[m[1]])); }
      if (req.method === 'GET' && url === '/v1/transfers') return send(200, { object: 'list', data: [] });
      if (req.method === 'POST' && url === '/v1/transfers') return send(200, { id: `tr_${++seq}`, object: 'transfer', amount: Number(form.get('amount')), destination: form.get('destination'), metadata: meta({}) });
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const P = `lp${Date.now().toString(36)}`;
  const userIds: string[] = [];
  let photogId = '';
  const svcIds: string[] = [];
  try {
    // ── seed ──────────────────────────────────────────────────────────────
    const password = `Pw-${P}-123456`;
    const customer = crypto.randomUUID();
    const email = `${P}-cust@x.test`;
    await q(`INSERT INTO users (id, username, email, password, is_active) VALUES ($1, $2, $3, $4, true)`, [customer, `${P}cust`, email, await hashPassword(password)]);
    userIds.push(customer);
    const photogUser = crypto.randomUUID();
    await q(`INSERT INTO users (id, username, email, is_active) VALUES ($1, $2, $3, true)`, [photogUser, `${P}ph`, `${P}-ph@x.test`]);
    userIds.push(photogUser);
    photogId = crypto.randomUUID();
    const hours = JSON.stringify(Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { open: '08:00', close: '20:00' }])));
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
             VALUES ($1, $2, $3, 10000, 'Austin', 'TX', $4::jsonb, $5, true, false, true, 'public', now(), now())`, [photogId, photogUser, `${P} Photo`, hours, `acct_${P}ph`]);
    for (let day = 0; day <= 6; day++) {
      await q(`INSERT INTO weekly_availability (provider_id, provider_type, day_of_week, start_time, end_time, is_active) VALUES ($1, 'photographer', $2, '08:00', '20:00', true)`, [photogId, day]);
    }
    const svc = crypto.randomUUID();
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, deposit_amount_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
             VALUES ($1, $2, 'Portrait', 20000, NULL, 60, true, 'live', 'fixed', false, now())`, [svc, photogId]);
    svcIds.push(svc);
    const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false });
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const rowsFor = async () => q(`SELECT id, status, total_price, start_time FROM shoot_bookings WHERE photographer_id = $1 ORDER BY created_at`, [photogId]);

    // ── 1. the old route: price from the request ──────────────────────────
    console.log('\n── 1. old POST /api/bookings/photographer ──');
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
    assert(login.status === 200 && cookie.length > 0, 'customer signed in with a session cookie (what the old route checked)', { s: login.status });
    // A complete, valid body for the old route (its schema needs shootType and locationDetails), so
    // the only thing that can stop it is the route being gone.
    const old = await call('POST', '/api/bookings/photographer', { cookie, body: {
      photographerId: photogId, serviceId: svc, shootType: 'portrait', locationDetails: 'Studio',
      bookingDateTime: `${tomorrow}T15:00:00`, totalPriceCents: 100,
    } });
    assert(old.status !== 201 && !(old.body && (old.body.booking || old.body.checkoutUrl)), 'the old route creates nothing', { s: old.status, body: old.body });
    assert((await rowsFor()).length === 0, 'no booking row written (nothing blocks the photographer slot)', await rowsFor());
    assert(checkoutSessions.length === 0, 'no Stripe checkout opened for a made-up price', checkoutSessions);

    // ── 2. the app's real photographer flow ───────────────────────────────
    console.log('\n── 2. real flow: hold → payment intent → paid ──');
    const hold = await call('POST', '/api/booking/hold', { token, body: { providerType: 'photographer', providerId: photogId, serviceId: svc, date: tomorrow, startTime: '15:00' } });
    const holdId = hold.body?.holdId as string;
    assert(hold.status === 200 && !!holdId, 'the same 3 PM slot can be held (the old route left nothing behind)', { s: hold.status, b: hold.body });
    const pay = await call('POST', `/api/booking/${holdId}/create-payment-intent`, { token, body: {} });
    const shootId = pay.body?.shootBookingId as string;
    const piId = pay.body?.paymentIntentId as string;
    assert(pay.status === 200 && !!shootId && !!piId, 'payment intent created for the held slot', { s: pay.status, b: pay.body });
    assert(pis[piId]?.amount === 21600, 'charged the service price plus the service fee ($216.00), not a client price', pis[piId]?.amount);
    pis[piId].status = 'succeeded';
    await WebhookHandlers.handlePaymentIntentSucceeded(pis[piId]);
    const [row] = await q(`SELECT status, total_price FROM shoot_bookings WHERE id = $1`, [shootId]);
    assert(row?.status === 'confirmed' && row?.total_price === 20000, 'booking confirmed at the service price', row);
  } finally {
    const shootIds = photogId ? (await q(`SELECT id FROM shoot_bookings WHERE photographer_id = $1`, [photogId]).catch(() => [])).map((x: any) => x.id) : [];
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await q(`DELETE FROM pending_points_transactions WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await q(`DELETE FROM point_transactions WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await q(`DELETE FROM booking_audit_log WHERE booking_id = ANY($1)`, [shootIds]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE id = ANY($1)`, [shootIds]).catch(() => {});
    if (photogId) await q(`DELETE FROM booking_holds WHERE provider_id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM photographer_services WHERE id = ANY($1)`, [svcIds]).catch(() => {});
    if (photogId) await q(`DELETE FROM weekly_availability WHERE provider_id = $1`, [photogId]).catch(() => {});
    if (photogId) await q(`DELETE FROM photographers WHERE id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [userIds]).catch(() => {});
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
