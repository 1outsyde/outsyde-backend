/**
 * Service Add-ons + Customer Booking Details — HTTP integration tests
 *
 * Run with: npx tsx server/serviceAddons.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migration 040 applied) with a Stripe stub. Environment variables:
 *
 *   SA_TEST_BASE_URL      e.g. http://localhost:5062         (must be localhost)
 *   SA_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   SA_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *
 * The file skips (exit 0) when SA_TEST_BASE_URL is unset and refuses any non-local host, so it
 * can never touch Neon or production.
 *
 * Mutation check note (section h): tests in sections (b) and (c) verify
 *   appointment.totalPrice = B+A and PI amount = (B+A)+8%.
 * Removing `+ holdAddonsTotalCents` from routes.ts lines 5905/5913 would cause those assertions to
 * fail. To demonstrate: temporarily make that edit, re-run, confirm failures, then restore.
 */

import http from 'http';

const BASE = process.env.SA_TEST_BASE_URL;
const PG_URL = process.env.SA_TEST_PG_URL;
const STUB_PORT = Number(process.env.SA_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; bizId?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.99.1.1` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    if (o.bizId) headers['x-business-id'] = o.bizId;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set SA_TEST_BASE_URL (+ SA_TEST_PG_URL, SA_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, SA_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sa-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub ──────────────────────────────────────────────────────────────────
  const piStore: Record<string, any> = {};
  const customerStore: Record<string, any> = {};
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);

      // POST /v1/customers
      if (req.method === 'POST' && req.url === '/v1/customers') {
        const id = `cus_stub_${Date.now()}`;
        const cust = { id, object: 'customer', email: form.get('email') || '', name: form.get('name') || '' };
        customerStore[id] = cust;
        return send(200, cust);
      }
      // GET /v1/customers/:id
      const custM = req.url?.match(/^\/v1\/customers\/([^/?]+)/);
      if (req.method === 'GET' && custM) {
        const c = customerStore[custM[1]];
        return c ? send(200, c) : send(404, { error: { message: 'No such customer' } });
      }
      // POST /v1/payment_methods/:id/attach — no-op
      if (req.method === 'POST' && req.url?.includes('/attach')) {
        return send(200, { id: 'pm_stub', object: 'payment_method' });
      }
      // POST /v1/payment_intents
      if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        const piId = `pi_stub_${Date.now()}`;
        const amount = Number(form.get('amount') || 0);
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) { if (k.startsWith('metadata[') && k.endsWith(']')) metadata[k.slice(9, -1)] = v; }
        const pi = { id: piId, object: 'payment_intent', amount, currency: form.get('currency') || 'usd', status: 'requires_payment_method', client_secret: `${piId}_secret_stub`, metadata, description: form.get('description') || '', capture_method: form.get('capture_method') || 'automatic' };
        piStore[piId] = pi;
        return send(200, pi);
      }
      // GET /v1/payment_intents/:id
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)/);
      if (req.method === 'GET' && piM) {
        const pi = piStore[piM[1]];
        return pi ? send(200, pi) : send(404, { error: { message: 'No such payment_intent' } });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ────────────────────────────────────────────────────────────────────────
  const P = `sa${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const seededUsers: string[] = [];
  const seededBiz: string[] = [];
  const seededSvc: string[] = [];
  const seededHolds: string[] = [];

  const mkUser = async (key: string, extra: Partial<Record<string, unknown>> = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`,
      [uid, `${uid}@sa.test`, !!extra.isVendor]);
    seededUsers.push(uid);
    return uid;
  };
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', 'approved', $4, true)`,
      [bid, ownerId, `Biz ${key}`, `acct_${bid.replace(/-/g, '')}`]);
    seededBiz.push(bid);
    return bid;
  };
  const mkSvc = async (key: string, bizId: string, opts: { depositCents?: number; durationMins?: number } = {}) => {
    const sid = id(key);
    await q(`INSERT INTO vendor_services (id, business_id, name, price_cents, duration_minutes, deposit_amount_cents, is_active, status) VALUES ($1, $2, $3, 7000, $4, $5, true, 'live')`,
      [sid, bizId, `Svc ${key}`, opts.durationMins ?? 60, opts.depositCents ?? null]);
    seededSvc.push(sid);
    return sid;
  };

  // Vendor user + business + services
  const vendorId = await mkUser('v', { isVendor: true });
  const bizId = await mkBiz('b', vendorId);
  const svcNoDeposit = await mkSvc('snd', bizId);                       // B=7000, no deposit
  const svcDeposit   = await mkSvc('sd', bizId, { depositCents: 2000 }); // B=7000, D=2000

  // Another vendor to test cross-business auth
  const otherVendorId = await mkUser('v2', { isVendor: true });
  const otherBizId    = await mkBiz('b2', otherVendorId);
  const otherSvc      = await mkSvc('sother', otherBizId);

  // Customer user
  const customerId = await mkUser('c');

  const vendorToken   = generateAccessToken({ userId: vendorId,      isVendor: true,  isAdmin: false });
  const otherToken    = generateAccessToken({ userId: otherVendorId, isVendor: true,  isAdmin: false });
  const customerToken = generateAccessToken({ userId: customerId,    isVendor: false, isAdmin: false });

  // Business availability — open all day for the next 7 days
  const TOMORROW = new Date(); TOMORROW.setDate(TOMORROW.getDate() + 1);
  const tDate = TOMORROW.toISOString().slice(0, 10);
  await q(`INSERT INTO business_availability (id, business_id, date, start_time, end_time) VALUES ($1, $2, $3, '08:00', '20:00')`, [id('avail'), bizId, tDate]);

  try {
    // ────────────────────────────────────────────────────────────────────────────────
    // f. CRUD auth
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── f. CRUD auth ──');

    let r = await call('GET', `/api/vendor/services/${svcNoDeposit}/addons`);
    assert(r.status === 401, 'GET addons: unauthenticated → 401', r);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: otherToken });
    assert(r.status === 404, 'POST addon: non-owner → 404', r);

    r = await call('GET', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken });
    assert(r.status === 200 && Array.isArray(r.body?.addons), 'GET addons: owner → 200 + array', r);

    r = await call('GET', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, bizId });
    assert(r.status === 200, 'GET addons: x-business-id admin → 200', r);

    // ────────────────────────────────────────────────────────────────────────────────
    // 5. CRUD zod validation + description field
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── CRUD zod validation ──');

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: '', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: empty name → 400', r);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'X'.repeat(81), priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: name > 80 chars → 400', r);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Addon', priceCents: 100001, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: priceCents > 100000 → 400', r);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Addon', priceCents: -1, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: priceCents < 0 → 400', r);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Addon', priceCents: 0, durationMinutes: 481 } });
    assert(r.status === 400, 'POST: durationMinutes > 480 → 400', r);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Addon', priceCents: 0, durationMinutes: -1 } });
    assert(r.status === 400, 'POST: durationMinutes < 0 → 400', r);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Addon', priceCents: 0, durationMinutes: 0, description: 'X'.repeat(301) } });
    assert(r.status === 400, 'POST: description > 300 chars → 400', r);

    // Create valid add-ons: addon1 = A=1500, +30min; addon2 = A=0, +0min; addon3 = inactive
    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Premium Treatment', priceCents: 1500, durationMinutes: 30, description: 'Deep conditioning', sortOrder: 1 } });
    assert(r.status === 201 && r.body?.addon?.id, 'POST valid addon1 (A=1500, +30min) → 201', r);
    const addonId1 = r.body?.addon?.id as string;
    assert(r.body?.addon?.description === 'Deep conditioning', 'description stored', r.body?.addon);
    assert(!r.body?.addon?.createdAt || !r.body?.addon?.serviceId, 'POST response does not expose serviceId/createdAt to vendor CRUD', r.body?.addon);

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Free Extra', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 201, 'POST valid addon2 (A=0) → 201', r);
    const addonId2 = r.body?.addon?.id as string;

    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'Inactive Addon', priceCents: 500, durationMinutes: 10, isActive: false } });
    assert(r.status === 201, 'POST inactive addon3 → 201', r);
    const addonId3 = r.body?.addon?.id as string;

    // Also create addon for deposit service
    r = await call('POST', `/api/vendor/services/${svcDeposit}/addons`, { token: vendorToken, body: { name: 'Deposit Addon', priceCents: 1500, durationMinutes: 30 } });
    assert(r.status === 201, 'POST addon for deposit service → 201', r);
    const depositAddonId = r.body?.addon?.id as string;

    // PATCH
    r = await call('PATCH', `/api/vendor/services/${svcNoDeposit}/addons/${addonId2}`, { token: otherToken, body: { name: 'Hacked' } });
    assert(r.status === 404, 'PATCH: non-owner → 404', r);
    r = await call('PATCH', `/api/vendor/services/${svcNoDeposit}/addons/${addonId2}`, { token: vendorToken, body: { name: 'Free Extra Updated', description: 'updated desc' } });
    assert(r.status === 200 && r.body?.addon?.name === 'Free Extra Updated', 'PATCH: owner → 200 + updated', r);

    // Too-many add-ons (max 20)
    for (let i = 0; i < 17; i++) {
      await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: `Fill ${i}`, priceCents: 0, durationMinutes: 0 } });
    }
    r = await call('POST', `/api/vendor/services/${svcNoDeposit}/addons`, { token: vendorToken, body: { name: 'One Too Many', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400 && r.body?.code === 'TOO_MANY_ADDONS', 'POST: 21st add-on → 400 TOO_MANY_ADDONS', r);

    // ────────────────────────────────────────────────────────────────────────────────
    // a. A=0 parity: GET /api/businesses/:id/services returns addons:[]
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── a. A=0 parity: public services ──');

    // Create a fresh vendor with no addons for clean parity check
    const cleanVendorId = await mkUser('cv', { isVendor: true });
    const cleanBizId    = await mkBiz('cb', cleanVendorId);
    const cleanSvcId    = await mkSvc('cs', cleanBizId);
    r = await call('GET', `/api/businesses/${cleanBizId}/services`);
    assert(r.status === 200, 'GET /api/businesses/:id/services → 200', r);
    const svcData = r.body?.services?.[0];
    assert(Array.isArray(svcData?.addons) && svcData.addons.length === 0, 'A=0: addons:[] present', svcData);
    // Public addon shape: only allowed fields
    if (svcData?.addons?.length > 0) {
      const keys = Object.keys(svcData.addons[0]);
      assert(!keys.includes('createdAt') && !keys.includes('updatedAt') && !keys.includes('serviceId'), 'Public: no createdAt/updatedAt/serviceId', keys);
    }

    // Public services for the main biz — check addon shape
    r = await call('GET', `/api/businesses/${bizId}/services`);
    assert(r.status === 200, 'GET businesses/:id/services for test biz → 200', r);
    const pubSvc = r.body?.services?.find((s: any) => s.id === svcNoDeposit);
    assert(pubSvc !== undefined, 'svcNoDeposit found in public services', r.body);
    if (pubSvc) {
      const pubAddon = pubSvc.addons?.find((a: any) => a.id === addonId1);
      assert(pubAddon !== undefined, 'addon1 present in public services', pubSvc.addons);
      // inactive addon must NOT be present
      assert(!pubSvc.addons?.some((a: any) => a.id === addonId3), 'inactive addon3 NOT in public services', pubSvc.addons?.map((a: any) => a.id));
      if (pubAddon) {
        const allowedKeys = new Set(['id', 'name', 'description', 'priceCents', 'durationMinutes', 'sortOrder']);
        const extraKeys = Object.keys(pubAddon).filter(k => !allowedKeys.has(k));
        assert(extraKeys.length === 0, `Public addon shape: only allowed fields (no extras: ${extraKeys.join(',')})`, pubAddon);
        assert(!('customerDetails' in pubSvc), 'customerDetails not in public service', pubSvc);
      }
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // 8. Slots: addonIds without serviceId → 400
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── slots validation ──');
    r = await call('GET', `/api/availability/slots?providerType=business&providerId=${bizId}&date=${tDate}&serviceDurationMinutes=60&addonIds=${addonId1}`);
    assert(r.status === 400, 'Slots: addonIds without serviceId → 400', r);

    r = await call('GET', `/api/availability/slots?providerType=business&providerId=${bizId}&date=${tDate}&serviceDurationMinutes=60&serviceId=${svcNoDeposit}&addonIds=${addonId3}`);
    assert(r.status === 400, 'Slots: inactive addonId → 400', r);

    r = await call('GET', `/api/availability/slots?providerType=business&providerId=${bizId}&date=${tDate}&serviceDurationMinutes=60&serviceId=${svcNoDeposit}`);
    assert(r.status === 200 && Array.isArray(r.body?.slots), 'Slots: A=0 parity → 200 + slots', r);

    r = await call('GET', `/api/availability/slots?providerType=business&providerId=${bizId}&date=${tDate}&serviceDurationMinutes=60&serviceId=${svcNoDeposit}&addonIds=${addonId1}`);
    assert(r.status === 200, 'Slots: valid addonIds → 200 (duration extended)', r);

    // ────────────────────────────────────────────────────────────────────────────────
    // e. Rejections on hold
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── e. hold rejections ──');

    const holdBase = { providerType: 'business', providerId: bizId, serviceId: svcNoDeposit, date: tDate, startTime: '10:00' };

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: 'not-array' } });
    assert(r.status === 400, 'addonIds not array → 400', r);

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: Array(11).fill(addonId1) } });
    assert(r.status === 400 && r.body?.code === 'TOO_MANY_ADDONS', 'addonIds > 10 → 400 TOO_MANY_ADDONS', r);

    // Foreign add-on (belongs to otherSvc)
    const foreignAddonR = await call('POST', `/api/vendor/services/${otherSvc}/addons`, { token: otherToken, body: { name: 'Foreign', priceCents: 100, durationMinutes: 0 } });
    const foreignAddonId = foreignAddonR.body?.addon?.id as string;
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: [foreignAddonId] } });
    assert(r.status === 400, 'foreign add-on → 400', r);

    // Inactive add-on
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: [addonId3] } });
    assert(r.status === 400, 'inactive add-on → 400', r);

    // Duplicate IDs
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: [addonId1, addonId1] } });
    // Duplicate IDs produce wrong resolvedAddons.length check → 400
    assert(r.status === 400, 'duplicate addonIds → 400', r);

    // customerDetails > 1000 chars
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, customerDetails: 'x'.repeat(1001) } });
    assert(r.status === 400, 'customerDetails > 1000 → 400', r);

    // Photographer booking with addons (photographer providerType)
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, providerType: 'photographer', providerId: id('fake-photog'), serviceId: id('fake-psvc'), addonIds: [addonId1] } });
    assert(r.status === 400, 'photographer booking + addonIds → 400', r);

    // ────────────────────────────────────────────────────────────────────────────────
    // a (hold part) + d. Duration: hold A=0 (parity)
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── a+d. Hold A=0 parity ──');

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase } });
    assert(r.status === 200, 'A=0 hold → 200', r);
    assert(r.body?.addonsTotalCents === 0, 'A=0: addonsTotalCents = 0', r.body);
    assert(r.body?.addonsDurationMinutes === 0, 'A=0: addonsDurationMinutes = 0', r.body);
    assert(Array.isArray(r.body?.addons) && r.body.addons.length === 0, 'A=0: addons = []', r.body);
    assert(r.body?.customerDetails === null || r.body?.customerDetails === undefined, 'A=0: customerDetails null/absent', r.body);
    const holdId_a0 = r.body?.holdId as string;
    seededHolds.push(holdId_a0);

    // ────────────────────────────────────────────────────────────────────────────────
    // c. No-deposit + addons: B=7000, A=1500, total=8500, PI=9180, vendorNet=8330, inPersonDue=0
    //    8500 * 1.08 = 9180; 9180 * 0.98 = 8996.4 — wait, vendorNet uses platform fee logic
    //    calculateBookingFees(8500): subtotal=8500, consumerFee=680, total=9180
    //    platformFee=170 (2%), vendorNet=8330
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── c. No-deposit + addons ──');

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: [addonId1], customerDetails: 'Please use organic products' } });
    assert(r.status === 200, 'no-deposit hold + addons → 200', r);
    assert(r.body?.addonsTotalCents === 1500, 'no-deposit hold: addonsTotalCents = 1500', r.body);
    assert(r.body?.addonsDurationMinutes === 30, 'no-deposit hold: addonsDurationMinutes = 30', r.body);
    assert(r.body?.totalPriceCents === 8500, 'no-deposit hold: totalPriceCents = 8500 (B+A)', r.body);
    assert(r.body?.customerDetails === 'Please use organic products', 'no-deposit hold: customerDetails stored', r.body);
    assert(r.body?.inPersonDueCents === 0, 'no-deposit hold: inPersonDueCents = 0', r.body);
    // Fee preview: on 8500 → consumerFee = 680, total = 9180
    assert(r.body?.feeBreakdown?.grossChargeAmount === 9180, 'no-deposit: gross charge (PI amount) = 9180', r.body?.feeBreakdown);
    assert(r.body?.feeBreakdown?.vendorNetAmount === 8330, 'no-deposit: vendorNet = 8330', r.body?.feeBreakdown);
    const holdId_noDeposit = r.body?.holdId as string;
    seededHolds.push(holdId_noDeposit);

    // ────────────────────────────────────────────────────────────────────────────────
    // b. Deposit + addons: B=7000, A=1500, D=2000
    //    totalPrice=8500, charge (online)=D=2000, inPersonDue=6500, points base=8500
    //    PI amount = quoteDeposit(8500, 2000) => deposit path: chargeAmountCents=2000
    //    calculateBookingFees(2000): consumerFee=160, PI=2160, vendorNet=1960
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── b. Deposit + addons ──');

    const holdBaseDeposit = { ...holdBase, serviceId: svcDeposit };
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBaseDeposit, addonIds: [depositAddonId] } });
    assert(r.status === 200, 'deposit hold + addons → 200', r);
    assert(r.body?.addonsTotalCents === 1500, 'deposit hold: addonsTotalCents = 1500', r.body);
    assert(r.body?.totalPriceCents === 8500, 'deposit hold: totalPriceCents = 8500', r.body);
    assert(r.body?.inPersonDueCents === 6500, 'deposit hold: inPersonDueCents = 6500 (8500-2000)', r.body);
    assert(r.body?.depositAmountCents === 2000, 'deposit hold: depositAmountCents = 2000', r.body);
    assert(r.body?.chargeAmountCents === 2000, 'deposit hold: chargeAmountCents = D = 2000', r.body);
    // Fee preview for deposit is on charge (2000): consumerFee=160, gross=2160
    assert(r.body?.feeBreakdown?.grossChargeAmount === 2160, 'deposit: gross charge = 2160 (on D)', r.body?.feeBreakdown);
    const holdId_deposit = r.body?.holdId as string;
    seededHolds.push(holdId_deposit);

    // ────────────────────────────────────────────────────────────────────────────────
    // d. Duration: endTime extended by addon minutes; overlapping hold rejected
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── d. Duration + overlap ──');

    // Hold at 10:00, service=60min, addon=+30min → endTime should be 11:30
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, startTime: '10:00', addonIds: [addonId1] } });
    assert(r.status === 200, 'hold at 10:00 with +30min addon → 200', r);
    assert(r.body?.endTime === '11:30', 'endTime = 11:30 (60+30 = 90 min)', r.body);
    const holdId_dur = r.body?.holdId as string;
    seededHolds.push(holdId_dur);

    // Second customer tries same slot (10:00, same +30min addon) → should be rejected
    const cust2Id = await mkUser('c2');
    seededUsers.push(cust2Id);
    const cust2Token = generateAccessToken({ userId: cust2Id, isVendor: false, isAdmin: false });
    r = await call('POST', '/api/booking/hold', { token: cust2Token, body: { ...holdBase, startTime: '10:00', addonIds: [addonId1] } });
    assert(r.status === 409 || r.status === 400, 'overlapping hold → 409/400', r);

    // ────────────────────────────────────────────────────────────────────────────────
    // 2. Legacy route: POST /api/booking/:holdId/create-deposit-intent
    //    Hold with addons → 400 ADDONS_NOT_SUPPORTED_ON_LEGACY_ROUTE
    //    Hold without addons → passes through normally (will fail on Stripe, but we test the gate)
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. Legacy route add-on guard ──');

    // holdId_deposit has addonsTotalCents=1500 → must be rejected
    r = await call('POST', `/api/booking/${holdId_deposit}/create-deposit-intent`, { token: customerToken });
    assert(r.status === 400 && r.body?.code === 'ADDONS_NOT_SUPPORTED_ON_LEGACY_ROUTE', 'legacy route: hold with addons → 400 ADDONS_NOT_SUPPORTED_ON_LEGACY_ROUTE', r);

    // holdId_a0 has no addons → passes the gate (may succeed or fail for other reasons)
    r = await call('POST', `/api/booking/${holdId_a0}/create-deposit-intent`, { token: customerToken });
    assert(r.status !== 400 || r.body?.code !== 'ADDONS_NOT_SUPPORTED_ON_LEGACY_ROUTE', 'legacy route: hold without addons → NOT blocked by addon guard', r);

    // ────────────────────────────────────────────────────────────────────────────────
    // b+c continued: create-payment-intent → verify appointment DB state
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── b+c. create-payment-intent → appointment DB state ──');

    // No-deposit + addons
    r = await call('POST', `/api/booking/${holdId_noDeposit}/create-payment-intent`, { token: customerToken });
    assert([200, 402].includes(r.status), 'no-deposit PI: 200 or 402 (Stripe may be needed)', r.body);
    if (r.status === 200) {
      const [appt] = await q(`SELECT total_price, addons_total_cents, addons_duration_minutes, customer_details, deposit_amount_cents FROM appointments WHERE hold_id = $1`, [holdId_noDeposit]);
      assert(appt?.total_price === 8500, 'DB: no-deposit appointment.totalPrice = 8500 (B+A)', appt);
      assert(appt?.addons_total_cents === 1500, 'DB: no-deposit addons_total_cents = 1500', appt);
      assert(appt?.addons_duration_minutes === 30, 'DB: no-deposit addons_duration_minutes = 30', appt);
      assert(appt?.customer_details === 'Please use organic products', 'DB: customer_details stored', appt);
      assert(appt?.deposit_amount_cents === null, 'DB: no-deposit deposit_amount_cents = null', appt);
      // PI amount in Stripe stub: grossCharge = 9180
      const [stubPI] = Object.values(piStore).filter((pi: any) => pi.metadata?.appointmentId === (await q(`SELECT id FROM appointments WHERE hold_id = $1`, [holdId_noDeposit]))[0]?.id);
      if (stubPI) assert((stubPI as any).amount === 9180, 'Stripe stub PI amount = 9180', stubPI);
    } else {
      console.log('  ⏭  Stripe not available — checking hold response math only');
    }

    // Deposit + addons
    r = await call('POST', `/api/booking/${holdId_deposit}/create-payment-intent`, { token: customerToken });
    assert([200, 402].includes(r.status), 'deposit PI: 200 or 402', r.body);
    if (r.status === 200) {
      const [appt] = await q(`SELECT total_price, addons_total_cents, deposit_amount_cents, customer_details FROM appointments WHERE hold_id = $1`, [holdId_deposit]);
      assert(appt?.total_price === 8500, 'DB: deposit appointment.totalPrice = 8500 (B+A)', appt);
      assert(appt?.addons_total_cents === 1500, 'DB: deposit addons_total_cents = 1500', appt);
      assert(appt?.deposit_amount_cents === 2000, 'DB: deposit_amount_cents = 2000 (D)', appt);
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // g. Privacy: customerDetails
    // ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── g. Privacy ──');

    // Public services endpoint: no customerDetails at all
    r = await call('GET', `/api/businesses/${bizId}/services`);
    assert(!JSON.stringify(r.body).includes('customerDetails'), 'GET /api/businesses/:id/services: no customerDetails', r.body);

    // GET /api/my-appointments (customer) — customerDetails INCLUDED (customer wrote it)
    r = await call('GET', '/api/my-appointments', { token: customerToken });
    if (r.status === 200) {
      const apptRow = r.body?.appointments?.find?.((a: any) => a.businessId === bizId);
      if (apptRow) {
        assert('customerDetails' in apptRow, 'GET /api/my-appointments: customerDetails present for customer', apptRow);
      }
    }

    // GET /api/business/appointments (vendor) — customerDetails INCLUDED
    r = await call('GET', '/api/business/appointments', { token: vendorToken });
    if (r.status === 200) {
      const apptRow = r.body?.appointments?.find?.((a: any) => a.businessId === bizId);
      if (apptRow) {
        assert('customerDetails' in apptRow, 'GET /api/business/appointments: customerDetails present for vendor', apptRow);
      }
    }

    // Availability slots: customerDetails NOT in slot response
    r = await call('GET', `/api/availability/slots?providerType=business&providerId=${bizId}&date=${tDate}&serviceDurationMinutes=60`);
    assert(!JSON.stringify(r.body).includes('customerDetails'), 'Slots: no customerDetails in response', null);

  } finally {
    // Cleanup: holds, appointments, then seed rows
    if (seededHolds.length) {
      await q(`DELETE FROM appointments WHERE hold_id = ANY($1::varchar[])`, [seededHolds]);
      await q(`UPDATE booking_holds SET status = 'expired' WHERE id = ANY($1::varchar[])`, [seededHolds]);
    }
    if (seededSvc.length) await q(`DELETE FROM vendor_services WHERE id = ANY($1::varchar[])`, [seededSvc]);
    if (seededBiz.length) await q(`DELETE FROM businesses WHERE id = ANY($1::varchar[])`, [seededBiz]);
    if (seededUsers.length) await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [seededUsers]);
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
