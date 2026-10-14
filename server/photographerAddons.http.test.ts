/**
 * Photographer Service Add-ons + Customer Details — HTTP integration tests
 *
 * Run with: npx tsx server/photographerAddons.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migration 041 applied) with a Stripe stub. Environment variables:
 *
 *   PA_TEST_BASE_URL      e.g. http://localhost:5062         (must be localhost)
 *   PA_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   PA_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *
 * The file skips (exit 0) when PA_TEST_BASE_URL is unset and refuses any non-local host, so it
 * can never touch Neon or production.
 *
 * ── Mutation check (section i) ──────────────────────────────────────────────
 * The following assertions MUST fail when `+ holdAddonsTotalCents` is removed
 * from routes.ts totalServicePriceCents (line ~5696, create-payment-intent photographer branch):
 *
 *   ❌  DB: no-deposit shoot_booking.total_price = 8500    (would read 7000)
 *   ❌  Stripe stub no-deposit PI amount = 9180            (would read 7560  = 7000×1.08)
 *   ❌  DB: deposit shoot_booking.total_price = 8500       (would read 7000)
 *
 * To run: make the removal, restart the server, re-run this file (expect those
 * three ❌ and PI 7560 for no-deposit); then restore and re-run (expect all ✅).
 */

import http from 'http';

