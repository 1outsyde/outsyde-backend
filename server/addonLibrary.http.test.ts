/**
 * Add-on library (migration 046) — HTTP integration tests
 *
 * Run with: npx tsx server/addonLibrary.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema,
 * migrations 040 + 041 + 046 applied) with a Stripe stub. Environment variables:
 *
 *   AL_TEST_BASE_URL      e.g. http://localhost:5062         (must be localhost)
 *   AL_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   AL_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 *
 * The file skips (exit 0) when AL_TEST_BASE_URL is unset and refuses any non-local host, so it
 * can never touch Neon or production.
 *
 * What it proves:
 *  - library CRUD + ownership (another vendor can never read, change, attach or delete)
 *  - attach puts an add-on ONLY on the services the vendor picked (archived / duplicate / 20 limit skipped)
 *  - library edits reach every attached service; price only reaches services that follow the library
 *  - custom price → one prompt per library price change (keep / sync), sync follows later changes
 *  - library on/off only touches the services the vendor ticked
 *  - an add-on written inside one service lands in the library but stays on that one service
 *  - delete removes the add-on from every service; past hold snapshots are untouched
 *  - booking money with a library-linked add-on is unchanged: $70 + $15 → PI 9180, deposit $20 → PI 2160
 *  - the public services list still exposes exactly the same 6 add-on keys
 */

import http from 'http';

