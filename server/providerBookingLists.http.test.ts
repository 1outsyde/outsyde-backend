/**
 * Dashboard booking lists + vendor-site time zone (Part D) — tests
 *
 * Run (LOCAL only): backend booted on localhost against a scratch Postgres, same JWT_SECRET.
 *   PD_TEST_BASE_URL=http://localhost:5072 PD_TEST_PG_URL=postgresql://outsyde:outsyde@localhost:5432/outsyde \
 *   JWT_SECRET=<same as server> npx tsx server/providerBookingLists.http.test.ts
 *
 * What it proves:
 *  - GET /api/business/bookings, /api/business/appointments, /api/staff/my-bookings and
 *    /api/photographers/me/bookings leave out draft and pending_payment by default and still return
 *    pending_provider, confirmed, completed, canceled, declined, expired and no_show
 *  - ?status=<one status> returns exactly that status (pending_payment included)
 *  - photographer totalEarnedCents is unchanged by the filter
 *  - business stats still count from every row (bookingCount = confirmed + completed)
 *  - POST /api/me/time-zone with businessId: the owner can set it, a platform admin can set it
 *    without touching the admin's own businesses, anyone else gets 403, unknown id 404
 */
import http from 'http';

const BASE = process.env.PD_TEST_BASE_URL;
const PG_URL = process.env.PD_TEST_PG_URL;

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.7.11' };
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
  const { filterProviderBookings } = await import('./providerBookingLists');
  console.log('Rule');
  const rows = ['draft', 'pending_payment', 'pending_provider', 'confirmed', 'completed', 'canceled', 'declined', 'expired', 'no_show'].map((status) => ({ status }));
  eq(filterProviderBookings(rows).map((r) => r.status), ['pending_provider', 'confirmed', 'completed', 'canceled', 'declined', 'expired', 'no_show'], 'default leaves out draft and pending_payment only');
  eq(filterProviderBookings(rows, 'pending_payment').map((r) => r.status), ['pending_payment'], '?status=pending_payment returns exactly that');
  eq(filterProviderBookings(rows, '').length, 7, 'empty status param = default');

  if (!BASE || !PG_URL) { console.log('\n⏭  HTTP sections skipped: set PD_TEST_BASE_URL and PD_TEST_PG_URL'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }
  if (!isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: localhost only');

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ab-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `pd${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users = { owner: id('owner'), staff: id('staffer'), photog: id('photog'), client: id('client'), other: id('other'), admin: id('admin') };
  const bizId = id('biz'), adminBizId = id('adminbiz'), staffId = id('staff'), photogId = id('ph'), svcId = id('svc');
  const statuses = ['draft', 'pending_payment', 'pending_provider', 'confirmed', 'completed', 'expired'];
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  try {
    for (const [k, u] of Object.entries(users)) {
      await q(`INSERT INTO users (id, username, email, name, is_vendor, is_photographer, is_admin) VALUES ($1::varchar, $1::text, $2, $3, $4, $5, $6)`,
        [u, k === 'admin' ? `pd-admin-${P}@example.test` : `${u}@pd.test`, k, k === 'owner' || k === 'admin', k === 'photog', k === 'admin']);
    }
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'PD Biz', 'beauty', 'approved')`, [bizId, users.owner]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'PD Admin Biz', 'beauty', 'approved')`, [adminBizId, users.admin]);
    await q(`INSERT INTO staff_members (id, business_id, user_id, display_name) VALUES ($1, $2, $3, 'PD Staff')`, [staffId, bizId, users.staff]);
    for (const [i, s] of statuses.entries()) {
      await q(`INSERT INTO appointments (id, business_id, client_id, staff_member_id, appointment_date, appointment_time, total_price, status, vendor_net)
               VALUES ($1, $2, $3, $4, $5, $6, 5000, $7, 4900)`, [id(`a-${s}`), bizId, users.client, staffId, day, `0${8 + i}:00`.slice(-5), s]);
    }
    const allDays = JSON.stringify(Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((d) => [d, { open: '08:00', close: '20:00' }])));
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, city, state, hours_of_operation, stripe_account_id, stripe_onboarding_complete, is_demo, auto_accept_bookings, visibility_status, created_at, updated_at)
             VALUES ($1, $2, 'PD Photog', 10000, 'Austin', 'TX', $3::jsonb, $4, true, false, true, 'public', now(), now())`, [photogId, users.photog, allDays, `acct_${P}`]);
    await q(`INSERT INTO photographer_services (id, photographer_id, name, price_cents, estimated_duration_minutes, is_active, status, pricing_model, is_contact_for_pricing, created_at)
             VALUES ($1, $2, 'PD Shoot', 7000, 60, true, 'live', 'package', false, now())`, [svcId, photogId]);
    for (const [i, s] of statuses.entries()) {
      await q(`INSERT INTO shoot_bookings (id, duration_hours, shoot_type, photographer_id, client_id, service_id, date, start_time, end_time, total_price, vendor_net, status)
               VALUES ($1, 1, 'portrait', $2, $3, $4, $5, $6, $7, 7000, 6860, $8)`, [id(`s-${s}`), photogId, users.client, svcId, day, `${10 + i}:00`, `${11 + i}:00`, s]);
    }

    const tok = (u: string, o: { isVendor?: boolean; isAdmin?: boolean } = {}) => generateAccessToken({ userId: u, isVendor: !!o.isVendor, isAdmin: !!o.isAdmin } as any);
    const owner = tok(users.owner, { isVendor: true });
    const visible = ['pending_provider', 'confirmed', 'completed', 'expired'];
    const sorted = (a: any[]) => a.map((r) => r.status).sort();

    console.log('GET /api/business/bookings');
    let r = await call('GET', '/api/business/bookings', { token: owner });
    eq(sorted(r.body?.bookings ?? []), [...visible].sort(), 'default: no draft, no unpaid checkout');
    r = await call('GET', '/api/business/bookings?status=pending_payment', { token: owner });
    eq(sorted(r.body?.bookings ?? []), ['pending_payment'], '?status=pending_payment still available');

    console.log('GET /api/business/appointments');
    r = await call('GET', '/api/business/appointments?limit=50', { token: owner });
    eq(sorted(r.body?.appointments ?? []), [...visible].sort(), 'default: no draft, no unpaid checkout');
    r = await call('GET', '/api/business/appointments?status=pending_provider', { token: owner });
    eq(sorted(r.body?.appointments ?? []), ['pending_provider'], '?status=pending_provider = real requests only');
    r = await call('GET', '/api/business/appointments?status=expired', { token: owner });
    eq(sorted(r.body?.appointments ?? []), ['expired'], 'expired stays findable with ?status=expired');

    console.log('GET /api/staff/my-bookings');
    r = await call('GET', '/api/staff/my-bookings', { token: tok(users.staff) });
    eq(sorted(r.body?.bookings ?? []), [...visible].sort(), 'default: no draft, no unpaid checkout');

    console.log('GET /api/photographers/me/bookings');
    r = await call('GET', '/api/photographers/me/bookings', { token: tok(users.photog) });
    eq(sorted(r.body?.bookings ?? []), [...visible].sort(), 'default: no draft, no unpaid checkout');
    eq(r.body?.totalEarnedCents, 6860 * 2, 'totalEarnedCents unchanged (confirmed + completed)');
    r = await call('GET', '/api/photographers/me/bookings?status=draft', { token: tok(users.photog) });
    eq(sorted(r.body?.bookings ?? []), ['draft'], '?status=draft returns exactly that');

    console.log('Stats still see every row');
    r = await call('GET', '/api/business/stats', { token: owner });
    eq(r.body?.stats?.bookingCount ?? r.body?.bookingCount, 2, 'bookingCount = confirmed + completed');

    console.log('POST /api/me/time-zone with businessId');
    r = await call('POST', '/api/me/time-zone', { token: tok(users.other), body: { timeZone: 'America/Chicago', businessId: bizId } });
    eq(r.status, 403, 'someone else cannot set it');
    r = await call('POST', '/api/me/time-zone', { token: owner, body: { timeZone: 'America/Chicago', businessId: 'nope' } });
    eq(r.status, 404, 'unknown business → 404');
    r = await call('POST', '/api/me/time-zone', { token: owner, body: { timeZone: 'America/Chicago', businessId: bizId } });
    eq([r.status, r.body?.businessesUpdated], [200, 1], 'owner sets it');
    const tzOf = async (b: string) => (await q(`SELECT time_zone FROM businesses WHERE id = $1`, [b]))[0]?.time_zone ?? null;
    r = await call('POST', '/api/me/time-zone', { token: tok(users.admin, { isVendor: true, isAdmin: true }), body: { timeZone: 'America/Denver', businessId: bizId, overwrite: true } });
    // Platform admin = is_admin AND an allowed admin email; this test user's email is not on the list.
    eq([r.status, await tzOf(bizId)], [403, 'America/Chicago'], 'is_admin without an allowed admin email is refused');
    // A real platform admin on this LOCAL scratch DB: the info@goutsyde.com row (made one if missing).
    let [realAdmin] = await q(`SELECT id, is_admin FROM users WHERE email = 'info@goutsyde.com'`);
    if (!realAdmin) {
      await q(`UPDATE users SET email = 'info@goutsyde.com' WHERE id = $1`, [users.admin]);
      realAdmin = { id: users.admin, is_admin: true };
    }
    const restoreAdminFlag = realAdmin.is_admin;
    await q(`UPDATE users SET is_admin = true WHERE id = $1`, [realAdmin.id]);
    {
      r = await call('POST', '/api/me/time-zone', { token: tok(realAdmin.id, { isVendor: true, isAdmin: true }), body: { timeZone: 'America/Denver', businessId: bizId, overwrite: true } });
      eq([r.status, await tzOf(bizId), await tzOf(adminBizId)], [200, 'America/Denver', null], 'platform admin sets the site business, not their own');
      await q(`UPDATE users SET is_admin = $2 WHERE id = $1`, [realAdmin.id, restoreAdminFlag]);
    }
  } finally {
    await q(`DELETE FROM appointments WHERE business_id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM shoot_bookings WHERE photographer_id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM photographer_services WHERE id = $1`, [svcId]).catch(() => {});
    await q(`DELETE FROM photographers WHERE id = $1`, [photogId]).catch(() => {});
    await q(`DELETE FROM staff_members WHERE id = $1`, [staffId]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [[bizId, adminBizId]]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(users)]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
