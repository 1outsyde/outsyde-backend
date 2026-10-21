/**
 * Only bookable services can be held or paid for — HTTP integration tests.
 *
 * Risk 1 (2026-10-21): a paused, draft, archived or inactive service could still be held and paid for,
 * because the hold, validate and payment steps loaded the service by id only.
 * R20: the hold never checked that the service belongs to the business / staff member / photographer.
 * Legend 2026-10-21: staff of a business whose paid plan has lapsed are not bookable either, and the three
 * unauthenticated /api/dev/* routes (R3) are removed.
 *
 * Run with: npx tsx server/holdBookable.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with a Stripe stub:
 *   HB_TEST_BASE_URL      e.g. http://localhost:5062   (must be localhost)
 *   HB_TEST_PG_URL        the SAME scratch database (localhost only; seeds + cleans up)
 *   HB_TEST_STRIPE_PORT   port for the in-process Stripe stub started here; boot the server with
 *                         STRIPE_STUB_PORT=<same> and
 *                         NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET            identical to the server's
 * Skips (exit 0) when HB_TEST_BASE_URL is unset; refuses any non-local host.
 */

import http from 'http';

const BASE = process.env.HB_TEST_BASE_URL;
const PG_URL = process.env.HB_TEST_PG_URL;
const STUB_PORT = Number(process.env.HB_TEST_STRIPE_PORT || '0');
const MSG = "This service isn't available to book right now. Please choose another service.";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; contentType: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.99.7.${Math.floor(Math.random() * 200) + 1}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, contentType: String(res.headers['content-type'] || '') }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set HB_TEST_BASE_URL (+ HB_TEST_PG_URL, HB_TEST_STRIPE_PORT) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error('refusing to run: BASE and PG_URL must both be localhost, HB_TEST_STRIPE_PORT must be set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'hb-test-jwt-secret';
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
  const P = `hb${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const photogs: string[] = [];

  const mkUser = async (key: string, o: { isVendor?: boolean; isPhotographer?: boolean } = {}) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor, is_photographer) VALUES ($1::varchar, $1::text, $2, $3, $4)`,
      [uid, `${uid}@hb.test`, o.isVendor ?? false, o.isPhotographer ?? false]);
    users.push(uid);
    return uid;
  };
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', 'approved', $4, true)`,
      [bid, ownerId, `Biz ${key}`, `acct_${bid.replace(/-/g, '')}`]);
    for (let dow = 0; dow <= 6; dow++) {
      await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, '08:00', '20:00', true)`, [id(`wa-${key}-${dow}`), bid, dow]);
    }
    bizs.push(bid);
    return bid;
  };
  const mkSvc = async (key: string, bizId: string, o: { status?: string; isActive?: boolean } = {}) => {
    const sid = id(key);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status) VALUES ($1, $2, $3, 7000, 30, $4, $5)`,
      [sid, bizId, `Svc ${key}`, o.isActive ?? true, o.status ?? 'live']);
    return sid;
  };
  const [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true ORDER BY sort_order, created_at LIMIT 1`);
  if (!tier) throw new Error('No active subscription_tiers in the scratch DB');
  const mkSub = async (key: string, bizId: string, vendorId: string, o: { stripeSubId?: string | null; status?: string; pastDueDays?: number } = {}) => {
    await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, stripe_subscription_id, past_due_since, current_period_end) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days')`,
      [id(`sub-${key}`), vendorId, bizId, tier.id, o.status ?? 'active', o.stripeSubId ?? null,
       o.pastDueDays != null ? new Date(Date.now() - o.pastDueDays * 86400000).toISOString() : null]);
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
    return sid;
  };
  const mkStaffSvc = async (key: string, bizId: string, staffId: string, o: { status?: string; isActive?: boolean } = {}) => {
    const sid = id(key);
    await q(`INSERT INTO staff_services (id, business_id, staff_member_id, name, price_cents, duration_minutes, is_active, status) VALUES ($1, $2, $3, $4, 5000, 30, $5, $6)`,
      [sid, bizId, staffId, `Staff svc ${key}`, o.isActive ?? true, o.status ?? 'live']);
    return sid;
  };
  const allDaysOpen = JSON.stringify(Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { open: '08:00', close: '20:00' }])));
  const mkPhotog = async (key: string) => {
    const uid = await mkUser(`${key}-u`, { isPhotographer: true });
    const pid = id(key);
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
             VALUES ($1, $2, $3, 10000, 'Austin', 'TX', $4::jsonb, $5, true, false, true, 'public', now(), now())`,
      [pid, uid, `Photographer ${key}`, allDaysOpen, `acct_${pid.replace(/-/g, '')}`]);
    for (let day = 0; day <= 6; day++) {
      await q(`INSERT INTO weekly_availability (provider_id, provider_type, day_of_week, start_time, end_time, is_active) VALUES ($1, 'photographer', $2, '08:00', '20:00', true)`, [pid, day]);
    }
    photogs.push(pid);
    return pid;
  };
  const mkPhotogSvc = async (key: string, pid: string, o: { status?: string; isActive?: boolean } = {}) => {
    const sid = id(key);
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
             VALUES ($1, $2, $3, 7000, 30, $4, $5, 'package', false, now())`,
      [sid, pid, `Shoot ${key}`, o.isActive ?? true, o.status ?? 'live']);
    return sid;
  };

  // Business A: active paid plan in good standing, one service per status.
  const vendorA = await mkUser('va', { isVendor: true });
  const bizA = await mkBiz('ba', vendorA);
  await mkSub('a', bizA, vendorA, { stripeSubId: 'sub_hb_a' });
  const sLive = await mkSvc('s-live', bizA);
  const sLivePay = await mkSvc('s-livepay', bizA);
  const sLiveResume = await mkSvc('s-liveresume', bizA);
  const sLiveDep = await mkSvc('s-livedep', bizA);
  const sDraft = await mkSvc('s-draft', bizA, { status: 'draft' });
  const sArchived = await mkSvc('s-arch', bizA, { status: 'archived' });
  const sPaused = await mkSvc('s-paused', bizA, { status: 'paused' });
  const sInactive = await mkSvc('s-inactive', bizA, { isActive: false });
  const staffA = await mkStaff('sta', bizA);
  const stLive = await mkStaffSvc('st-live', bizA, staffA);
  const stDraft = await mkStaffSvc('st-draft', bizA, staffA, { status: 'draft' });
  const stLivePay = await mkStaffSvc('st-livepay', bizA, staffA);

  // Business D: plan active at hold time, lapses before payment.
  const vendorD = await mkUser('vd', { isVendor: true });
  const bizD = await mkBiz('bd', vendorD);
  await mkSub('d', bizD, vendorD, { stripeSubId: 'sub_hb_d' });
  const sDuring = await mkSvc('s-during', bizD);

  // Business B: another business with a live service (R20: never bookable through A).
  const vendorB = await mkUser('vb', { isVendor: true });
  const bizB = await mkBiz('bb', vendorB);
  await mkSub('b', bizB, vendorB, { stripeSubId: 'sub_hb_b' });
  const sOther = await mkSvc('s-other', bizB);
  const staffB = await mkStaff('stb', bizB);
  const stOther = await mkStaffSvc('st-other', bizB, staffB);

  // Business L: paid plan lapsed past the 7 day grace; the pause job hasn't run yet, so items are still live.
  const vendorL = await mkUser('vl', { isVendor: true });
  const bizL = await mkBiz('bl', vendorL);
  await mkSub('l', bizL, vendorL, { stripeSubId: 'sub_hb_l', status: 'past_due', pastDueDays: 10 });
  const sLapsed = await mkSvc('s-lapsed', bizL);
  const staffL = await mkStaff('stl', bizL);
  const stLapsed = await mkStaffSvc('st-lapsed', bizL, staffL);

  // Business G: paid plan late but still inside the grace period → still bookable.
  const vendorG = await mkUser('vg', { isVendor: true });
  const bizG = await mkBiz('bg', vendorG);
  await mkSub('g', bizG, vendorG, { stripeSubId: 'sub_hb_g', status: 'past_due', pastDueDays: 2 });
  const sGrace = await mkSvc('s-grace', bizG);

  // Business N: no subscription row at all (like XO today) → unchanged, still bookable.
  const vendorN = await mkUser('vn', { isVendor: true });
  const bizN = await mkBiz('bn', vendorN);
  const sNoRow = await mkSvc('s-norow', bizN);

  // Photographers.
  const ph = await mkPhotog('ph');
  const pLive = await mkPhotogSvc('p-live', ph);
  const pLivePay = await mkPhotogSvc('p-livepay', ph);
  const pDraft = await mkPhotogSvc('p-draft', ph, { status: 'draft' });
  const pInactive = await mkPhotogSvc('p-inactive', ph, { isActive: false });
  const ph2 = await mkPhotog('ph2');
  const pOther = await mkPhotogSvc('p-other', ph2);

  const customer = await mkUser('c');
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false });

  // Every call gets its own day at 10:00, so no two holds ever share a slot or run past closing.
  let dayOffset = 2;
  const nextSlot = () => { dayOffset += 1; const d = new Date(); d.setDate(d.getDate() + dayOffset); return { date: d.toISOString().slice(0, 10), startTime: '10:00' }; };

  const hold = (body: Record<string, unknown>) => call('POST', '/api/booking/hold', { token, body: { ...nextSlot(), ...body } });
  const validate = (params: Record<string, string>) =>
    call('POST', '/api/booking/validate', { body: { ...nextSlot(), ...params } });
  const refused = (r: { status: number; body: any }) => r.status === 400 && r.body?.errorCode === 'SERVICE_UNAVAILABLE' && r.body?.error === MSG;
  const ok = (r: { status: number; body: any }) => (r.status === 200 || r.status === 201) && !!(r.body?.holdId ?? r.body?.hold?.id ?? r.body?.id);
  const holdIdOf = (r: { body: any }) => r.body?.holdId ?? r.body?.hold?.id ?? r.body?.id;

  try {
    console.log('\n── 1. business services: only live + active ones can be held ──');
    let r = await hold({ providerType: 'business', providerId: bizA, serviceId: sLive });
    assert(ok(r), 'live service → hold created', r);
    for (const [name, sid] of [['draft', sDraft], ['archived', sArchived], ['paused', sPaused], ['inactive', sInactive]] as const) {
      r = await hold({ providerType: 'business', providerId: bizA, serviceId: sid });
      assert(refused(r), `${name} service → 400 SERVICE_UNAVAILABLE with the customer message`, r);
    }
    r = await hold({ providerType: 'business', providerId: bizA, serviceId: id('does-not-exist') });
    assert(r.status === 400 && r.body?.errorCode === 'SERVICE_NOT_FOUND', 'unknown service id → still SERVICE_NOT_FOUND', r);

    console.log('\n── 2. R20: a service must belong to the provider being booked ──');
    r = await hold({ providerType: 'business', providerId: bizA, serviceId: sOther });
    assert(refused(r), "another business's live service → refused", r);
    r = await hold({ providerType: 'photographer', providerId: ph, serviceId: pOther });
    assert(refused(r), "another photographer's live service → refused", r);
    r = await hold({ providerType: 'photographer', providerId: ph, serviceId: sLive });
    assert(r.status === 400 && (r.body?.errorCode === 'SERVICE_NOT_FOUND' || r.body?.errorCode === 'SERVICE_UNAVAILABLE'), 'a business service id on a photographer → refused', r);

    console.log('\n── 3. staff ──');
    r = await hold({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: stLive });
    assert(ok(r), 'live staff service → hold created', r);
    r = await hold({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: stDraft });
    assert(refused(r), 'draft staff service (staff has another live one) → refused', r);
    r = await hold({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: sLive });
    assert(ok(r), 'business-wide live service with a staff member chosen → hold created', r);
    r = await hold({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: sPaused });
    assert(refused(r), 'business-wide paused service with a staff member chosen → refused', r);
    r = await hold({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: sOther });
    assert(refused(r), "another business's service with a staff member chosen → refused", r);
    r = await hold({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: stOther });
    assert(refused(r), "another business's staff service → refused", r);

    console.log('\n── 4. paid plan lapsed past grace (Legend 2026-10-21: staff too) ──');
    r = await hold({ providerType: 'business', providerId: bizL, serviceId: sLapsed });
    assert(refused(r), 'lapsed business, service still marked live → refused', r);
    r = await hold({ providerType: 'business', providerId: bizL, staffMemberId: staffL, serviceId: stLapsed });
    assert(refused(r), 'lapsed business, live staff service → refused', r);
    r = await hold({ providerType: 'business', providerId: bizG, serviceId: sGrace });
    assert(ok(r), 'late plan still inside the grace period → hold created', r);
    r = await hold({ providerType: 'business', providerId: bizN, serviceId: sNoRow });
    assert(ok(r), 'business with no subscription row (like XO) → unchanged, hold created', r);

    console.log('\n── 5. photographers ──');
    r = await hold({ providerType: 'photographer', providerId: ph, serviceId: pLive });
    assert(ok(r), 'live photographer service → hold created', r);
    r = await hold({ providerType: 'photographer', providerId: ph, serviceId: pDraft });
    assert(refused(r), 'draft photographer service → refused', r);
    r = await hold({ providerType: 'photographer', providerId: ph, serviceId: pInactive });
    assert(refused(r), 'inactive photographer service → refused', r);

    console.log('\n── 6. POST /api/booking/validate uses the same rule ──');
    r = await validate({ providerType: 'business', providerId: bizA, serviceId: sLive });
    assert(r.status === 200 && r.body?.valid === true, 'validate: live service → valid', r);
    r = await validate({ providerType: 'business', providerId: bizA, serviceId: sPaused });
    assert(refused(r) && r.body?.valid === false, 'validate: paused service → SERVICE_UNAVAILABLE', r);
    r = await validate({ providerType: 'business', providerId: bizA, serviceId: sOther });
    assert(refused(r), "validate: another business's service → SERVICE_UNAVAILABLE", r);
    r = await validate({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: stDraft });
    assert(refused(r), 'validate: draft staff service → SERVICE_UNAVAILABLE', r);
    r = await validate({ providerType: 'business', providerId: bizL, serviceId: sLapsed });
    assert(refused(r), 'validate: lapsed business → SERVICE_UNAVAILABLE', r);
    r = await validate({ providerType: 'photographer', providerId: ph, serviceId: pDraft });
    assert(refused(r), 'validate: draft photographer service → SERVICE_UNAVAILABLE', r);
    r = await validate({ providerType: 'photographer', providerId: ph, serviceId: pLive });
    assert(r.status === 200 && r.body?.valid === true, 'validate: live photographer service → valid', r);

    console.log('\n── 7. payment step: paused after the hold → no booking, no charge ──');
    r = await hold({ providerType: 'business', providerId: bizA, serviceId: sLivePay });
    assert(ok(r), 'hold on a live service', r);
    let hid = holdIdOf(r);
    await q(`UPDATE vendor_services SET status = 'paused' WHERE id = $1`, [sLivePay]);
    let before = piCreates;
    r = await call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body: {} });
    assert(refused(r), 'create-payment-intent after the service was paused → refused', r);
    assert(r.body?.message === MSG, 'payment refusal also carries `message` (vendor sites read body.message at payment)', r.body);
    let holdRow = await q(`SELECT status FROM booking_holds WHERE id = $1`, [hid]);
    assert(holdRow[0]?.status === 'released', 'payment refusal releases the hold (the slot frees at once)', holdRow);
    let appts = await q(`SELECT id FROM appointments WHERE hold_id = $1`, [hid]);
    assert(appts.length === 0, 'no appointment row created', appts);
    assert(piCreates === before, 'no Stripe PaymentIntent created', { before, after: piCreates });

    r = await hold({ providerType: 'business', providerId: bizA, serviceId: sLiveDep });
    hid = holdIdOf(r);
    await q(`UPDATE vendor_services SET status = 'archived' WHERE id = $1`, [sLiveDep]);
    before = piCreates;
    r = await call('POST', `/api/booking/${hid}/create-deposit-intent`, { token, body: {} });
    assert(refused(r), 'legacy create-deposit-intent after the service was archived → refused', r);
    holdRow = await q(`SELECT status FROM booking_holds WHERE id = $1`, [hid]);
    assert(holdRow[0]?.status === 'released', 'legacy route: hold released', holdRow);
    appts = await q(`SELECT id FROM appointments WHERE hold_id = $1`, [hid]);
    assert(appts.length === 0 && piCreates === before, 'legacy route: no appointment, no PaymentIntent', { appts, before, after: piCreates });

    r = await hold({ providerType: 'photographer', providerId: ph, serviceId: pLivePay });
    hid = holdIdOf(r);
    await q(`UPDATE photographer_services SET status = 'archived' WHERE id = $1`, [pLivePay]);
    before = piCreates;
    r = await call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body: {} });
    assert(refused(r), 'photographer create-payment-intent after the service was archived → refused', r);
    holdRow = await q(`SELECT status FROM booking_holds WHERE id = $1`, [hid]);
    assert(holdRow[0]?.status === 'released', 'photographer: hold released', holdRow);
    const shoots = await q(`SELECT id FROM shoot_bookings WHERE photographer_id = $1`, [ph]);
    assert(shoots.length === 0 && piCreates === before, 'photographer: no shoot booking, no PaymentIntent', { shoots, before, after: piCreates });

    // Staff booking: service paused during the hold.
    r = await hold({ providerType: 'business', providerId: bizA, staffMemberId: staffA, serviceId: stLivePay });
    assert(ok(r), 'staff hold on a live staff service', r);
    hid = holdIdOf(r);
    await q(`UPDATE staff_services SET status = 'archived' WHERE id = $1`, [stLivePay]);
    before = piCreates;
    r = await call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body: {} });
    assert(refused(r), 'staff create-payment-intent after the staff service was archived → refused', r);
    appts = await q(`SELECT id FROM appointments WHERE hold_id = $1`, [hid]);
    assert(appts.length === 0 && piCreates === before, 'staff: no appointment, no PaymentIntent', { appts, before, after: piCreates });

    // Paid plan lapses past grace during the hold (the pause job hasn't run, the service is still live).
    r = await hold({ providerType: 'business', providerId: bizD, serviceId: sDuring });
    assert(ok(r), 'hold while the plan is active', r);
    hid = holdIdOf(r);
    await q(`UPDATE vendor_subscriptions SET status = 'past_due', past_due_since = now() - interval '10 days' WHERE business_id = $1`, [bizD]);
    before = piCreates;
    r = await call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body: {} });
    assert(refused(r), 'create-payment-intent after the plan lapsed during the hold → refused', r);
    appts = await q(`SELECT id FROM appointments WHERE hold_id = $1`, [hid]);
    assert(appts.length === 0 && piCreates === before, 'lapsed during hold: no appointment, no PaymentIntent', { appts, before, after: piCreates });

    console.log('\n── 8. a booking already created keeps working (resume is untouched) ──');
    r = await hold({ providerType: 'business', providerId: bizA, serviceId: sLiveResume });
    hid = holdIdOf(r);
    r = await call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body: {} });
    assert(r.status === 200 && !!r.body?.clientSecret, 'first payment attempt on a live service → 200', r);
    await q(`UPDATE vendor_services SET status = 'paused' WHERE id = $1`, [sLiveResume]);
    r = await call('POST', `/api/booking/${hid}/create-payment-intent`, { token, body: {} });
    assert(r.status === 200 && !!r.body?.clientSecret, 'resuming that payment after a pause → still 200 (already created)', r);

    console.log('\n── 9. R3: the unauthenticated test routes no longer run ──');
    // An unknown path falls through to the web app's page (server/static.ts / vite.ts send index.html, 200),
    // so "removed" means: no JSON from the old handler, no booking rows, no PaymentIntent.
    const draftsBefore = (await q(`SELECT (SELECT count(*) FROM appointments)::int + (SELECT count(*) FROM shoot_bookings)::int AS n`))[0].n;
    for (const p of ['/api/dev/test-booking', '/api/dev/test-appointment', '/api/dev/test-payment-intent']) {
      before = piCreates;
      r = await call('POST', p, { body: { amount: 100 } });
      assert(r.status === 200 && r.contentType.includes('text/html') && r.body === null, `POST ${p} → old handler gone (web app page, no JSON)`, { status: r.status, contentType: r.contentType, body: r.body });
      assert(piCreates === before, `POST ${p} → no PaymentIntent`, { before, after: piCreates });
    }
    const draftsAfter = (await q(`SELECT (SELECT count(*) FROM appointments)::int + (SELECT count(*) FROM shoot_bookings)::int AS n`))[0].n;
    assert(draftsAfter === draftsBefore, 'test routes created no appointment or shoot booking', { draftsBefore, draftsAfter });
  } finally {
    const allBiz = bizs;
    await q(`DELETE FROM appointments WHERE business_id = ANY($1)`, [allBiz]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE photographer_id = ANY($1)`, [photogs]).catch(() => {});
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [[...allBiz, ...photogs]]).catch(() => {});
    await q(`DELETE FROM weekly_availability WHERE provider_id = ANY($1)`, [[...allBiz, ...photogs]]).catch(() => {});
    await q(`DELETE FROM staff_services WHERE business_id = ANY($1)`, [allBiz]).catch(() => {});
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [allBiz]).catch(() => {});
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [allBiz]).catch(() => {});
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [allBiz]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [allBiz]).catch(() => {});
    await q(`DELETE FROM photographer_services WHERE photographer_id = ANY($1)`, [photogs]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id = ANY($1)`, [photogs]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