const BASE = process.env.AL_TEST_BASE_URL;
const PG_URL = process.env.AL_TEST_PG_URL;
const STUB_PORT = Number(process.env.AL_TEST_STRIPE_PORT || '0');

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
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.99.2.2` };
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
    console.log('⏭  skipped: set AL_TEST_BASE_URL (+ AL_TEST_PG_URL, AL_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, AL_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'al-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub (same shape as serviceAddons.http.test.ts) ─────────────────────
  const piStore: Record<string, any> = {};
  const customerStore: Record<string, any> = {};
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
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) { if (k.startsWith('metadata[') && k.endsWith(']')) metadata[k.slice(9, -1)] = v; }
        const pi = { id: piId, object: 'payment_intent', amount: Number(form.get('amount') || 0), currency: 'usd', status: 'requires_payment_method', client_secret: `${piId}_secret_stub`, metadata, description: form.get('description') || '' };
        piStore[piId] = pi;
        return send(200, pi);
      }
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
  const P = `al${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const seededUsers: string[] = [];
  const seededBiz: string[] = [];
  const seededSvc: string[] = [];
  const seededSubIds: string[] = [];
  const seededWeeklyIds: string[] = [];

  const mkUser = async (key: string, isVendor = false) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@al.test`, isVendor]);
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
  const mkSvc = async (key: string, bizId: string, opts: { depositCents?: number; status?: string } = {}) => {
    const sid = id(key);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, deposit_amount_cents, is_active, status) VALUES ($1, $2, $3, 7000, 60, $4, true, $5)`,
      [sid, bizId, `Svc ${key}`, opts.depositCents ?? null, opts.status ?? 'live']);
    seededSvc.push(sid);
    return sid;
  };
  const mkWeeklyAvail = async (bizIdArg: string) => {
    for (let dow = 0; dow <= 6; dow++) {
      const wid = id(`wa-${dow}`);
      await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, '08:00', '20:00', true)`, [wid, bizIdArg, dow]);
      seededWeeklyIds.push(wid);
    }
  };
  const [tierRow] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true ORDER BY sort_order, created_at LIMIT 1`);
  if (!tierRow) throw new Error('No active subscription_tiers in DB — seed them first');
  const mkSub = async (bizIdArg: string, vendorIdArg: string) => {
    const subId = id(`sub-${bizIdArg.slice(-3)}`);
    await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_end) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [subId, vendorIdArg, bizIdArg, tierRow.id, new Date(Date.now() + 30 * 86400000).toISOString()]);
    seededSubIds.push(subId);
  };

  const vendorId = await mkUser('v', true);
  const bizId = await mkBiz('b', vendorId);
  const s1 = await mkSvc('s1', bizId);                               // live, no deposit (B = 7000)
  const s2 = await mkSvc('s2', bizId);                               // live
  const s3 = await mkSvc('s3', bizId, { status: 'archived' });       // archived
  const s4 = await mkSvc('s4', bizId);                               // filled to 20 add-ons
  const sDep = await mkSvc('sdep', bizId, { depositCents: 2000 });   // live, deposit D = 2000
  await mkWeeklyAvail(bizId);
  await mkSub(bizId, vendorId);

  const otherVendorId = await mkUser('v2', true);
  const otherBizId = await mkBiz('b2', otherVendorId);
  const otherSvc = await mkSvc('so', otherBizId);

  const customerId = await mkUser('c');

  const vendorToken = generateAccessToken({ userId: vendorId, isVendor: true, isAdmin: false });
  const otherToken = generateAccessToken({ userId: otherVendorId, isVendor: true, isAdmin: false });
  const customerToken = generateAccessToken({ userId: customerId, isVendor: false, isAdmin: false });

  const copyOf = async (serviceId: string, libraryId: string) =>
    (await q(`SELECT * FROM service_addons WHERE service_id = $1 AND business_addon_id = $2`, [serviceId, libraryId]))[0];
  const libRow = async (libraryId: string) => (await q(`SELECT * FROM business_addons WHERE id = $1`, [libraryId]))[0];
  const perServiceGet = async (serviceId: string) => (await call('GET', `/api/vendor/services/${serviceId}/addons`, { token: vendorToken })).body?.addons ?? [];

  const TOMORROW = new Date(); TOMORROW.setDate(TOMORROW.getDate() + 1);
  const tDate = TOMORROW.toISOString().slice(0, 10);
  const holdIds: string[] = [];

  try {
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. auth ──');
    let r = await call('GET', '/api/vendor/addon-library');
    assert(r.status === 401, 'GET library: unauthenticated → 401', r);
    r = await call('POST', '/api/vendor/addon-library', { body: { name: 'X', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 401, 'POST library: unauthenticated → 401', r);

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. create library add-on ──');
    r = await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: '', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400, 'POST library: empty name → 400', r);
    r = await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: 'X'.repeat(81), priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400, 'POST library: name > 80 → 400', r);
    r = await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: 'X', priceCents: 100001, durationMinutes: 0 } });
    assert(r.status === 400, 'POST library: price > 100000 → 400', r);
    r = await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: 'X', priceCents: 0, durationMinutes: 481 } });
    assert(r.status === 400, 'POST library: minutes > 480 → 400', r);
    r = await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: 'X', priceCents: 0, durationMinutes: 0, description: 'd'.repeat(301) } });
    assert(r.status === 400, 'POST library: description > 300 → 400', r);

    r = await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: 'Rhinestones', description: 'Per nail set', priceCents: 1000, durationMinutes: 15 } });
    assert(r.status === 201 && r.body?.addon?.id, 'POST library: 201 with addon', r);
    const libRh: string = r.body?.addon?.id;
    assert(r.body?.addon?.businessId === bizId, 'POST library: belongs to the vendor business', r.body?.addon);
    const attachedNow = await q(`SELECT count(*)::int AS n FROM service_addons WHERE business_addon_id = $1`, [libRh]);
    assert(attachedNow[0].n === 0, 'POST library: attached to NO service', attachedNow);

    r = await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: '  rhinestones ', priceCents: 500, durationMinutes: 0 } });
    assert(r.status === 409 && r.body?.code === 'DUPLICATE_ADDON', 'POST library: same name (case/space) → 409 DUPLICATE_ADDON', r);

    r = await call('GET', '/api/vendor/addon-library', { token: vendorToken });
    assert(r.status === 200 && Array.isArray(r.body?.addons), 'GET library: 200 list', r);
    const listed = (r.body?.addons ?? []).find((a: any) => a.id === libRh);
    assert(!!listed && Array.isArray(listed.services) && listed.services.length === 0, 'GET library: Rhinestones listed with services []', listed);

    r = await call('GET', '/api/vendor/addon-library', { token: otherToken });
    assert(r.status === 200 && !(r.body?.addons ?? []).some((a: any) => a.id === libRh), 'GET library: another vendor never sees it', r.body);

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. attach to chosen services ──');
    for (let i = 0; i < 20; i++) {
      await q(`INSERT INTO service_addons (service_id, name, price_cents, duration_minutes) VALUES ($1, $2, 0, 0)`, [s4, `Fill ${i}`]);
    }
    r = await call('POST', `/api/vendor/addon-library/${libRh}/services`, { token: otherToken, body: { serviceIds: [s1] } });
    assert(r.status === 404, 'attach: another vendor → 404', r);
    r = await call('POST', `/api/vendor/addon-library/${libRh}/services`, { token: vendorToken, body: { serviceIds: [otherSvc] } });
    assert(r.status === 404, 'attach: another business service → 404', r);
    r = await call('POST', `/api/vendor/addon-library/${libRh}/services`, { token: vendorToken, body: { serviceIds: [] } });
    assert(r.status === 400, 'attach: empty serviceIds → 400', r);

    r = await call('POST', `/api/vendor/addon-library/${libRh}/services`, { token: vendorToken, body: { serviceIds: [s1, s2, s3, s4] } });
    assert(r.status === 200, 'attach: 200', r);
    const added: string[] = r.body?.added ?? [];
    const skipped: Array<{ serviceId: string; reason: string }> = r.body?.skipped ?? [];
    assert(added.length === 2 && added.includes(s1) && added.includes(s2), 'attach: added to s1 + s2 only', r.body);
    assert(skipped.some((x) => x.serviceId === s3 && x.reason === 'archived'), 'attach: archived service skipped', skipped);
    assert(skipped.some((x) => x.serviceId === s4 && x.reason === 'limit'), 'attach: service with 20 add-ons skipped (limit)', skipped);
    assert(!(await copyOf(sDep, libRh)), 'attach: service not picked (deposit svc) has no copy', null);

    const c1 = await copyOf(s1, libRh);
    assert(c1?.name === 'Rhinestones' && c1?.price_cents === 1000 && c1?.duration_minutes === 15 && c1?.description === 'Per nail set' && c1?.price_synced === true,
      'attach: copy carries library values, price_synced true', c1);

    r = await call('POST', `/api/vendor/addon-library/${libRh}/services`, { token: vendorToken, body: { serviceIds: [s1] } });
    assert((r.body?.skipped ?? []).some((x: any) => x.serviceId === s1 && x.reason === 'already_added'), 'attach again: already_added', r.body);

    // Public list: exactly the 6 keys, id = the service's own add-on id
    r = await call('GET', `/api/businesses/${bizId}/services`);
    const pubS1 = (r.body?.services ?? []).find((s: any) => s.id === s1);
    const pubAddon = pubS1?.addons?.find((a: any) => a.id === c1?.id);
    assert(!!pubAddon, 'public list: attached add-on shown on s1 with its service add-on id', pubS1?.addons);
    if (pubAddon) {
      const keys = Object.keys(pubAddon).sort().join(',');
      assert(keys === 'description,durationMinutes,id,name,priceCents,sortOrder', 'public list: still exactly the 6 keys', keys);
    }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. library edits reach every attached service ──');
    r = await call('PATCH', `/api/vendor/addon-library/${libRh}`, { token: otherToken, body: { name: 'Hacked' } });
    assert(r.status === 404, 'PATCH library: another vendor → 404', r);
    r = await call('PATCH', `/api/vendor/addon-library/${libRh}`, { token: vendorToken, body: { name: 'Rhinestones Deluxe', description: 'Full set', durationMinutes: 20 } });
    assert(r.status === 200 && r.body?.addon?.name === 'Rhinestones Deluxe', 'PATCH library: 200', r);
    for (const sid of [s1, s2]) {
      const c = await copyOf(sid, libRh);
      assert(c?.name === 'Rhinestones Deluxe' && c?.description === 'Full set' && c?.duration_minutes === 20, `PATCH library: name/description/minutes reached ${sid.slice(-2)}`, c);
    }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. custom price + one prompt per library price change ──');
    const c1Id = (await copyOf(s1, libRh)).id;
    const c2Id = (await copyOf(s2, libRh)).id;
    // Web/app always send the full form, price included. Same price as library → stays synced.
    r = await call('PATCH', `/api/vendor/services/${s2}/addons/${c2Id}`, { token: vendorToken, body: { name: 'Rhinestones Deluxe', description: 'Full set', priceCents: 1000, durationMinutes: 20 } });
    assert(r.status === 200 && (await copyOf(s2, libRh)).price_synced === true, 'per-service PATCH with library price → stays synced', r.body);
    // Different price → custom
    r = await call('PATCH', `/api/vendor/services/${s1}/addons/${c1Id}`, { token: vendorToken, body: { name: 'Rhinestones Deluxe', description: 'Full set', priceCents: 1500, durationMinutes: 20 } });
    let c1Now = await copyOf(s1, libRh);
    assert(r.status === 200 && c1Now.price_cents === 1500 && c1Now.price_synced === false, 'per-service PATCH with a different price → custom price', c1Now);
    let s1List = await perServiceGet(s1);
    let s1Copy = s1List.find((a: any) => a.id === c1Id);
    assert(s1Copy?.libraryPriceCents === 1000 && s1Copy?.needsPriceReview === true, 'per-service GET: libraryPriceCents 1000, needsPriceReview true (prices differ, never asked)', s1Copy);
    assert(s1Copy?.priceCents === 1500 && 'serviceId' in s1Copy && 'isActive' in s1Copy, 'per-service GET: existing keys kept', s1Copy);

    // Library price 1000 → 1200: s2 (synced) follows, s1 keeps 1500
    r = await call('PATCH', `/api/vendor/addon-library/${libRh}`, { token: vendorToken, body: { priceCents: 1200 } });
    assert(r.status === 200, 'PATCH library price: 200', r);
    assert((await copyOf(s2, libRh)).price_cents === 1200, 'library price change: synced s2 → 1200', null);
    assert((await copyOf(s1, libRh)).price_cents === 1500, 'library price change: custom s1 keeps 1500', null);
    assert((r.body?.customPriceServices ?? []).some((x: any) => x.serviceId === s1 && x.priceCents === 1500), 'library price change: response lists s1 as custom price', r.body);
    assert((r.body?.updatedServiceIds ?? []).includes(s2) && !(r.body?.updatedServiceIds ?? []).includes(s1), 'library price change: updatedServiceIds = s2 only', r.body);

    // Keep → not asked again for 1200
    r = await call('POST', `/api/vendor/services/${s1}/addons/${c1Id}/price-review`, { token: otherToken, body: { action: 'keep' } });
    assert(r.status === 404, 'price-review: another vendor → 404', r);
    r = await call('POST', `/api/vendor/services/${s1}/addons/${c1Id}/price-review`, { token: vendorToken, body: { action: 'maybe' } });
    assert(r.status === 400, 'price-review: bad action → 400', r);
    r = await call('POST', `/api/vendor/services/${s1}/addons/${c1Id}/price-review`, { token: vendorToken, body: { action: 'keep' } });
    c1Now = await copyOf(s1, libRh);
    assert(r.status === 200 && c1Now.price_cents === 1500 && c1Now.declined_library_price_cents === 1200, 'keep: price stays 1500, remembers declined 1200', c1Now);
    s1Copy = (await perServiceGet(s1)).find((a: any) => a.id === c1Id);
    assert(s1Copy?.needsPriceReview === false, 'keep: needsPriceReview false', s1Copy);

    // Library 1200 → 1300: asked again
    await call('PATCH', `/api/vendor/addon-library/${libRh}`, { token: vendorToken, body: { priceCents: 1300 } });
    s1Copy = (await perServiceGet(s1)).find((a: any) => a.id === c1Id);
    assert(s1Copy?.needsPriceReview === true && s1Copy?.priceCents === 1500, 'next library price change (1300): needsPriceReview true again, price still 1500', s1Copy);
    r = await call('GET', '/api/vendor/addon-library', { token: vendorToken });
    const libServices = (r.body?.addons ?? []).find((a: any) => a.id === libRh)?.services ?? [];
    assert(libServices.some((s: any) => s.serviceId === s1 && s.needsPriceReview === true && s.priceSynced === false && s.priceCents === 1500)
      && libServices.some((s: any) => s.serviceId === s2 && s.needsPriceReview === false && s.priceSynced === true && s.priceCents === 1300),
      'GET library: per-service status (s1 custom + review, s2 synced 1300)', libServices);

    // Sync → follows the library from now on
    r = await call('POST', `/api/vendor/services/${s1}/addons/${c1Id}/price-review`, { token: vendorToken, body: { action: 'sync' } });
    c1Now = await copyOf(s1, libRh);
    assert(r.status === 200 && c1Now.price_cents === 1300 && c1Now.price_synced === true && c1Now.declined_library_price_cents === null, 'sync: price 1300, synced, declined cleared', c1Now);
    await call('PATCH', `/api/vendor/addon-library/${libRh}`, { token: vendorToken, body: { priceCents: 1400 } });
    c1Now = await copyOf(s1, libRh);
    assert(c1Now.price_cents === 1400 && c1Now.price_synced === true, 'after sync: next library change (1400) applies automatically', c1Now);
    s1Copy = (await perServiceGet(s1)).find((a: any) => a.id === c1Id);
    assert(s1Copy?.needsPriceReview === false, 'after sync: no review prompt', s1Copy);

    // Per-service PATCH back to the library price after a custom one → synced again
    await call('PATCH', `/api/vendor/services/${s2}/addons/${c2Id}`, { token: vendorToken, body: { priceCents: 999 } });
    assert((await copyOf(s2, libRh)).price_synced === false, 'per-service price 999 → custom', null);
    await call('PATCH', `/api/vendor/services/${s2}/addons/${c2Id}`, { token: vendorToken, body: { priceCents: 1400 } });
    const c2Back = await copyOf(s2, libRh);
    assert(c2Back.price_synced === true && c2Back.declined_library_price_cents === null, 'per-service price back to library price → synced again', c2Back);

    // price-review on an add-on that is not linked → 400
    const [unlinked] = await q(`SELECT id FROM service_addons WHERE service_id = $1 LIMIT 1`, [s4]);
    r = await call('POST', `/api/vendor/services/${s4}/addons/${unlinked.id}/price-review`, { token: vendorToken, body: { action: 'sync' } });
    assert(r.status === 400, 'price-review: add-on not in the library → 400', r);

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. on/off only on the ticked services ──');
    r = await call('POST', `/api/vendor/addon-library/${libRh}/active`, { token: otherToken, body: { isActive: false, serviceIds: [s1] } });
    assert(r.status === 404, 'active: another vendor → 404', r);
    r = await call('POST', `/api/vendor/addon-library/${libRh}/active`, { token: vendorToken, body: { isActive: false, serviceIds: [sDep] } });
    assert(r.status === 400, 'active: a service the add-on is not on → 400', r);
    r = await call('POST', `/api/vendor/addon-library/${libRh}/active`, { token: vendorToken, body: { isActive: false, serviceIds: [s1] } });
    assert(r.status === 200, 'active off for s1 only: 200', r);
    assert((await copyOf(s1, libRh)).is_active === false && (await copyOf(s2, libRh)).is_active === true, 'active off: s1 off, s2 still on', null);
    assert((await libRow(libRh)).is_active === false, 'active off: library flag off', null);
    r = await call('POST', `/api/vendor/addon-library/${libRh}/active`, { token: vendorToken, body: { isActive: true, serviceIds: [] } });
    assert(r.status === 200 && (await libRow(libRh)).is_active === true && (await copyOf(s1, libRh)).is_active === false, 'active on with no services: library flag only', null);
    await call('POST', `/api/vendor/addon-library/${libRh}/active`, { token: vendorToken, body: { isActive: true, serviceIds: [s1] } });
    assert((await copyOf(s1, libRh)).is_active === true, 'active on for s1: back on', null);
    // Per-service on/off (web toggle sends only isActive) touches only that service
    await call('PATCH', `/api/vendor/services/${s2}/addons/${c2Id}`, { token: vendorToken, body: { isActive: false } });
    assert((await copyOf(s2, libRh)).is_active === false && (await copyOf(s1, libRh)).is_active === true && (await libRow(libRh)).is_active === true,
      'per-service toggle: only that service', null);
    await call('PATCH', `/api/vendor/services/${s2}/addons/${c2Id}`, { token: vendorToken, body: { isActive: true } });

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. add-on written inside one service ──');
    const libCountBefore = (await q(`SELECT count(*)::int AS n FROM business_addons WHERE business_id = $1`, [bizId]))[0].n;
    r = await call('POST', `/api/vendor/services/${s1}/addons`, { token: vendorToken, body: { name: 'French Tips', priceCents: 800, durationMinutes: 10 } });
    assert(r.status === 201 && r.body?.addon?.businessAddonId, 'per-service POST: 201, linked to a library add-on', r.body);
    const libFrench: string = r.body?.addon?.businessAddonId;
    assert((await libRow(libFrench))?.name === 'French Tips' && (await libRow(libFrench))?.business_id === bizId, 'per-service POST: library add-on created', null);
    const frenchCopies = await q(`SELECT service_id FROM service_addons WHERE business_addon_id = $1`, [libFrench]);
    assert(frenchCopies.length === 1 && frenchCopies[0].service_id === s1, 'per-service POST: on THIS service only', frenchCopies);

    r = await call('POST', `/api/vendor/services/${s1}/addons`, { token: vendorToken, body: { name: 'french tips ', priceCents: 800, durationMinutes: 10 } });
    assert(r.status === 409 && r.body?.code === 'DUPLICATE_ADDON', 'per-service POST: same add-on twice on one service → 409', r);

    r = await call('POST', `/api/vendor/services/${s2}/addons`, { token: vendorToken, body: { name: 'French Tips', priceCents: 800, durationMinutes: 10 } });
    assert(r.status === 201 && r.body?.addon?.businessAddonId === libFrench && r.body?.addon?.priceSynced === true, 'per-service POST same name + price on s2 → reuses library add-on, synced', r.body);

    r = await call('POST', `/api/vendor/services/${sDep}/addons`, { token: vendorToken, body: { name: 'French Tips', priceCents: 1100, durationMinutes: 10 } });
    assert(r.status === 201 && r.body?.addon?.businessAddonId === libFrench && r.body?.addon?.priceSynced === false, 'per-service POST same name, different price → linked with custom price', r.body);
    const depFrenchId = r.body?.addon?.id;
    let depList = await perServiceGet(sDep);
    assert(depList.find((a: any) => a.id === depFrenchId)?.needsPriceReview === false, 'custom price at creation: no prompt yet', depList);
    await call('PATCH', `/api/vendor/addon-library/${libFrench}`, { token: vendorToken, body: { priceCents: 900 } });
    depList = await perServiceGet(sDep);
    assert(depList.find((a: any) => a.id === depFrenchId)?.needsPriceReview === true && depList.find((a: any) => a.id === depFrenchId)?.priceCents === 1100,
      'library price change after that: prompt shows, price stays 1100', depList);
    const libCountAfter = (await q(`SELECT count(*)::int AS n FROM business_addons WHERE business_id = $1`, [bizId]))[0].n;
    assert(libCountAfter === libCountBefore + 1, 'per-service POSTs created exactly one library add-on', { libCountBefore, libCountAfter });

    // 21st add-on on a full service creates nothing in the library
    r = await call('POST', `/api/vendor/services/${s4}/addons`, { token: vendorToken, body: { name: 'Too Many', priceCents: 0, durationMinutes: 0 } });
    assert(r.status === 400 && r.body?.code === 'TOO_MANY_ADDONS', 'per-service POST on a full service → 400 TOO_MANY_ADDONS', r);
    assert((await q(`SELECT count(*)::int AS n FROM business_addons WHERE business_id = $1 AND name = 'Too Many'`, [bizId]))[0].n === 0, 'TOO_MANY_ADDONS: no library add-on left behind', null);

    // Deleting a copy inside one service keeps the library add-on
    r = await call('DELETE', `/api/vendor/services/${s2}/addons/${(await copyOf(s2, libFrench)).id}`, { token: vendorToken });
    assert(r.status === 200 && !!(await libRow(libFrench)) && !!(await copyOf(s1, libFrench)), 'per-service DELETE: removes that copy only, library keeps it', r.body);

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. money unchanged with a library-linked add-on ──');
    const libGel = (await call('POST', '/api/vendor/addon-library', { token: vendorToken, body: { name: 'Gel Art', priceCents: 1500, durationMinutes: 30 } })).body?.addon?.id;
    r = await call('POST', `/api/vendor/addon-library/${libGel}/services`, { token: vendorToken, body: { serviceIds: [s1, sDep] } });
    assert((r.body?.added ?? []).length === 2, 'Gel Art attached to s1 + deposit service', r.body);
    const gelS1 = (await copyOf(s1, libGel)).id;
    const gelDep = (await copyOf(sDep, libGel)).id;
    const holdBase = { providerType: 'business', providerId: bizId, date: tDate, holdDurationMinutes: 60 };

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, serviceId: s1, startTime: '10:00', addonIds: [gelS1] } });
    assert(r.status === 200 && r.body?.holdId, 'hold with library add-on: 200', r);
    const holdND = r.body?.holdId; if (holdND) holdIds.push(holdND);
    const [hND] = await q(`SELECT addons, addons_total_cents, addons_duration_minutes, start_at::text, end_at::text FROM booking_holds WHERE id = $1`, [holdND]);
    assert(hND?.addons_total_cents === 1500 && hND?.addons_duration_minutes === 30, 'hold: add-on total 1500, +30 min', hND);
    assert(Array.isArray(hND?.addons) && Object.keys(hND.addons[0]).sort().join(',') === 'durationMinutes,id,name,priceCents', 'hold snapshot shape unchanged (4 keys)', hND?.addons);

    r = await call('POST', `/api/booking/${holdND}/create-payment-intent`, { token: customerToken });
    assert(r.status === 200, 'no-deposit PI: 200', r.body);
    const [apptND] = await q(`SELECT id, total_price FROM appointments WHERE hold_id = $1`, [holdND]);
    assert(apptND?.total_price === 8500, 'no-deposit appointment total 8500 (7000 + 1500)', apptND);
    const piND = Object.values(piStore).find((pi: any) => pi.metadata?.appointmentId === apptND?.id) as any;
    assert(piND?.amount === 9180, 'no-deposit PI amount 9180', piND);

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, serviceId: sDep, startTime: '14:00', addonIds: [gelDep] } });
    const holdDep = r.body?.holdId; if (holdDep) holdIds.push(holdDep);
    assert(r.status === 200, 'deposit hold with library add-on: 200', r);
    r = await call('POST', `/api/booking/${holdDep}/create-payment-intent`, { token: customerToken });
    const [apptDep] = await q(`SELECT id, total_price, deposit_amount_cents FROM appointments WHERE hold_id = $1`, [holdDep]);
    const piDep = Object.values(piStore).find((pi: any) => pi.metadata?.appointmentId === apptDep?.id) as any;
    assert(r.status === 200 && apptDep?.total_price === 8500 && apptDep?.deposit_amount_cents === 2000, 'deposit appointment total 8500, deposit 2000', apptDep);
    assert(piDep?.amount === 2160, 'deposit PI amount 2160', piDep);

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. delete from the library removes it everywhere, snapshots stay ──');
    r = await call('DELETE', `/api/vendor/addon-library/${libGel}`, { token: otherToken });
    assert(r.status === 404, 'DELETE library: another vendor → 404', r);
    r = await call('DELETE', `/api/vendor/addon-library/${libGel}`, { token: vendorToken });
    const removed: string[] = r.body?.removedFromServiceIds ?? [];
    assert(r.status === 200 && removed.length === 2 && removed.includes(s1) && removed.includes(sDep), 'DELETE library: 200, removed from s1 + deposit service', r.body);
    assert(!(await libRow(libGel)) && (await q(`SELECT count(*)::int AS n FROM service_addons WHERE id = ANY($1::varchar[])`, [[gelS1, gelDep]]))[0].n === 0, 'DELETE library: library row and both copies gone', null);
    const [hAfter] = await q(`SELECT addons, addons_total_cents FROM booking_holds WHERE id = $1`, [holdND]);
    assert(hAfter?.addons_total_cents === 1500 && hAfter?.addons?.[0]?.name === 'Gel Art', 'past hold snapshot untouched after delete', hAfter);
    const [aAfter] = await q(`SELECT total_price, addons FROM appointments WHERE hold_id = $1`, [holdND]);
    assert(aAfter?.total_price === 8500 && aAfter?.addons?.[0]?.name === 'Gel Art', 'past appointment snapshot untouched after delete', aAfter);

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { ...holdBase, serviceId: s1, startTime: '17:00', addonIds: [gelS1] } });
    assert(r.status === 400, 'hold with a deleted add-on id → 400 (unchanged behaviour)', r);
    r = await call('GET', `/api/businesses/${bizId}/services`);
    const pubS1After = (r.body?.services ?? []).find((s: any) => s.id === s1);
    assert(!(pubS1After?.addons ?? []).some((a: any) => a.id === gelS1), 'public list: deleted add-on gone', pubS1After?.addons);
  } finally {
    if (holdIds.length) {
      await q(`DELETE FROM appointments WHERE hold_id = ANY($1::varchar[])`, [holdIds]);
      await q(`DELETE FROM booking_holds WHERE id = ANY($1::varchar[])`, [holdIds]);
    }
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1::varchar[])`, [seededBiz]);
    if (seededSvc.length) await q(`DELETE FROM vendor_services WHERE id = ANY($1::varchar[])`, [seededSvc]);
    if (seededSubIds.length) await q(`DELETE FROM vendor_subscriptions WHERE id = ANY($1::varchar[])`, [seededSubIds]);
    if (seededBiz.length) await q(`DELETE FROM businesses WHERE id = ANY($1::varchar[])`, [seededBiz]);
    if (seededUsers.length) await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [seededUsers]);
    if (seededWeeklyIds.length) await q(`DELETE FROM weekly_availability WHERE id = ANY($1::varchar[])`, [seededWeeklyIds]);
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
