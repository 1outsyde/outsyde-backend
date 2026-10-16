/**
 * Past-closing toggle (migration 044) — HTTP integration tests.
 *
 * Run with: npx tsx server/pastClosing.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres
 * (full schema + migration 044 + no_overlapping_active_holds). Environment variables:
 *   PC_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PC_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when PC_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation check: replace `allowPastClosing` with `false` in fitsOpenHours's caller inside
 * checkProviderAvailability → the "hold at 10:30 for 400 min succeeds when ON" assertion fails.
 */
import http from 'http';

const BASE = process.env.PC_TEST_BASE_URL;
const PG_URL = process.env.PC_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; bizId?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.2.1' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    if (o.bizId) headers['x-business-id'] = o.bizId;
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
  if (!BASE) { console.log('⏭  skipped: set PC_TEST_BASE_URL + PC_TEST_PG_URL to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'pc-test-jwt';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `pc${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = []; const bizs: string[] = [];

  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@pc.test`, isVendor]);
    users.push(uid); return uid;
  };
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', 'approved', $4, true)`,
      [bid, ownerId, `Biz ${key}`, `acct_${bid.replace(/-/g, '')}`]);
    bizs.push(bid); return bid;
  };
  const mkSvc = async (key: string, bizId: string, mins: number) => {
    const sid = id(key);
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status) VALUES ($1, $2, $3, 20000, $4, true, 'live')`, [sid, bizId, `Svc ${key}`, mins]);
    return sid;
  };
  // Braids With Love shape: every day 10:30 AM - 5:00 PM, stored as 12-hour text
  const mkHours = async (bizId: string, staffId: string | null, start = '10:30 AM', end = '5:00 PM') => {
    for (let dow = 0; dow <= 6; dow++) {
      await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, staff_member_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, $4, $5, $6, true)`,
        [id(`wa-${bizId.slice(-2)}-${staffId ? 's' : 'b'}-${dow}`), bizId, staffId, dow, start, end]);
    }
  };
  const [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true LIMIT 1`);
  const mkSub = async (bizId: string, vendorId: string) => q(
    `INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_end) VALUES ($1, $2, $3, $4, 'active', now() + interval '30 days')`,
    [id(`sub-${bizId.slice(-2)}`), vendorId, bizId, tier.id]);

  const vendorId = await mkUser('v', true);
  const bizId = await mkBiz('b', vendorId);
  await mkSub(bizId, vendorId);
  await mkHours(bizId, null);
  const svcLong = await mkSvc('long', bizId, 400);   // 6 h 40 min
  const svcShort = await mkSvc('short', bizId, 60);
  const customerId = await mkUser('c', false);
  const customer2Id = await mkUser('c2', false);
  const vendorToken = generateAccessToken({ userId: vendorId, isVendor: true, isAdmin: false } as any);
  const customerToken = generateAccessToken({ userId: customerId, isVendor: false, isAdmin: false } as any);
  const customer2Token = generateAccessToken({ userId: customer2Id, isVendor: false, isAdmin: false } as any);

  // a date 10 days out
  const d = new Date(Date.now() + 10 * 86400000);
  const date = d.toISOString().slice(0, 10);
  const slotsUrl = (mins: number, extra = '') => `/api/availability/slots?providerType=business&providerId=${bizId}&date=${date}&serviceDurationMinutes=${mins}${extra}`;
  const avail = (r: any) => (r.body?.slots || []).filter((s: any) => s.available);

  try {
    console.log('\n=== Toggle OFF (default): unchanged ===');
    const [row0] = await q(`SELECT allow_past_closing FROM businesses WHERE id = $1`, [bizId]);
    assert(row0.allow_past_closing === false, 'new business defaults to allow_past_closing = false');
    let r = await call('GET', slotsUrl(400));
    assert(r.status === 200 && avail(r).length === 0, '400-min service: 0 slots when OFF (the reported bug)', r.body?.totalAvailable);
    r = await call('GET', slotsUrl(60));
    const short = avail(r);
    assert(short.length > 0 && short[short.length - 1].startTime === '16:00', '60-min service: last start 16:00 when OFF', short.slice(-1));
    r = await call('POST', '/api/booking/validate', { body: { providerType: 'business', providerId: bizId, serviceId: svcLong, date, startTime: '10:30' } });
    assert(r.status === 400 && r.body?.errorCode, 'validate 400-min at 10:30 rejected when OFF', r);
    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { providerType: 'business', providerId: bizId, serviceId: svcLong, date, startTime: '10:30' } });
    assert(r.status >= 400, 'hold 400-min at 10:30 rejected when OFF', r);
    r = await call('GET', `/api/businesses/${bizId}`);
    const pub = r.body?.business ?? r.body;
    assert(r.status === 200 && pub?.allowPastClosing === false, 'public business DTO exposes allowPastClosing=false', r.status);

    console.log('\n=== Turning it on through PATCH /api/vendor/my-business ===');
    r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { allowPastClosing: 'yes' } });
    assert(r.status === 400, 'non-boolean allowPastClosing → 400', r);
    r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { allowPastClosing: true } });
    assert(r.status === 200, 'PATCH allowPastClosing=true → 200', r);
    const [row1] = await q(`SELECT allow_past_closing FROM businesses WHERE id = $1`, [bizId]);
    assert(row1.allow_past_closing === true, 'column saved as true');
    r = await call('GET', '/api/vendor/my-business', { token: vendorToken });
    assert(r.body?.business?.allowPastClosing === true, 'GET my-business returns allowPastClosing=true');
    r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { tagline: 'unrelated save' } });
    const [row2] = await q(`SELECT allow_past_closing FROM businesses WHERE id = $1`, [bizId]);
    assert(r.status === 200 && row2.allow_past_closing === true, 'unrelated profile save leaves the toggle alone');

    console.log('\n=== Toggle ON ===');
    r = await call('GET', slotsUrl(400));
    const long = avail(r);
    assert(long.length > 0, '400-min service now has slots', r.body?.totalAvailable);
    assert(long[0]?.startTime === '10:30' && long[0]?.endTime === '17:10', 'first slot 10:30 → 17:10', long[0]);
    assert(long[long.length - 1]?.startTime === '16:45', 'last start 16:45 (before 5:00 PM closing)', long.slice(-1));
    assert(long.every((s: any) => s.endTime <= '23:59'), 'no slot ends after 23:59');
    r = await call('GET', `/api/availability/calendar?providerType=business&providerId=${bizId}&year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}&serviceDurationMinutes=400`);
    const day = (r.body?.days || []).find((x: any) => x.date === date);
    assert(day?.hasAvailability === true, 'month calendar shows the day as available', day);
    r = await call('GET', slotsUrl(60));
    assert(avail(r)[avail(r).length - 1]?.startTime === '16:45', '60-min service may start up to 16:45 when ON', avail(r).slice(-1));
    r = await call('GET', slotsUrl(800));
    const huge = avail(r);
    assert(huge.length > 0 && huge.every((s: any) => s.endTime <= '23:59'), '800-min service: only starts that end by 23:59', huge.slice(-1));
    r = await call('POST', '/api/booking/validate', { body: { providerType: 'business', providerId: bizId, serviceId: svcLong, date, startTime: '10:30' } });
    assert(r.status === 200 && r.body?.valid === true && r.body?.endTime === '17:10', 'validate 400-min at 10:30 OK, endTime 17:10', r);
    r = await call('POST', '/api/booking/validate', { body: { providerType: 'business', providerId: bizId, serviceId: svcShort, date, startTime: '17:00' } });
    assert(r.status === 400, 'validate start AT closing (17:00) still rejected', r);
    r = await call('POST', '/api/booking/validate', { body: { providerType: 'business', providerId: bizId, serviceId: svcShort, date, startTime: '10:00' } });
    assert(r.status === 400, 'validate start before opening still rejected', r);

    r = await call('POST', '/api/booking/hold', { token: customerToken, body: { providerType: 'business', providerId: bizId, serviceId: svcLong, date, startTime: '10:30' } });
    assert(r.status === 200 || r.status === 201, 'hold at 10:30 for 400 min succeeds when ON', r);
    assert(r.body?.endTime === '17:10', 'hold endTime 17:10', r.body?.endTime);
    r = await call('GET', slotsUrl(60));
    const afterHold = (r.body?.slots || []) as any[];
    const s1645 = afterHold.find((s) => s.startTime === '16:45');
    assert(s1645 && s1645.available === false && s1645.reason === 'held', 'after-closing part of a hold blocks overlapping slots', s1645);
    r = await call('POST', '/api/booking/hold', { token: customer2Token, body: { providerType: 'business', providerId: bizId, serviceId: svcShort, date, startTime: '16:30' } });
    assert(r.status >= 400, 'second customer cannot hold 16:30 (overlaps the after-closing part)', r);

    console.log('\n=== Blocks after closing still respected ===');
    const utc = (local: string) => new Date(local).toISOString().slice(0, 19).replace('T', ' ');
    const d2 = new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10);
    await q(`INSERT INTO provider_blocks (id, provider_type, provider_id, start_at, end_at) VALUES ($1, 'business', $2, $3::timestamp, $4::timestamp)`,
      // timestamps are stored as UTC; the slot engine compares in the server's local time
      [id('blk'), bizId, utc(`${d2}T18:00:00`), utc(`${d2}T19:00:00`)]);
    r = await call('GET', `/api/availability/slots?providerType=business&providerId=${bizId}&date=${d2}&serviceDurationMinutes=400`);
    const b = avail(r);
    assert(b.length > 0 && b.every((s: any) => s.endTime <= '18:00' || s.startTime >= '19:00'), 'no slot overlaps an 18:00-19:00 block', b.slice(-2));

    console.log('\n=== Staff schedules unaffected ===');
    const staffUserId = await mkUser('st', false);
    const staffId = id('staff');
    await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, role, status, stripe_onboarding_complete) VALUES ($1, $2, $3, 'Staff PC', 'staff', 'active', true)`, [staffId, bizId, staffUserId]).catch((e) => { console.log('   (staff insert skipped:', e.message, ')'); });
    const hasStaff = (await q(`SELECT 1 FROM staff_members WHERE id = $1`, [staffId])).length > 0;
    if (hasStaff) {
      await mkHours(bizId, staffId);
      r = await call('GET', slotsUrl(400, `&staffMemberId=${staffId}`));
      assert(avail(r).length === 0, 'staff schedule: 400-min service still 0 slots (toggle is business-level only)', r.body?.totalAvailable);
    }

    console.log('\n=== Turning it off again ===');
    r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { allowPastClosing: false } });
    r = await call('GET', `/api/availability/slots?providerType=business&providerId=${bizId}&date=${d2}&serviceDurationMinutes=400`);
    assert(avail(r).length === 0, 'OFF again → 0 slots for 400-min service', r.body?.totalAvailable);
  } finally {
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM provider_blocks WHERE provider_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM weekly_availability WHERE provider_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