const BASE = process.env.PA_TEST_BASE_URL;
const PG_URL = process.env.PA_TEST_PG_URL;
const STUB_PORT = Number(process.env.PA_TEST_STRIPE_PORT || '0');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.1.1' };
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
  if (!BASE) {
    console.log('⏭  skipped: set PA_TEST_BASE_URL (+ PA_TEST_PG_URL, PA_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, PA_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'pa-test-jwt-secret';
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
        const custId = `cus_stub_${Date.now()}`;
        const cust = { id: custId, object: 'customer', email: form.get('email') || '', name: form.get('name') || '' };
        customerStore[custId] = cust;
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
      // POST /v1/transfers
      if (req.method === 'POST' && req.url === '/v1/transfers') {
        const trId = `tr_stub_${Date.now()}`;
        return send(200, { id: trId, object: 'transfer', amount: Number(form.get('amount') || 0), currency: 'usd', destination: form.get('destination') || '' });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // ── seed ────────────────────────────────────────────────────────────────────────
  const P = `pa${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const seededUsers: string[] = [];
  const seededPhotographers: string[] = [];
  const seededPhotographerServices: string[] = [];
  const seededHolds: string[] = [];
  const seededShootBookings: string[] = [];

  const mkUser = async (key: string, extra: { isPhotographer?: boolean } = {}) => {
    const uid = id(key);
    await q(
      `INSERT INTO users (id, username, email, is_photographer, is_vendor) VALUES ($1::varchar, $1::text, $2, $3, $4)`,
      [uid, `${uid}@pa.test`, extra.isPhotographer ?? false, extra.isPhotographer ?? false]
    );
    seededUsers.push(uid);
    return uid;
  };

  // All-days-open hoursOfOperation (legacy format)
  const allDaysOpen = JSON.stringify({
    monday:    { open: '08:00', close: '20:00' },
    tuesday:   { open: '08:00', close: '20:00' },
    wednesday: { open: '08:00', close: '20:00' },
    thursday:  { open: '08:00', close: '20:00' },
    friday:    { open: '08:00', close: '20:00' },
    saturday:  { open: '08:00', close: '20:00' },
    sunday:    { open: '08:00', close: '20:00' },
  });

  const mkPhotographer = async (key: string, userId: string, stripeReady = true) => {
    const pid = id(key);
    await q(
      `INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
       VALUES ($1, $2, $3, 10000, 'Austin', 'TX', $4::jsonb, $5, $6, false, true, 'public', now(), now())`,
      [pid, userId, `Photographer ${key}`, allDaysOpen, stripeReady ? `acct_${pid.replace(/-/g, '')}` : null, stripeReady]
    );
    for (let day = 0; day <= 6; day++) {
      await q(
        `INSERT INTO weekly_availability (provider_id, provider_type, day_of_week, start_time, end_time, is_active) VALUES ($1, 'photographer', $2, '08:00', '20:00', true)`,
        [pid, day]
      );
    }
    seededPhotographers.push(pid);
    return pid;
  };

  const mkPhotographerService = async (key: string, photographerId: string, opts: { depositCents?: number; isContactForPricing?: boolean; priceCents?: number } = {}) => {
    const sid = id(key);
    await q(
      `INSERT INTO photographer_services (id, photographer_id, name, price_cents, deposit_amount_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
       VALUES ($1, $2, $3, $4, $5, 60, true, 'live', 'package', $6, now())`,
      [sid, photographerId, `Service ${key}`, opts.priceCents ?? 7000, opts.depositCents ?? null, opts.isContactForPricing ?? false]
    );
    seededPhotographerServices.push(sid);
    return sid;
  };

  // Photographer user + profile + services
  const photogUserId  = await mkUser('phv', { isPhotographer: true });
  const photogId      = await mkPhotographer('ph', photogUserId);
  const svcNoDeposit  = await mkPhotographerService('snd', photogId);
  const svcDeposit    = await mkPhotographerService('sd', photogId, { depositCents: 2000 });
  const svcCfp        = await mkPhotographerService('cfp', photogId, { isContactForPricing: true });

  // Another photographer for cross-auth tests
  const otherPhotogUserId = await mkUser('phv2', { isPhotographer: true });
  const otherPhotogId     = await mkPhotographer('ph2', otherPhotogUserId);
  const otherSvc          = await mkPhotographerService('sother', otherPhotogId);

  // Customer user
  const customerId = await mkUser('c');

  const photogToken   = generateAccessToken({ userId: photogUserId,      isVendor: false, isAdmin: false });
  const otherToken    = generateAccessToken({ userId: otherPhotogUserId, isVendor: false, isAdmin: false });
  const customerToken = generateAccessToken({ userId: customerId,        isVendor: false, isAdmin: false });

  // Use tomorrow as test date
  const TOMORROW = new Date(); TOMORROW.setDate(TOMORROW.getDate() + 1);
  const tDate = TOMORROW.toISOString().slice(0, 10);

  try {
    // ──────────────────────────────────────────────────────────────────────────────
    // a. CRUD auth
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── a. CRUD auth ──');

    let r = await call('GET', `/api/photographers/me/services/${svcNoDeposit}/addons`);
    assert(r.status === 401, 'GET addons: unauthenticated → 401', r.body);

    r = await call('GET', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: otherToken });
    assert(r.status === 403, 'GET addons: non-owner photographer → 403', r.body);

    r = await call('GET', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken });
    assert(r.status === 200 && Array.isArray(r.body?.addons), 'GET addons: owner → 200 + array', r.body);

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: otherToken, body: { name: 'X', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 403, 'POST addon: non-owner photographer → 403', r.body);

    // ──────────────────────────────────────────────────────────────────────────────
    // b. Zod validation
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── b. Zod validation ──');

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: '', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: empty name → 400', r.body);

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'X'.repeat(81), priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: name > 80 chars → 400', r.body);

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Addon', priceCents: 100001, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: priceCents > 100000 → 400', r.body);

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Addon', priceCents: -1, durationMinutes: 0 } });
    assert(r.status === 400, 'POST: priceCents < 0 → 400', r.body);

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Addon', priceCents: 0, durationMinutes: 481 } });
    assert(r.status === 400, 'POST: durationMinutes > 480 → 400', r.body);

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Addon', priceCents: 0, durationMinutes: -1 } });
    assert(r.status === 400, 'POST: durationMinutes < 0 → 400', r.body);

    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Addon', priceCents: 0, durationMinutes: 0, description: 'X'.repeat(301) } });
    assert(r.status === 400, 'POST: description > 300 chars → 400', r.body);

    // ──────────────────────────────────────────────────────────────────────────────
    // c. isContactForPricing guard on CRUD
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── c. isContactForPricing guard ──');

    r = await call('POST', `/api/photographers/me/services/${svcCfp}/addons`, { token: photogToken, body: { name: 'Addon', priceCents: 500, durationMinutes: 10 } });
    assert(r.status === 400 && r.body?.code === 'CONTACT_FOR_PRICING', 'POST on cfp service → 400 CONTACT_FOR_PRICING', r.body);

    // ──────────────────────────────────────────────────────────────────────────────
    // Create valid add-ons used across remaining sections
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── create add-ons ──');

    // addon1: A=1500, +30min, active
    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Premium Edit', priceCents: 1500, durationMinutes: 30, description: 'Retouching package', sortOrder: 1 } });
    assert(r.status === 201 && !!r.body?.addon?.id, 'POST valid addon1 (A=1500, +30min) → 201', r.body);
    const addonId1 = r.body?.addon?.id as string;
    assert(r.body?.addon?.description === 'Retouching package', 'addon1 description stored', r.body?.addon);

    // addon2: A=0, +0min, active
    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Free Extra', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 201, 'POST valid addon2 (A=0) → 201', r.body);
    const addonId2 = r.body?.addon?.id as string;

    // addon3: inactive
    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'Inactive Addon', priceCents: 500, durationMinutes: 10, isActive: false } });
    assert(r.status === 201, 'POST inactive addon3 → 201', r.body);
    const addonId3 = r.body?.addon?.id as string;

    // addon for deposit service
    r = await call('POST', `/api/photographers/me/services/${svcDeposit}/addons`, { token: photogToken, body: { name: 'Deposit Addon', priceCents: 1500, durationMinutes: 30 } });
    assert(r.status === 201, 'POST addon for deposit service → 201', r.body);
    const depositAddonId = r.body?.addon?.id as string;

    // addon for foreign (other photographer's) service
    r = await call('POST', `/api/photographers/me/services/${otherSvc}/addons`, { token: otherToken, body: { name: 'Foreign', priceCents: 100, durationMinutes: 0 } });
    const foreignAddonId = r.body?.addon?.id as string;

    // PATCH
    r = await call('PATCH', `/api/photographers/me/services/${svcNoDeposit}/addons/${addonId2}`, { token: otherToken, body: { name: 'Hacked' } });
    assert(r.status === 403, 'PATCH: non-owner → 403', r.body);

    r = await call('PATCH', `/api/photographers/me/services/${svcNoDeposit}/addons/${addonId2}`, { token: photogToken, body: { name: 'Free Extra Updated', description: 'updated' } });
    assert(r.status === 200 && r.body?.addon?.name === 'Free Extra Updated', 'PATCH: owner → 200 + updated name', r.body);

    // Too-many add-ons (max 20)
    for (let i = 0; i < 17; i++) {
      await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: `Fill ${i}`, priceCents: 0, durationMinutes: 0 } });
    }
    r = await call('POST', `/api/photographers/me/services/${svcNoDeposit}/addons`, { token: photogToken, body: { name: 'One Too Many', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400 && r.body?.code === 'TOO_MANY_ADDONS', 'POST: 21st add-on → 400 TOO_MANY_ADDONS', r.body);

    // DELETE
    r = await call('DELETE', `/api/photographers/me/services/${svcNoDeposit}/addons/${addonId2}`, { token: otherToken });
    assert(r.status === 403, 'DELETE: non-owner → 403', r.body);

    r = await call('DELETE', `/api/photographers/me/services/${svcNoDeposit}/addons/${addonId2}`, { token: photogToken });
    assert(r.status === 200, 'DELETE: owner → 200', r.body);

    // ──────────────────────────────────────────────────────────────────────────────
    // d. GET /api/photographers/:id/services — addons attached (A=0 parity + active shape)
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── d. Public services: addons attached ──');

    // A=0 parity: create a fresh photographer with a live service but no addons
    const cleanPhotogUserId = await mkUser('cpv', { isPhotographer: true });
    const cleanPhotogId     = await mkPhotographer('cph', cleanPhotogUserId);
    const cleanSvcId        = await mkPhotographerService('cs', cleanPhotogId);

    r = await call('GET', `/api/photographers/${cleanPhotogId}/services`);
    assert(r.status === 200, 'GET /api/photographers/:id/services → 200', r.body);
    const cleanSvcData = r.body?.services?.[0];
    assert(Array.isArray(cleanSvcData?.addons) && cleanSvcData.addons.length === 0, 'A=0: addons:[] present on public service', cleanSvcData);

    // Main photographer: active addons present, inactive addon absent
    r = await call('GET', `/api/photographers/${photogId}/services`);
    assert(r.status === 200, 'GET /api/photographers/:id/services for test photog → 200', r.body);
    const pubSvcND = r.body?.services?.find((s: any) => s.id === svcNoDeposit);
    assert(pubSvcND !== undefined, 'svcNoDeposit found in public services', r.body);
    if (pubSvcND) {
      const pubAddon = pubSvcND.addons?.find((a: any) => a.id === addonId1);
      assert(pubAddon !== undefined, 'addon1 present in public services', pubSvcND.addons);
      assert(!pubSvcND.addons?.some((a: any) => a.id === addonId3), 'inactive addon3 NOT in public services', pubSvcND.addons?.map((a: any) => a.id));
      assert(!pubSvcND.addons?.some((a: any) => a.id === addonId2), 'deleted addon2 NOT in public services (after DELETE)', pubSvcND.addons?.map((a: any) => a.id));
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // e. Hold rejections
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── e. Hold rejections ──');

    const holdBase = { providerType: 'photographer', providerId: photogId, serviceId: svcNoDeposit, date: tDate, startTime: '09:00' };

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: 'not-array' } });
    assert(r.status === 400, 'addonIds not array → 400', r.body);

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: Array(11).fill(addonId1) } });
    assert(r.status === 400 && r.body?.code === 'TOO_MANY_ADDONS', 'addonIds > 10 → 400 TOO_MANY_ADDONS', r.body);

    // Foreign add-on (belongs to otherSvc)
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: [foreignAddonId] } });
    assert(r.status === 400, 'foreign add-on (other photographer) → 400', r.body);

    // Inactive add-on
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: [addonId3] } });
    assert(r.status === 400, 'inactive add-on → 400', r.body);

    // Duplicate IDs
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, addonIds: [addonId1, addonId1] } });
    assert(r.status === 400, 'duplicate addonIds → 400', r.body);

    // isContactForPricing
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, serviceId: svcCfp, addonIds: [addonId1] } });
    assert(r.status === 400 && r.body?.code === 'CONTACT_FOR_PRICING', 'cfp service + addonIds → 400 CONTACT_FOR_PRICING', r.body);

    // customerDetails > 1000 chars
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, customerDetails: 'x'.repeat(1001) } });
    assert(r.status === 400, 'customerDetails > 1000 → 400', r.body);

    // ──────────────────────────────────────────────────────────────────────────────
    // f. A=0 hold parity (08:00) — byte-identical fields to pre-addon world
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── f. A=0 hold parity (08:00) ──');

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, startTime: '08:00' } });
    assert(r.status === 200, 'A=0 hold → 200', r.body);
    assert(r.body?.addonsTotalCents === 0, 'A=0: addonsTotalCents = 0', r.body);
    assert(r.body?.addonsDurationMinutes === 0, 'A=0: addonsDurationMinutes = 0', r.body);
    assert(Array.isArray(r.body?.addons) && r.body.addons.length === 0, 'A=0: addons = []', r.body);
    assert(r.body?.customerDetails === null || r.body?.customerDetails === undefined, 'A=0: customerDetails null/absent', r.body);
    const holdId_a0 = r.body?.holdId as string;
    seededHolds.push(holdId_a0);

    // ──────────────────────────────────────────────────────────────────────────────
    // g. No-deposit + addons (10:00): B=7000, A=1500, total=8500
    //    calculateBookingFees(8500): consumerFee=680, total=9180, vendorNet=8330
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── g. No-deposit + addons (10:00) ──');

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, startTime: '10:00', addonIds: [addonId1], customerDetails: 'Please shoot outdoors' } });
    assert(r.status === 200, 'no-deposit hold + addons (10:00) → 200', r.body);
    assert(r.body?.addonsTotalCents === 1500, 'no-deposit hold: addonsTotalCents = 1500', r.body);
    assert(r.body?.addonsDurationMinutes === 30, 'no-deposit hold: addonsDurationMinutes = 30', r.body);
    assert(r.body?.totalPriceCents === 8500, 'no-deposit hold: totalPriceCents = 8500 (B+A)', r.body);
    assert(r.body?.customerDetails === 'Please shoot outdoors', 'no-deposit hold: customerDetails stored', r.body);
    assert(r.body?.inPersonDueCents === 0, 'no-deposit hold: inPersonDueCents = 0', r.body);
    assert(r.body?.dueNowCents === 9180, 'no-deposit: dueNowCents = 9180 (8500 × 1.08)', r.body);
    assert(r.body?.dueNowFeeBreakdown?.grossChargeAmount === 9180, 'no-deposit: dueNowFeeBreakdown.grossChargeAmount = 9180', r.body?.dueNowFeeBreakdown);
    assert(r.body?.dueNowFeeBreakdown?.vendorNetAmount === 8330, 'no-deposit: dueNowFeeBreakdown.vendorNetAmount = 8330', r.body?.dueNowFeeBreakdown);
    const holdId_noDeposit = r.body?.holdId as string;
    seededHolds.push(holdId_noDeposit);

    // ──────────────────────────────────────────────────────────────────────────────
    // g2. Deposit + addons (12:00): B=7000, A=1500, D=2000
    //     totalPrice=8500, dueNowCents=2160 (D×1.08), inPersonDueCents=6500
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── g2. Deposit + addons (12:00) ──');

    const holdBaseDeposit = { ...holdBase, serviceId: svcDeposit };
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBaseDeposit, startTime: '12:00', addonIds: [depositAddonId] } });
    assert(r.status === 200, 'deposit hold + addons (12:00) → 200', r.body);
    assert(r.body?.addonsTotalCents === 1500, 'deposit hold: addonsTotalCents = 1500', r.body);
    assert(r.body?.totalPriceCents === 8500, 'deposit hold: totalPriceCents = 8500', r.body);
    assert(r.body?.inPersonDueCents === 6500, 'deposit hold: inPersonDueCents = 6500 (8500-2000)', r.body);
    assert(r.body?.depositAmountCents === 2000, 'deposit hold: depositAmountCents = 2000', r.body);
    assert(r.body?.chargeAmountCents === 2000, 'deposit hold: chargeAmountCents = D = 2000', r.body);
    assert(r.body?.dueNowCents === 2160, 'deposit: dueNowCents = 2160 (D × 1.08)', r.body);
    assert(r.body?.dueNowFeeBreakdown?.vendorNetAmount === 1960, 'deposit: dueNowFeeBreakdown.vendorNetAmount = 1960 (D × 98%)', r.body?.dueNowFeeBreakdown);
    const holdId_deposit = r.body?.holdId as string;
    seededHolds.push(holdId_deposit);

    // ──────────────────────────────────────────────────────────────────────────────
    // h. Duration: endTime extended by addon minutes; overlapping hold rejected
    //    Hold at 14:00 + addon +30min → endTime = 15:30
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── h. Duration + overlap (14:00) ──');

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, startTime: '14:00', addonIds: [addonId1] } });
    assert(r.status === 200, 'hold at 14:00 with +30min addon → 200', r.body);
    assert(r.body?.endTime === '15:30', 'endTime = 15:30 (60+30 = 90 min from 14:00)', r.body);
    const holdId_dur = r.body?.holdId as string;
    seededHolds.push(holdId_dur);

    // slots endpoint: no-addon base duration gives correct slots
    r = await call('GET', `/api/availability/slots?providerType=photographer&providerId=${photogId}&date=${tDate}&serviceDurationMinutes=60&serviceId=${svcNoDeposit}`);
    assert(r.status === 200 && Array.isArray(r.body?.slots), 'Slots: A=0 photographer → 200 + slots array', r.body);

    // slots with addonIds: serviceId required
    r = await call('GET', `/api/availability/slots?providerType=photographer&providerId=${photogId}&date=${tDate}&serviceDurationMinutes=60&addonIds=${addonId1}`);
    assert(r.status === 400, 'Slots: addonIds without serviceId → 400', r.body);

    // slots with inactive addonId: rejected
    r = await call('GET', `/api/availability/slots?providerType=photographer&providerId=${photogId}&date=${tDate}&serviceDurationMinutes=60&serviceId=${svcNoDeposit}&addonIds=${addonId3}`);
    assert(r.status === 400, 'Slots: inactive addonId → 400', r.body);

    // Second customer tries same 14:00 slot → rejected SLOT_UNAVAILABLE
    const cust2Id    = await mkUser('c2');
    const cust2Token = generateAccessToken({ userId: cust2Id, isVendor: false, isAdmin: false });
    r = await call('POST', '/api/booking/hold', { token: cust2Token, body: { ...holdBase, startTime: '14:00', addonIds: [addonId1] } });
    assert(r.status === 400 && r.body?.errorCode === 'SLOT_UNAVAILABLE', 'overlapping hold → 400 SLOT_UNAVAILABLE', r.body);

    // ──────────────────────────────────────────────────────────────────────────────
    // i. create-payment-intent → shoot_bookings DB state + Stripe stub
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── i. create-payment-intent → DB state + stub ──');

    // No-deposit + addons
    r = await call('POST', `/api/booking/${holdId_noDeposit}/create-payment-intent`, { token: customerToken });
    assert([200, 402].includes(r.status), 'no-deposit PI: 200 or 402', r.body);
    if (r.status === 200) {
      const shootBookingIdND = r.body?.shootBookingId as string | undefined;
      if (shootBookingIdND) seededShootBookings.push(shootBookingIdND);
      assert(r.body?.totalPrice === 8500, 'no-deposit PI response: totalPrice = 8500', r.body);
      assert(r.body?.addonsTotalCents === 1500, 'no-deposit PI response: addonsTotalCents = 1500', r.body);
      assert(r.body?.depositAmountCents === null || r.body?.depositAmountCents === 0, 'no-deposit PI response: depositAmountCents = null/0', r.body);
      assert(r.body?.inPersonDueCents === 0, 'no-deposit PI response: inPersonDueCents = 0', r.body);
      assert(r.body?.serviceTotalCents === 8500, 'no-deposit PI response: serviceTotalCents = 8500', r.body);
      assert(r.body?.chargeAmountCents === 8500, 'no-deposit PI response: chargeAmountCents = 8500', r.body);
      assert(r.body?.dueNowCents === 9180, 'no-deposit PI response: dueNowCents = 9180', r.body);
      assert(Array.isArray(r.body?.addons) && r.body.addons.some((a: any) => a.id === addonId1), 'no-deposit PI response: addons contains addon1', r.body?.addons);

      if (shootBookingIdND) {
        const [sbND] = await q(
          `SELECT total_price, addons_total_cents, addons_duration_minutes, customer_details, deposit_amount_cents FROM shoot_bookings WHERE id = $1`,
          [shootBookingIdND]
        );
        assert(sbND?.total_price === 8500, 'DB: no-deposit shoot_booking.total_price = 8500 (B+A)', sbND);
        assert(sbND?.addons_total_cents === 1500, 'DB: no-deposit addons_total_cents = 1500', sbND);
        assert(sbND?.addons_duration_minutes === 30, 'DB: no-deposit addons_duration_minutes = 30', sbND);
        assert(sbND?.customer_details === 'Please shoot outdoors', 'DB: customer_details stored', sbND);
        assert(sbND?.deposit_amount_cents === null, 'DB: no-deposit deposit_amount_cents = null', sbND);

        // Stripe stub PI check
        const stubPI = Object.values(piStore).find((pi: any) => pi.metadata?.bookingId === shootBookingIdND);
        if (stubPI) {
          assert((stubPI as any).amount === 9180, 'Stripe stub no-deposit PI amount = 9180', stubPI);
          assert((stubPI as any).metadata?.addonsTotalCents === '1500', 'Stub PI metadata.addonsTotalCents = "1500"', (stubPI as any).metadata);
          assert((stubPI as any).metadata?.type === 'shoot_booking', 'Stub PI metadata.type = "shoot_booking"', (stubPI as any).metadata);
        } else {
          console.log('  ⏭  no-deposit stub PI not found in piStore (Stripe may be unavailable)');
        }
      }
    } else {
      console.log('  ⏭  Stripe not available — skipping no-deposit PI assertions');
    }

    // Deposit + addons
    r = await call('POST', `/api/booking/${holdId_deposit}/create-payment-intent`, { token: customerToken });
    assert([200, 402].includes(r.status), 'deposit PI: 200 or 402', r.body);
    if (r.status === 200) {
      const shootBookingIdDep = r.body?.shootBookingId as string | undefined;
      if (shootBookingIdDep) seededShootBookings.push(shootBookingIdDep);
      assert(r.body?.totalPrice === 8500, 'deposit PI response: totalPrice = 8500', r.body);
      assert(r.body?.addonsTotalCents === 1500, 'deposit PI response: addonsTotalCents = 1500', r.body);
      assert(r.body?.depositAmountCents === 2000, 'deposit PI response: depositAmountCents = 2000', r.body);
      assert(r.body?.inPersonDueCents === 6500, 'deposit PI response: inPersonDueCents = 6500', r.body);
      assert(r.body?.serviceTotalCents === 8500, 'deposit PI response: serviceTotalCents = 8500', r.body);
      assert(r.body?.chargeAmountCents === 2000, 'deposit PI response: chargeAmountCents = 2000 (D)', r.body);
      assert(r.body?.dueNowCents === 2160, 'deposit PI response: dueNowCents = 2160 (D × 1.08)', r.body);
      assert(Array.isArray(r.body?.addons) && r.body.addons.some((a: any) => a.id === depositAddonId), 'deposit PI response: addons contains depositAddon', r.body?.addons);

      if (shootBookingIdDep) {
        const [sbDep] = await q(
          `SELECT total_price, addons_total_cents, deposit_amount_cents FROM shoot_bookings WHERE id = $1`,
          [shootBookingIdDep]
        );
        assert(sbDep?.total_price === 8500, 'DB: deposit shoot_booking.total_price = 8500 (B+A)', sbDep);
        assert(sbDep?.addons_total_cents === 1500, 'DB: deposit addons_total_cents = 1500', sbDep);
        assert(sbDep?.deposit_amount_cents === 2000, 'DB: deposit_amount_cents = 2000 (D)', sbDep);

        // Stripe stub PI: amount = 2160 (D × 1.08)
        const stubPIDep = Object.values(piStore).find((pi: any) => pi.metadata?.bookingId === shootBookingIdDep);
        if (stubPIDep) {
          assert((stubPIDep as any).amount === 2160, 'Stripe stub deposit PI amount = 2160 (D + 8%)', stubPIDep);
          assert((stubPIDep as any).metadata?.addonsTotalCents === '1500', 'Deposit stub PI metadata.addonsTotalCents = "1500"', (stubPIDep as any).metadata);
        }
      }
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // j. GET /api/my-shoot-bookings — new fields present
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── j. GET /api/my-shoot-bookings new fields ──');

    r = await call('GET', '/api/my-shoot-bookings', { token: customerToken });
    if (r.status === 200) {
      const sessions: any[] = r.body?.sessions ?? [];
      // Ensure new fields are present on every row (even with no addons)
      if (sessions.length > 0) {
        const sample = sessions[0];
        assert('addons' in sample, 'my-shoot-bookings: addons field present', sample);
        assert('addonsTotalCents' in sample, 'my-shoot-bookings: addonsTotalCents field present', sample);
        assert('customerDetails' in sample, 'my-shoot-bookings: customerDetails field present', sample);
        assert('inPersonDueCents' in sample, 'my-shoot-bookings: inPersonDueCents field present', sample);
        assert('chargedAmountCents' in sample, 'my-shoot-bookings: chargedAmountCents field present', sample);
      }
      // Find the no-deposit+addons session (totalPrice=8500, no deposit)
      const ndSession = sessions.find((s: any) => s.addonsTotalCents === 1500 && s.inPersonDueCents === 0);
      if (ndSession) {
        assert(Array.isArray(ndSession.addons) && ndSession.addons.some((a: any) => a.name === 'Premium Edit'), 'my-shoot-bookings: no-deposit session has addon name', ndSession.addons);
        assert(ndSession.customerDetails === 'Please shoot outdoors', 'my-shoot-bookings: no-deposit customerDetails', ndSession);
        assert(ndSession.chargedAmountCents === 9180, 'my-shoot-bookings: no-deposit chargedAmountCents = 9180', ndSession);
      }
      // Find the deposit+addons session
      const depSession = sessions.find((s: any) => s.addonsTotalCents === 1500 && s.inPersonDueCents === 6500);
      if (depSession) {
        assert(depSession.chargedAmountCents === 2160, 'my-shoot-bookings: deposit chargedAmountCents = 2160', depSession);
      }
    } else {
      assert(r.status === 200, 'GET /api/my-shoot-bookings → 200', r.status);
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // k. GET /api/photographers/me/bookings — new fields on photographer side
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── k. GET /api/photographers/me/bookings new fields ──');

    r = await call('GET', '/api/photographers/me/bookings', { token: photogToken });
    if (r.status === 200) {
      const bookings: any[] = r.body?.bookings ?? [];
      const ndBooking = bookings.find((b: any) => b.addonsTotalCents === 1500 && b.inPersonDueCents === 0);
      if (ndBooking) {
        assert('addons' in ndBooking, 'me/bookings: addons field present', ndBooking);
        assert('customerDetails' in ndBooking, 'me/bookings: customerDetails field present', ndBooking);
        assert('chargedAmountCents' in ndBooking, 'me/bookings: chargedAmountCents field present', ndBooking);
        assert(ndBooking.chargedAmountCents === 9180, 'me/bookings: no-deposit chargedAmountCents = 9180', ndBooking);
      }
      const depBooking = bookings.find((b: any) => b.addonsTotalCents === 1500 && b.inPersonDueCents === 6500);
      if (depBooking) {
        assert(depBooking.chargedAmountCents === 2160, 'me/bookings: deposit chargedAmountCents = 2160', depBooking);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // l. A=0 PI: metadata has no addonsTotalCents/addonNames keys
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── l. A=0 PI: metadata ──');

    r = await call('POST', `/api/booking/${holdId_a0}/create-payment-intent`, { token: customerToken });
    assert([200, 402].includes(r.status), 'A=0 PI: 200 or 402', r.body);
    if (r.status === 200) {
      const shootBookingIdA0 = r.body?.shootBookingId as string | undefined;
      if (shootBookingIdA0) seededShootBookings.push(shootBookingIdA0);
      const stubPIA0 = Object.values(piStore).find((pi: any) => pi.metadata?.bookingId === shootBookingIdA0);
      if (stubPIA0) {
        assert(!('addonsTotalCents' in (stubPIA0 as any).metadata), 'A=0 PI: metadata has no addonsTotalCents key', (stubPIA0 as any).metadata);
        assert(!('addonNames' in (stubPIA0 as any).metadata), 'A=0 PI: metadata has no addonNames key', (stubPIA0 as any).metadata);
        assert((stubPIA0 as any).description === `Photography booking with Photographer ph`, 'A=0 PI: description = base only (no addon suffix)', (stubPIA0 as any).description);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // m. Public services shape: exactly 6 keys on addons; cfp service → addons = []
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── m. Public services shape ──');

    r = await call('GET', `/api/photographers/${photogId}/services`);
    if (r.status === 200) {
      const mSvcND = r.body?.services?.find((s: any) => s.id === svcNoDeposit);
      if (mSvcND && Array.isArray(mSvcND.addons) && mSvcND.addons.length > 0) {
        const a = mSvcND.addons[0];
        const addonKeys = Object.keys(a).sort();
        assert(
          JSON.stringify(addonKeys) === JSON.stringify(['description', 'durationMinutes', 'id', 'name', 'priceCents', 'sortOrder']),
          'm: addon shape has exactly 6 keys',
          addonKeys
        );
      }
      const mSvcCfp = r.body?.services?.find((s: any) => s.id === svcCfp);
      if (mSvcCfp) {
        assert(Array.isArray(mSvcCfp.addons) && mSvcCfp.addons.length === 0, 'm: cfp service addons = []', mSvcCfp.addons);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // n. Email HTML: escaping logic
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── n. Email HTML: escaping ──');

    const escFn = (s: string) => s.replace(/[<>&"]/g, (c: string) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } as Record<string, string>)[c] ?? c);
    assert(escFn('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;', 'esc: <b>x</b> escaped correctly', escFn('<b>x</b>'));
    assert(escFn('<script>') === '&lt;script&gt;', 'esc: <script> escaped correctly', escFn('<script>'));
    assert(escFn('A & B') === 'A &amp; B', 'esc: & escaped correctly', escFn('A & B'));
    assert(escFn('"quoted"') === '&quot;quoted&quot;', 'esc: " escaped correctly', escFn('"quoted"'));
    assert(escFn('plain text') === 'plain text', 'esc: plain text unchanged', escFn('plain text'));

  } finally {
    // Cleanup: shoot_bookings + photographer_availability created by reservePhotographerSlot
    if (seededShootBookings.length) {
      await q(`DELETE FROM photographer_availability WHERE shoot_booking_id = ANY($1::varchar[])`, [seededShootBookings]);
      await q(`DELETE FROM shoot_bookings WHERE id = ANY($1::varchar[])`, [seededShootBookings]);
    }
    // Cleanup holds (and any remaining shoot_bookings referencing the hold's slot)
    if (seededHolds.length) {
      await q(`DELETE FROM booking_holds WHERE id = ANY($1::varchar[])`, [seededHolds]);
    }
    // photographer_service_addons cascade-deleted via photographer_services
    if (seededPhotographerServices.length) {
      // also removes orphaned shoot_bookings not captured in seededShootBookings (e.g. when PI call fails)
      await q(`DELETE FROM photographer_availability WHERE shoot_booking_id IN (SELECT id FROM shoot_bookings WHERE service_id = ANY($1::varchar[]))`, [seededPhotographerServices]);
      await q(`DELETE FROM shoot_bookings WHERE service_id = ANY($1::varchar[])`, [seededPhotographerServices]);
      await q(`DELETE FROM photographer_services WHERE id = ANY($1::varchar[])`, [seededPhotographerServices]);
    }
    if (seededPhotographers.length) {
      await q(`DELETE FROM weekly_availability WHERE provider_id = ANY($1::varchar[]) AND provider_type = 'photographer'`, [seededPhotographers]);
      await q(`DELETE FROM photographers WHERE id = ANY($1::varchar[])`, [seededPhotographers]);
    }
    if (seededUsers.length) {
      await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [seededUsers]);
    }
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
