/**
 * Estimate requests + service cities + request only services (migration 066) — HTTP integration tests.
 *
 * Run with: npx tsx server/estimateRequests.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema +
 * migration 066 applied) with a Stripe stub, exactly like server/holdBookable.http.test.ts:
 *   ER_TEST_BASE_URL      e.g. http://localhost:5062   (must be localhost)
 *   ER_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   ER_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 * Skips (exit 0) when ER_TEST_BASE_URL is unset; refuses any non-local host. RESEND_API_KEY must be unset on the
 * server, so no email ever leaves (the request must still be saved when email fails).
 *
 * What it proves:
 *  - a request only service is listed but can never be held or validated (same message as any unbookable service);
 *    switching it back makes it bookable again
 *  - service save accepts serviceCities + requestOnly, cleans the list, and a save without them changes nothing
 *  - my-business accepts serviceCities (cleaned), refuses a bad list, public business info returns it
 *  - estimate submit: sign in required, city must be served, plan must be live, this business's, offered there
 *  - the request is saved with its details; the owner sees it, another vendor never does, admin does with x-business-id
 *  - status + notes update; owner naming another business is refused
 *  - 5 submits per hour per account, then 429
 */

import http from 'http';

const BASE = process.env.ER_TEST_BASE_URL;
const PG_URL = process.env.ER_TEST_PG_URL;
const STUB_PORT = Number(process.env.ER_TEST_STRIPE_PORT || '0');
const MSG = "This service isn't available to book right now. Please choose another service.";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.98.7.${Math.floor(Math.random() * 200) + 1}`, ...(o.headers ?? {}) };
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
    console.log('⏭  skipped: set ER_TEST_BASE_URL (+ ER_TEST_PG_URL, ER_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, ER_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'er-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // Stripe stub: nothing in these flows should reach Stripe; any call is answered 404 and counted.
  let stripeCalls = 0;
  const stub = http.createServer((req, res) => {
    req.on('data', () => {}); req.on('end', () => { stripeCalls++; res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'stub' } })); });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const P = `er${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];

  const mkUser = async (key: string, o: { isVendor?: boolean; email?: string } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, o.email ?? `${uid}@er.test`, o.isVendor ?? false]);
    users.push(uid);
    return uid;
  };
  const mkBiz = async (key: string, ownerId: string, cities: string[] = []) => {
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, service_cities) VALUES ($1, $2, $3, 'moving', 'approved', $4, true, $5)`,
      [bid, ownerId, `Biz ${key}`, `acct_${bid.replace(/-/g, '')}`, cities]);
    for (let dow = 0; dow <= 6; dow++) {
      await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, '08:00', '20:00', true)`, [id(`wa-${key}-${dow}`), bid, dow]);
    }
    bizs.push(bid);
    return bid;
  };
  const mkSvc = async (key: string, bizId: string, o: { status?: string; requestOnly?: boolean; cities?: string[] } = {}) => {
    const sid = id(key);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, request_only, service_cities) VALUES ($1, $2, $3, 30000, 180, true, $4, $5, $6)`,
      [sid, bizId, `Plan ${key}`, o.status ?? 'live', o.requestOnly ?? false, o.cities ?? []]);
    return sid;
  };

  const vendorR = await mkUser('vr', { isVendor: true });
  const bizR = await mkBiz('br', vendorR, ['Norfolk', 'Chesapeake']);
  // Active plan, so the business is public (public services list + public business info).
  const [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true ORDER BY sort_order, created_at LIMIT 1`);
  if (!tier) throw new Error('No active subscription_tiers in the scratch DB');
  await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, stripe_subscription_id, current_period_end) VALUES ($1, $2, $3, $4, 'active', 'sub_er_r', now() + interval '30 days')`,
    [id('sub-r'), vendorR, bizR, tier.id]);
  const sEverywhere = await mkSvc('s-all', bizR, { requestOnly: true });
  const sNorfolk = await mkSvc('s-nor', bizR, { requestOnly: true, cities: ['Norfolk'] });
  const sDraft = await mkSvc('s-draft', bizR, { status: 'draft', requestOnly: true });
  const sBookable = await mkSvc('s-book', bizR);

  const vendorO = await mkUser('vo', { isVendor: true });
  const bizO = await mkBiz('bo', vendorO);
  const sOther = await mkSvc('s-other', bizO);

  const customer = await mkUser('c');
  const customer2 = await mkUser('c2');
  const admin = await mkUser('adm', { email: 'info@goutsyde.com' });
  const tok = (u: string, o: { isVendor?: boolean } = {}) => generateAccessToken({ userId: u, isVendor: o.isVendor ?? false, isAdmin: false });
  const tC = tok(customer), tC2 = tok(customer2), tR = tok(vendorR, { isVendor: true }), tO = tok(vendorO, { isVendor: true }), tA = tok(admin);

  let dayOffset = 2;
  const nextSlot = () => { dayOffset += 1; const d = new Date(); d.setDate(d.getDate() + dayOffset); return { date: d.toISOString().slice(0, 10), startTime: '10:00' }; };
  const hold = (serviceId: string) => call('POST', '/api/booking/hold', { token: tC, body: { ...nextSlot(), providerType: 'business', providerId: bizR, serviceId } });
  const refused = (r: { status: number; body: any }) => r.status === 400 && r.body?.errorCode === 'SERVICE_UNAVAILABLE' && r.body?.error === MSG;
  const held = (r: { status: number; body: any }) => (r.status === 200 || r.status === 201) && !!(r.body?.holdId ?? r.body?.hold?.id ?? r.body?.id);

  const form = (o: Record<string, unknown> = {}) => ({
    businessId: bizR, city: 'Norfolk', name: 'Test Customer', email: 'customer@er.test', phone: '757 555 0100',
    preferredDate: '2026-12-01', details: { moveType: 'Standard Move', homeSize: '2 Bedroom', fromAddress: '1 A St', toAddress: '2 B St', notes: '<b>piano</b>' },
    source: 'royal-elite-site', ...o,
  });

  try {
    console.log('\n── 1. request only services are listed but never held ──');
    let r = await hold(sEverywhere);
    assert(refused(r), 'request only service → hold refused with the usual message', r);
    r = await call('POST', '/api/booking/validate', { body: { ...nextSlot(), providerType: 'business', providerId: bizR, serviceId: sEverywhere } });
    assert(r.status === 400 && r.body?.valid === false && r.body?.errorCode === 'SERVICE_UNAVAILABLE', 'request only service → validate says not bookable (same 400 as any unbookable service)', r);
    r = await hold(sBookable);
    assert(held(r), 'normal live service of the same business → hold created (unchanged)', r);
    r = await call('GET', `/api/businesses/${bizR}/services`);
    const listed = (r.body?.services ?? []) as any[];
    const ev = listed.find((s) => s.id === sEverywhere), nor = listed.find((s) => s.id === sNorfolk);
    assert(r.status === 200 && ev?.requestOnly === true && Array.isArray(ev?.serviceCities) && ev.serviceCities.length === 0, 'public list returns requestOnly + serviceCities (additive)', ev);
    assert(JSON.stringify(nor?.serviceCities) === '["Norfolk"]', 'public list returns the service cities', nor);
    assert(!listed.some((s) => s.id === sDraft), 'draft still hidden from the public list', listed.map((s) => s.id));

    console.log('\n── 2. service save: serviceCities + requestOnly ──');
    r = await call('PATCH', `/api/vendor/services/${sBookable}`, { token: tR, body: { serviceCities: ['  chesapeake ', 'Chesapeake', 'Virginia   Beach', ''], requestOnly: true } });
    assert(r.status === 200 && JSON.stringify(r.body?.service?.serviceCities) === '["chesapeake","Virginia Beach"]' && r.body?.service?.requestOnly === true, 'list cleaned (trim, spaces, duplicates, blanks), requestOnly saved', r.body?.service);
    r = await hold(sBookable);
    assert(refused(r), 'switched to request only → hold now refused', r);
    r = await call('PATCH', `/api/vendor/services/${sBookable}`, { token: tR, body: { name: 'Renamed plan' } });
    assert(r.status === 200 && r.body?.service?.requestOnly === true && r.body?.service?.serviceCities?.length === 2, 'a save without the new fields leaves them as they were', r.body?.service);
    r = await call('PATCH', `/api/vendor/services/${sBookable}`, { token: tR, body: { requestOnly: false } });
    r = await hold(sBookable);
    assert(held(r), 'switched back → bookable again', r);
    r = await call('PATCH', `/api/vendor/services/${sBookable}`, { token: tR, body: { serviceCities: Array.from({ length: 51 }, (_, i) => `City ${i}`) } });
    assert(r.status === 400, '51 cities → 400', r.status);
    r = await call('POST', '/api/vendor/services', { token: tR, body: { name: 'New plan', price: 25000, durationMinutes: 180, requestOnly: true, serviceCities: ['Suffolk'] } });
    assert(r.status === 200 && r.body?.service?.requestOnly === true && JSON.stringify(r.body?.service?.serviceCities) === '["Suffolk"]', 'create accepts both fields', r.body?.service);
    r = await call('POST', '/api/vendor/services', { token: tR, body: { name: 'Old style plan', price: 25000, durationMinutes: 180 } });
    assert(r.status === 200 && r.body?.service?.requestOnly === false && r.body?.service?.serviceCities?.length === 0, 'create without them → defaults (bookable, every city)', r.body?.service);

    console.log('\n── 3. business service cities ──');
    r = await call('PATCH', '/api/vendor/my-business', { token: tR, body: { serviceCities: ['Norfolk', ' chesapeake', 'Portsmouth', 'Norfolk'] } });
    assert(r.status === 200, 'my-business saves serviceCities', r);
    let [bizRow] = await q(`SELECT service_cities FROM businesses WHERE id = $1`, [bizR]);
    assert(JSON.stringify(bizRow.service_cities) === '["Norfolk","chesapeake","Portsmouth"]', 'saved cleaned list', bizRow);
    r = await call('PATCH', '/api/vendor/my-business', { token: tR, body: { serviceCities: 'Norfolk' } });
    assert(r.status === 400 && r.body?.field === 'serviceCities', 'not a list → 400 field serviceCities', r);
    [bizRow] = await q(`SELECT service_cities FROM businesses WHERE id = $1`, [bizR]);
    assert(bizRow.service_cities.length === 3, 'refused save changed nothing', bizRow);
    r = await call('GET', `/api/businesses/${bizR}`);
    const pub = r.body?.business ?? r.body;
    assert(r.status === 200 && JSON.stringify(pub?.serviceCities) === '["Norfolk","chesapeake","Portsmouth"]', 'public business info returns serviceCities', pub?.serviceCities);

    console.log('\n── 4. estimate submit ──');
    r = await call('POST', '/api/estimate-requests', { body: form() });
    assert(r.status === 401, 'not signed in → 401', r);
    r = await call('POST', '/api/estimate-requests', { token: tC, body: form({ city: 'Richmond' }) });
    assert(r.status === 400 && r.body?.field === 'city', 'city the business does not serve → 400 city', r);
    r = await call('POST', '/api/estimate-requests', { token: tC, body: form({ city: 'Portsmouth', serviceId: sNorfolk }) });
    assert(r.status === 400 && r.body?.field === 'serviceId', 'plan not offered in that city → 400 serviceId', r);
    r = await call('POST', '/api/estimate-requests', { token: tC, body: form({ serviceId: sDraft }) });
    assert(r.status === 400 && r.body?.field === 'serviceId', 'draft plan → 400', r);
    r = await call('POST', '/api/estimate-requests', { token: tC, body: form({ serviceId: sOther }) });
    assert(r.status === 400 && r.body?.field === 'serviceId', "another business's plan → 400", r);
    r = await call('POST', '/api/estimate-requests', { token: tC, body: form({ email: 'nope' }) });
    assert(r.status === 400, 'bad email → 400', r.status);
    r = await call('POST', '/api/estimate-requests', { token: tC, body: form({ city: ' norfolk ', serviceId: sNorfolk }) });
    assert(r.status === 201 && r.body?.success === true && r.body?.request?.status === 'new', 'valid request → 201 saved, even with email not configured', r);
    const reqId = r.body?.request?.id;
    const [saved] = await q(`SELECT * FROM estimate_requests WHERE id = $1`, [reqId]);
    assert(saved?.business_id === bizR && saved?.customer_id === customer && saved?.service_name === `Plan s-nor` && saved?.city === 'norfolk', 'row has business, customer, plan snapshot, city', saved);
    assert(saved?.details?.homeSize === '2 Bedroom' && saved?.details?.notes === '<b>piano</b>' && saved?.source === 'royal-elite-site', 'details + source stored as sent', saved?.details);
    r = await call('POST', '/api/estimate-requests', { token: tC2, body: form({ serviceId: null }) });
    assert(r.status === 201, 'no plan chosen → still saved', r);

    console.log('\n── 5. vendor list + update ──');
    r = await call('GET', '/api/vendor/estimate-requests', { token: tR, headers: { 'x-business-id': bizR } });
    assert(r.status === 200 && r.body?.requests?.length === 2 && r.body.requests[0].customerName === 'Test Customer', 'owner sees both, newest first', r.body);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tO });
    assert(r.status === 200 && r.body?.requests?.length === 0, 'another vendor sees none of them', r.body);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tO, headers: { 'x-business-id': bizR } });
    assert(r.status === 403, 'another vendor naming this business → 403', r);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tA, headers: { 'x-business-id': bizR } });
    assert(r.status === 200 && r.body?.requests?.length === 2, 'platform admin with x-business-id sees them', r.status);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tC });
    assert(r.status === 404, 'a customer has no business → 404', r);
    r = await call('PATCH', `/api/vendor/estimate-requests/${reqId}`, { token: tO, body: { status: 'called' } });
    assert(r.status === 404, "another vendor can't update it", r);
    r = await call('PATCH', `/api/vendor/estimate-requests/${reqId}`, { token: tR, body: { status: 'teleported' } });
    assert(r.status === 400, 'unknown status → 400', r.status);
    r = await call('PATCH', `/api/vendor/estimate-requests/${reqId}`, { token: tR, body: { status: 'called', vendorNotes: '  Called, 2nd floor walk up.  ' } });
    assert(r.status === 200 && r.body?.request?.status === 'called' && r.body?.request?.vendorNotes === 'Called, 2nd floor walk up.', 'status + notes saved', r.body);
    r = await call('GET', '/api/vendor/estimate-requests?status=called', { token: tR });
    assert(r.status === 200 && r.body?.requests?.length === 1 && r.body.requests[0].id === reqId, 'filter by status', r.body);

    console.log('\n── 6. limit: 5 per hour per account ──');
    let lastStatus = 0;
    for (let i = 0; i < 4; i++) lastStatus = (await call('POST', '/api/estimate-requests', { token: tC, body: form() })).status;
    assert(lastStatus === 201, 'requests 2 to 5 from the same account → saved', lastStatus);
    r = await call('POST', '/api/estimate-requests', { token: tC, body: form() });
    assert(r.status === 429, '6th within the hour → 429', r.status);
    r = await call('POST', '/api/estimate-requests', { token: tC2, body: form() });
    assert(r.status === 201, 'another account is not affected', r.status);
  } finally {
    await q(`DELETE FROM estimate_requests WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM appointments WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM weekly_availability WHERE provider_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
