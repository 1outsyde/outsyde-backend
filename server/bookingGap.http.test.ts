/**
 * Gap after every booking (migration 104, businesses.booking_gap_minutes) — HTTP integration tests.
 *
 * Run with: npx tsx server/bookingGap.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres
 * (full schema + migration 104 + no_overlapping_active_holds). Environment variables:
 *   BG_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   BG_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when BG_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Covers all three gates that must agree (slot list + calendar, validate, hold), the hold-to-hold
 * check, staff using their business's gap, the vendor setting (save, read, validation) and gap 0.
 * Mutation checks: pass 0 instead of gapMinutes in generateAvailabilitySlots → "slot list: 11:00
 * not offered" fails; in checkProviderAvailability → "second customer cannot hold 12:15" fails.
 */
import http from 'http';

const BASE = process.env.BG_TEST_BASE_URL;
const PG_URL = process.env.BG_TEST_PG_URL;

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.3.1' };
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
  if (!BASE) { console.log('⏭  skipped: set BG_TEST_BASE_URL + BG_TEST_PG_URL to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'bg-test-jwt';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `bg${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = []; const bizs: string[] = [];

  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@bg.test`, isVendor]);
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
  const mkHours = async (bizId: string, staffId: string | null) => {
    for (let dow = 0; dow <= 6; dow++) {
      await q(`INSERT INTO weekly_availability (id, provider_type, provider_id, staff_member_id, day_of_week, start_time, end_time, is_active) VALUES ($1, 'business', $2, $3, $4, '9:00 AM', '5:00 PM', true)`,
        [id(`wa-${staffId ? 's' : 'b'}-${dow}`), bizId, staffId, dow]);
    }
  };
  const [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true LIMIT 1`);
  const mkSub = async (bizId: string, vendorId: string) => q(
    `INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_end) VALUES ($1, $2, $3, $4, 'active', now() + interval '30 days')`,
    [id(`sub-${bizId.slice(-2)}`), vendorId, bizId, tier.id]);
  const mkAppt = async (key: string, bizId: string, clientId: string, date: string, start: string, end: string, staffId: string | null = null) => q(
    `INSERT INTO appointments (id, business_id, client_id, staff_member_id, appointment_date, appointment_time, appointment_end_time, duration_minutes, total_price, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 60, 20000, 'confirmed')`,
    [id(key), bizId, clientId, staffId, date, start, end]);

  const vendorId = await mkUser('v', true);
  const bizId = await mkBiz('b', vendorId);
  await mkSub(bizId, vendorId);
  await mkHours(bizId, null);
  const svc = await mkSvc('svc', bizId, 60);
  const customerId = await mkUser('c', false);
  const customer2Id = await mkUser('c2', false);
  const vendorToken = generateAccessToken({ userId: vendorId, isVendor: true, isAdmin: false } as any);
  const customerToken = generateAccessToken({ userId: customerId, isVendor: false, isAdmin: false } as any);
  const customer2Token = generateAccessToken({ userId: customer2Id, isVendor: false, isAdmin: false } as any);

  const d = new Date(Date.now() + 10 * 86400000);
  const date = d.toISOString().slice(0, 10);
  const slotsUrl = (extra = '') => `/api/availability/slots?providerType=business&providerId=${bizId}&date=${date}&serviceDurationMinutes=60${extra}`;
  const slotAt = (r: any, t: string) => (r.body?.slots || []).find((s: any) => s.startTime === t);
  const open = (r: any, t: string) => slotAt(r, t)?.available === true;
  const validate = (start: string) => call('POST', '/api/booking/validate', { body: { providerType: 'business', providerId: bizId, serviceId: svc, date, startTime: start } });
  const hold = (token: string, start: string) => call('POST', '/api/booking/hold', { token, body: { providerType: 'business', providerId: bizId, serviceId: svc, date, startTime: start } });

  try {
    console.log('\n=== Default gap is 15 ===');
    const [row0] = await q(`SELECT booking_gap_minutes FROM businesses WHERE id = $1`, [bizId]);
    assert(row0.booking_gap_minutes === 15, 'new business defaults to booking_gap_minutes = 15', row0);
    let r = await call('GET', '/api/vendor/my-business', { token: vendorToken });
    assert(r.status === 200 && r.body?.business?.bookingGapMinutes === 15, 'GET my-business returns bookingGapMinutes = 15', r.body?.business?.bookingGapMinutes);

    console.log('\n=== Existing booking 10:00 to 11:00, gap 15: all three gates agree ===');
    await mkAppt('a1', bizId, customerId, date, '10:00', '11:00');
    r = await call('GET', slotsUrl());
    assert(r.status === 200, 'slot list 200', r.status);
    assert(!open(r, '11:00'), 'slot list: 11:00 not offered (booking ends 11:00, gap 15)', slotAt(r, '11:00'));
    assert(open(r, '11:15'), 'slot list: 11:15 offered', slotAt(r, '11:15'));
    assert(!open(r, '09:00'), 'slot list: 09:00 not offered (would end 10:00 with no gap before the booking)', slotAt(r, '09:00'));
    assert(!open(r, '10:30'), 'slot list: 10:30 not offered (real overlap)', slotAt(r, '10:30'));
    let v = await validate('11:00');
    assert(v.status === 400, 'validate 11:00 rejected', v);
    v = await validate('11:15');
    assert(v.status === 200 && v.body?.valid === true, 'validate 11:15 accepted', v);
    r = await hold(customerToken, '11:00');
    assert(r.status >= 400, 'hold 11:00 rejected', r);
    r = await hold(customerToken, '11:15');
    assert(r.status === 200 || r.status === 201, 'hold 11:15 succeeds', r);

    console.log('\n=== Gap after a hold too (hold 11:15 to 12:15) ===');
    r = await call('GET', slotsUrl());
    assert(!open(r, '12:15'), 'slot list: 12:15 not offered after a hold ending 12:15', slotAt(r, '12:15'));
    assert(open(r, '12:30'), 'slot list: 12:30 offered', slotAt(r, '12:30'));
    v = await validate('12:15');
    assert(v.status === 400, 'validate 12:15 rejected (held + gap)', v);
    r = await hold(customer2Token, '12:15');
    assert(r.status >= 400, 'second customer cannot hold 12:15 (hold to hold gap)', r);
    r = await hold(customer2Token, '12:30');
    assert(r.status === 200 || r.status === 201, 'second customer can hold 12:30', r);

    console.log('\n=== Month calendar still shows the day ===');
    r = await call('GET', `/api/availability/calendar?providerType=business&providerId=${bizId}&year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}&serviceDurationMinutes=60`);
    const day = (r.body?.days || []).find((x: any) => x.date === date);
    assert(day?.hasAvailability === true, 'calendar: day still has openings', day);

    console.log('\n=== Vendor setting ===');
    for (const bad of [7, 90, '15', -15, null]) {
      r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { bookingGapMinutes: bad } });
      assert(r.status === 400 && r.body?.field === 'bookingGapMinutes', `PATCH bookingGapMinutes=${JSON.stringify(bad)} → 400`, r);
    }
    const [rowBad] = await q(`SELECT booking_gap_minutes FROM businesses WHERE id = $1`, [bizId]);
    assert(rowBad.booking_gap_minutes === 15, 'refused values saved nothing', rowBad);

    await mkAppt('a3', bizId, customerId, date, '14:00', '15:00');
    r = await call('GET', slotsUrl());
    assert(open(r, '15:15') && !open(r, '15:00'), 'gap 15: after a 14:00 to 15:00 booking, 15:15 offered and 15:00 not', [slotAt(r, '15:00'), slotAt(r, '15:15')]);
    r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { bookingGapMinutes: 30 } });
    assert(r.status === 200, 'PATCH bookingGapMinutes=30 → 200', r);
    r = await call('GET', slotsUrl());
    assert(!open(r, '15:15'), 'gap 30: 15:15 not offered', slotAt(r, '15:15'));
    assert(open(r, '15:30'), 'gap 30: 15:30 offered', slotAt(r, '15:30'));
    v = await validate('15:15');
    assert(v.status === 400, 'gap 30: validate 15:15 rejected', v);
    v = await validate('15:30');
    assert(v.status === 200, 'gap 30: validate 15:30 accepted', v);

    r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { tagline: 'unrelated save' } });
    const [row30] = await q(`SELECT booking_gap_minutes FROM businesses WHERE id = $1`, [bizId]);
    assert(r.status === 200 && row30.booking_gap_minutes === 30, 'unrelated profile save leaves the gap alone', row30);

    r = await call('PATCH', '/api/vendor/my-business', { token: vendorToken, body: { bookingGapMinutes: 0 } });
    assert(r.status === 200, 'PATCH bookingGapMinutes=0 → 200', r);
    r = await call('GET', '/api/vendor/my-business', { token: vendorToken });
    assert(r.body?.business?.bookingGapMinutes === 0, 'GET my-business returns 0', r.body?.business?.bookingGapMinutes);
    r = await call('GET', slotsUrl());
    assert(open(r, '09:00'), 'gap 0: 09:00 offered again (back to back with 10:00)', slotAt(r, '09:00'));
    v = await validate('09:00');
    assert(v.status === 200, 'gap 0: validate 09:00 accepted', v);

    console.log('\n=== Staff use their business gap ===');
    await q(`UPDATE businesses SET booking_gap_minutes = 15 WHERE id = $1`, [bizId]);
    const staffUserId = await mkUser('st', false);
    const staffId = id('staff');
    await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, role, status, stripe_onboarding_complete) VALUES ($1, $2, $3, 'Staff BG', 'staff', 'active', true)`, [staffId, bizId, staffUserId]).catch((e) => { console.log('   (staff insert skipped:', e.message, ')'); });
    const hasStaff = (await q(`SELECT 1 FROM staff_members WHERE id = $1`, [staffId])).length > 0;
    if (hasStaff) {
      await mkHours(bizId, staffId);
      await mkAppt('a2', bizId, customerId, date, '14:00', '15:00', staffId);
      r = await call('GET', slotsUrl(`&staffMemberId=${staffId}`));
      assert(!open(r, '15:00'), 'staff: 15:00 not offered after a staff booking ending 15:00', slotAt(r, '15:00'));
      assert(open(r, '15:15'), 'staff: 15:15 offered', slotAt(r, '15:15'));
    }
  } finally {
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM appointments WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM weekly_availability WHERE provider_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
