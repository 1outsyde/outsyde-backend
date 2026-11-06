/**
 * Booking agreement (migration 105, booking redesign step 3) — HTTP integration tests.
 *
 * Run with: npx tsx server/bookingAgreement.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with a Stripe stub:
 *   BA_TEST_BASE_URL     e.g. http://localhost:5062   (must be localhost)
 *   BA_TEST_PG_URL       the SAME scratch database    (localhost only; seeds + cleans up)
 *   BA_TEST_STRIPE_PORT  port for the in-process Stripe stub started here; boot the server with
 *                        STRIPE_STUB_PORT=<same> and
 *                        NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when BA_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Covers: business, staff and photographer bookings save the agreement (time, Outsyde Terms
 * version, a copy of the vendor's terms read on the server); no agreement = old behaviour; a retry
 * never overwrites the first agreement; a retry can add one that was missing.
 * Mutation checks: drop the recordBookingAgreement call after createAppointment → "new business
 * booking saves agreed time" fails; drop both "agreed already?" guards (the route's !customerAgreedAt and the
 * helper's isNull) → "retry keeps the first agreed time" fails (either guard alone keeps it passing).
 */
import http from 'http';

const BASE = process.env.BA_TEST_BASE_URL;
const PG_URL = process.env.BA_TEST_PG_URL;
const STUB_PORT = Number(process.env.BA_TEST_STRIPE_PORT || '0');

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.5.1' };
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
  if (!BASE) { console.log('⏭  skipped: set BA_TEST_BASE_URL (+ BA_TEST_PG_URL, BA_TEST_STRIPE_PORT) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, BA_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ba-test-jwt-secret';
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
        piStore[piId] = pi;
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
  const P = `ba${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = []; const bizs: string[] = []; const photogs: string[] = [];
  const TERMS_BIZ = 'Deposits are not refunded within 24 hours.';
  const TERMS_PH = 'Raw photos are not included.';

  const mkUser = async (key: string, o: { isVendor?: boolean; isPhotographer?: boolean } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor, is_photographer) VALUES ($1::varchar, $1::text, $2, $3, $4)`,
      [uid, `${uid}@ba.test`, o.isVendor ?? false, o.isPhotographer ?? false]);
    users.push(uid); return uid;
  };
  const mkBiz = async (key: string, terms: string | null) => {
    const owner = await mkUser(`${key}-o`, { isVendor: true });
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, vendor_terms_and_conditions, booking_gap_minutes) VALUES ($1, $2, $3, 'beauty', 'approved', $4, true, $5, 0)`,
      [bid, owner, `Biz ${key}`, `acct_${bid.replace(/-/g, '')}`, terms]);
    for (let dow = 0; dow <= 6; dow++) {
      await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, '08:00', '20:00', true)`, [id(`wa-${key}-${dow}`), bid, dow]);
    }
    bizs.push(bid); return bid;
  };
  const mkSvc = async (key: string, bizId: string) => {
    const sid = id(key);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status) VALUES ($1, $2, $3, 7000, 30, true, 'live')`, [sid, bizId, `Svc ${key}`]);
    return sid;
  };
  const mkStaff = async (key: string, bizId: string) => {
    const stUser = await mkUser(`${key}-u`);
    const sid = id(key);
    await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, role, status, stripe_onboarding_complete, stripe_account_id) VALUES ($1, $2, $3, $4, 'staff', 'active', true, $5)`,
      [sid, bizId, stUser, `Staff ${key}`, `acct_${sid.replace(/-/g, '')}`]);
    for (let dow = 0; dow <= 6; dow++) {
      await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, staff_member_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, $4, '08:00', '20:00', true)`,
        [id(`wa-${key}-${dow}`), bizId, sid, dow]);
    }
    const svc = id(`${key}-svc`);
    await q(`INSERT INTO staff_services (id, business_id, staff_member_id, name, price_cents, duration_minutes, is_active, status) VALUES ($1, $2, $3, $4, 5000, 30, true, 'live')`,
      [svc, bizId, sid, `Staff svc ${key}`]);
    return { staffId: sid, serviceId: svc };
  };
  const allDaysOpen = JSON.stringify(Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { open: '08:00', close: '20:00' }])));
  const mkPhotog = async (key: string, terms: string | null) => {
    const uid = await mkUser(`${key}-u`, { isPhotographer: true });
    const pid = id(key);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, vendor_terms_and_conditions, created_at, updated_at)
             VALUES ($1, $2, $3, 10000, 'Austin', 'TX', $4::jsonb, $5, true, false, true, 'public', $6, now(), now())`,
      [pid, uid, `Photographer ${key}`, allDaysOpen, `acct_${pid.replace(/-/g, '')}`, terms]);
    for (let day = 0; day <= 6; day++) {
      await q(`INSERT INTO weekly_availability (provider_id, provider_type, day_of_week, start_time, end_time, is_active) VALUES ($1, 'photographer', $2, '08:00', '20:00', true)`, [pid, day]);
    }
    const svc = id(`${key}-svc`);
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
             VALUES ($1, $2, $3, 7000, 30, true, 'live', 'package', false, now())`, [svc, pid, `Shoot ${key}`]);
    photogs.push(pid); return { pid, svc };
  };

  const bizT = await mkBiz('bt', TERMS_BIZ);
  const svcT = await mkSvc('st', bizT);
  const bizBlank = await mkBiz('bn', '   ');
  const svcBlank = await mkSvc('sn', bizBlank);
  const staff = await mkStaff('stf', bizT);
  const phT = await mkPhotog('ph', TERMS_PH);

  const customer = await mkUser('c');
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false });

  let dayOffset = 2;
  const nextSlot = () => { dayOffset += 1; const d = new Date(); d.setDate(d.getDate() + dayOffset); return { date: d.toISOString().slice(0, 10), startTime: '10:00' }; };
  const holdIdOf = (r: { body: any }) => r.body?.holdId ?? r.body?.hold?.id ?? r.body?.id;
  const holdFor = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/api/booking/hold', { token, body: { ...nextSlot(), ...body } });
    const hid = holdIdOf(r);
    if (!hid) throw new Error(`hold failed: ${JSON.stringify(r).slice(0, 300)}`);
    return hid as string;
  };
  const pay = (hid: string, body: Record<string, unknown> = {}) => call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body });
  const paid = (r: { status: number; body: any }) => r.status === 200 && typeof r.body?.clientSecret === 'string';
  const appt = async (hid: string) => (await q(`SELECT customer_agreed_at, customer_agreed_terms_version, customer_agreed_vendor_terms FROM appointments WHERE hold_id = $1`, [hid]))[0];
  const shoot = async (pid: string) => (await q(`SELECT customer_agreed_at, customer_agreed_terms_version, customer_agreed_vendor_terms FROM shoot_bookings WHERE photographer_id = $1 ORDER BY created_at DESC LIMIT 1`, [pid]))[0];
  const AGREE = { agreement: { agreed: true, termsVersion: '2026-11' } };

  try {
    console.log('\n── 1. business booking with the agreement ──');
    let hid = await holdFor({ providerType: 'business', providerId: bizT, serviceId: svcT });
    let r = await pay(hid, AGREE);
    assert(paid(r), 'payment created with agreement', r);
    let row = await appt(hid);
    assert(!!row?.customer_agreed_at, 'new business booking saves agreed time', row);
    assert(row?.customer_agreed_terms_version === '2026-11', 'saves Outsyde Terms version', row);
    assert(row?.customer_agreed_vendor_terms === TERMS_BIZ, "saves a copy of the business's terms (from the server)", row);
    const firstAt = row?.customer_agreed_at;

    console.log('\n── 2. retry of the same hold never overwrites ──');
    await q(`UPDATE businesses SET vendor_terms_and_conditions = 'Changed later.' WHERE id = $1`, [bizT]);
    r = await pay(hid, { agreement: { agreed: true, termsVersion: '2027-01' } });
    assert(paid(r), 'retry still returns a payment', r);
    row = await appt(hid);
    assert(row?.customer_agreed_at === firstAt, 'retry keeps the first agreed time', { firstAt, row });
    assert(row?.customer_agreed_terms_version === '2026-11' && row?.customer_agreed_vendor_terms === TERMS_BIZ, 'retry keeps the first version and terms copy', row);
    r = await pay(hid, {});
    row = await appt(hid);
    assert(paid(r) && row?.customer_agreed_at === firstAt, 'retry without agreement keeps it too', row);
    await q(`UPDATE businesses SET vendor_terms_and_conditions = $2 WHERE id = $1`, [bizT, TERMS_BIZ]);

    console.log('\n── 3. old clients (no agreement) work as before ──');
    hid = await holdFor({ providerType: 'business', providerId: bizT, serviceId: svcT });
    r = await pay(hid, {});
    assert(paid(r), 'payment without agreement still created', r);
    row = await appt(hid);
    assert(row && row.customer_agreed_at === null && row.customer_agreed_terms_version === null && row.customer_agreed_vendor_terms === null, 'nothing saved without agreement', row);
    r = await pay(hid, AGREE);
    row = await appt(hid);
    assert(paid(r) && !!row?.customer_agreed_at && row?.customer_agreed_vendor_terms === TERMS_BIZ, 'a retry can add the missing agreement', row);

    console.log('\n── 4. bad or false agreement ──');
    hid = await holdFor({ providerType: 'business', providerId: bizT, serviceId: svcT });
    r = await pay(hid, { agreement: { agreed: false } });
    row = await appt(hid);
    assert(paid(r) && row?.customer_agreed_at === null, 'agreed false → nothing saved, payment unchanged', row);
    hid = await holdFor({ providerType: 'business', providerId: bizT, serviceId: svcT });
    r = await pay(hid, { agreement: { agreed: true, termsVersion: '<script>' } });
    row = await appt(hid);
    assert(paid(r) && row?.customer_agreed_terms_version === '2026-11', 'junk version → server version', row);

    console.log('\n── 5. business with blank terms ──');
    hid = await holdFor({ providerType: 'business', providerId: bizBlank, serviceId: svcBlank });
    r = await pay(hid, AGREE);
    row = await appt(hid);
    assert(paid(r) && !!row?.customer_agreed_at && row?.customer_agreed_vendor_terms === null, 'blank vendor terms → agreed, no terms copy', row);

    console.log('\n── 6. staff booking uses the business terms ──');
    hid = await holdFor({ providerType: 'business', providerId: bizT, staffMemberId: staff.staffId, serviceId: staff.serviceId });
    r = await pay(hid, AGREE);
    row = await appt(hid);
    assert(paid(r) && !!row?.customer_agreed_at && row?.customer_agreed_vendor_terms === TERMS_BIZ, 'staff booking saves the business terms', row);

    console.log('\n── 7. photographer booking ──');
    hid = await holdFor({ providerType: 'photographer', providerId: phT.pid, serviceId: phT.svc });
    r = await pay(hid, AGREE);
    let srow = await shoot(phT.pid);
    assert(paid(r), 'photographer payment created', r);
    assert(!!srow?.customer_agreed_at && srow?.customer_agreed_terms_version === '2026-11' && srow?.customer_agreed_vendor_terms === TERMS_PH, "shoot booking saves agreed time, version and the photographer's terms", srow);
    const shootAt = srow?.customer_agreed_at;
    r = await pay(hid, { agreement: { agreed: true, termsVersion: '2027-01' } });
    srow = await shoot(phT.pid);
    assert(paid(r) && srow?.customer_agreed_at === shootAt && srow?.customer_agreed_terms_version === '2026-11', 'photographer retry keeps the first agreement', srow);
    hid = await holdFor({ providerType: 'photographer', providerId: phT.pid, serviceId: phT.svc });
    r = await pay(hid, {});
    srow = await shoot(phT.pid);
    assert(paid(r) && srow?.customer_agreed_at === null, 'photographer without agreement → nothing saved', srow);
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
