/**
 * Pending points on the Booked screen (booking redesign step 4) — HTTP integration tests.
 *
 * Run with: npx tsx server/pendingPoints.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with a Stripe stub:
 *   PP_TEST_BASE_URL     e.g. http://localhost:5062   (must be localhost)
 *   PP_TEST_PG_URL       the SAME scratch database    (localhost only; seeds + cleans up)
 *   PP_TEST_STRIPE_PORT  port for the in-process Stripe stub started here; boot the server with
 *                        STRIPE_STUB_PORT=<same> and
 *                        NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when PP_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Covers: create-payment-intent sends pendingPoints for a business deposit service, a full price
 * service, a staff service and a photographer service; a retry of the same hold sends the same
 * number; the photographer number matches the PaymentIntent amount settlement uses.
 * Mutation check: send pendingPoints: 0 on new appointments → "deposit service: 600" fails.
 */
import http from 'http';

const BASE = process.env.PP_TEST_BASE_URL;
const PG_URL = process.env.PP_TEST_PG_URL;
const STUB_PORT = Number(process.env.PP_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.7.1' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log('⏭  skipped: set PP_TEST_BASE_URL (+ PP_TEST_PG_URL, PP_TEST_STRIPE_PORT) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, PP_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'pp-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub ──────────────────────────────────────────────────────────────
  const piStore: Record<string, any> = {};
  const customerStore: Record<string, any> = {};
  let piCreates = 0;
  let lastPiAmount = 0;
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === 'POST' && req.url === '/v1/customers') {
        const cid = `cus_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const cust = { id: cid, object: 'customer', email: form.get('email') || '', name: form.get('name') || '' };
        customerStore[cid] = cust;
        return send(200, cust);
      }
      const custM = req.url?.match(/^\/v1\/customers\/([^/?]+)/);
      if (req.method === 'GET' && custM) {
        const c = customerStore[custM[1]];
        return c ? send(200, c) : send(404, { error: { message: 'No such customer' } });
      }
      if (req.method === 'POST' && req.url?.includes('/attach')) return send(200, { id: 'pm_stub', object: 'payment_method' });
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        piCreates++;
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const pi = { id: piId, object: 'payment_intent', amount: Number(form.get('amount') || 0), currency: 'usd', status: 'requires_payment_method', client_secret: `${piId}_secret_stub`, metadata: {}, capture_method: form.get('capture_method') || 'automatic' };
        piStore[piId] = pi; lastPiAmount = pi.amount;
        return send(200, pi);
      }
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)/);
      if (req.method === 'GET' && piM) {
        const pi = piStore[piM[1]];
        return pi ? send(200, pi) : send(404, { error: { message: 'No such payment_intent' } });
      }
      if (req.method === 'POST' && piM) {
        const pi = piStore[piM[1]];
        return pi ? send(200, pi) : send(404, { error: { message: 'No such payment_intent' } });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ─────────────────────────────────────────────────────────────────────
  const P = `pp${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = []; const bizs: string[] = []; const photogs: string[] = [];
  const mkUser = async (key: string, o: { isVendor?: boolean; isPhotographer?: boolean } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor, is_photographer) VALUES ($1::varchar, $1::text, $2, $3, $4)`,
      [uid, `${uid}@pp.test`, o.isVendor ?? false, o.isPhotographer ?? false]);
    users.push(uid); return uid;
  };
  const owner = await mkUser('o', { isVendor: true });
  const biz = id('b');
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, booking_gap_minutes) VALUES ($1, $2, 'PP biz', 'beauty', 'approved', $3, true, 0)`,
    [biz, owner, `acct_${biz.replace(/-/g, '')}`]);
  bizs.push(biz);
  for (let dow = 0; dow <= 6; dow++) {
    await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, '08:00', '20:00', true)`, [id(`wa-${dow}`), biz, dow]);
  }
  const svcDep = id('s-dep'); const svcFull = id('s-full');
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, deposit_amount_cents) VALUES ($1, $2, 'Knotless', 27500, 30, true, 'live', 3000)`, [svcDep, biz]);
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status) VALUES ($1, $2, 'Trim', 7000, 30, true, 'live')`, [svcFull, biz]);
  const stUser = await mkUser('st-u');
  const staffId = id('st');
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, role, status, stripe_onboarding_complete, stripe_account_id) VALUES ($1, $2, $3, 'Staff', 'staff', 'active', true, $4)`,
    [staffId, biz, stUser, `acct_${staffId.replace(/-/g, '')}`]);
  for (let dow = 0; dow <= 6; dow++) {
    await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, staff_member_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, $4, '08:00', '20:00', true)`, [id(`wa-st-${dow}`), biz, staffId, dow]);
  }
  const stSvc = id('st-svc');
  await q(`INSERT INTO staff_services (id, business_id, staff_member_id, name, price_cents, duration_minutes, is_active, status) VALUES ($1, $2, $3, 'Staff cut', 5000, 30, true, 'live')`, [stSvc, biz, staffId]);
  const allDaysOpen = JSON.stringify(Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { open: '08:00', close: '20:00' }])));
  const phUser = await mkUser('ph-u', { isPhotographer: true });
  const ph = id('ph');
  await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
           VALUES ($1, $2, 'PP photo', 10000, 'Austin', 'TX', $3::jsonb, $4, true, false, true, 'public', now(), now())`, [ph, phUser, allDaysOpen, `acct_${ph.replace(/-/g, '')}`]);
  photogs.push(ph);
  for (let day = 0; day <= 6; day++) {
    await q(`INSERT INTO weekly_availability (provider_id, provider_type, day_of_week, start_time, end_time, is_active) VALUES ($1, 'photographer', $2, '08:00', '20:00', true)`, [ph, day]);
  }
  const phSvc = id('ph-svc');
  await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at) VALUES ($1, $2, 'Shoot', 7000, 30, true, 'live', 'package', false, now())`, [phSvc, ph]);

  const customer = await mkUser('c');
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false });
  let dayOffset = 2;
  const nextSlot = () => { dayOffset += 1; const d = new Date(); d.setDate(d.getDate() + dayOffset); return { date: d.toISOString().slice(0, 10), startTime: '10:00' }; };
  const holdFor = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/api/booking/hold', { token, body: { ...nextSlot(), ...body } });
    const hid = r.body?.holdId ?? r.body?.hold?.id ?? r.body?.id;
    if (!hid) throw new Error(`hold failed: ${JSON.stringify(r).slice(0, 300)}`);
    return hid as string;
  };
  const pay = (hid: string) => call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body: {} });

  try {
    console.log('\n── 1. business ──');
    let hid = await holdFor({ providerType: 'business', providerId: biz, serviceId: svcDep });
    let r = await pay(hid);
    assert(r.status === 200 && r.body?.pendingPoints === 600, 'deposit service: 600 ($30 deposit + fee)', r.body && { status: r.status, pendingPoints: r.body.pendingPoints });
    r = await pay(hid);
    assert(r.status === 200 && r.body?.pendingPoints === 600, 'retry of the same hold: still 600', r.body && { pendingPoints: r.body.pendingPoints });
    hid = await holdFor({ providerType: 'business', providerId: biz, serviceId: svcFull });
    r = await pay(hid);
    assert(r.status === 200 && r.body?.pendingPoints === 1400, 'full price $70: 1,400', r.body && { pendingPoints: r.body.pendingPoints });

    console.log('\n── 2. staff ──');
    hid = await holdFor({ providerType: 'business', providerId: biz, staffMemberId: staffId, serviceId: stSvc });
    r = await pay(hid);
    assert(r.status === 200 && r.body?.pendingPoints === 1000, 'staff $50: 1,000', r.body && { pendingPoints: r.body.pendingPoints });

    console.log('\n── 3. photographer ──');
    hid = await holdFor({ providerType: 'photographer', providerId: ph, serviceId: phSvc });
    r = await pay(hid);
    const want = Math.round(lastPiAmount * 20 / 108);
    assert(r.status === 200 && r.body?.pendingPoints === want && want === 1400, 'photographer $70: 1,400, equal to the PaymentIntent amount settlement uses', r.body && { pendingPoints: r.body.pendingPoints, lastPiAmount });
    r = await pay(hid);
    assert(r.status === 200 && r.body?.pendingPoints === 1400, 'photographer retry: same number', r.body && { pendingPoints: r.body.pendingPoints });
  } finally {
    await q(`DELETE FROM appointments WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE photographer_id = ANY($1)`, [photogs]).catch(() => {});
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [[...bizs, ...photogs]]).catch(() => {});
    await q(`DELETE FROM weekly_availability WHERE provider_id = ANY($1)`, [[...bizs, ...photogs]]).catch(() => {});
    await q(`DELETE FROM staff_services WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM photographer_services WHERE photographer_id = ANY($1)`, [photogs]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id = ANY($1)`, [photogs]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
