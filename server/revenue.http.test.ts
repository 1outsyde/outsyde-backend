/**
 * Revenue rule (Part A) — HTTP integration tests
 *
 * Run with: npx tsx server/revenue.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres that has the
 * full schema incl. migration 048, and NO other rows in appointments / orders / shoot_bookings
 * (the admin totals are checked exactly). Environment variables:
 *
 *   RV_TEST_BASE_URL   e.g. http://localhost:5072   (must be localhost)
 *   RV_TEST_PG_URL     the SAME scratch database     (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 *
 * Skips (exit 0) when RV_TEST_BASE_URL is unset and refuses any non-local host.
 *
 * What it proves (one business, everything dated today):
 *  - pending_payment, pending_provider, expired, declined and a cancel that only released an
 *    authorization add $0; unpaid / cancelled orders add $0
 *  - deposits count as the deposit; no-deposit bookings count the price; no-show keeps the deposit;
 *    a captured cancel keeps what was not refunded; the kept cancellation fee is NOT business revenue
 *  - the in-person balance (due / collected) is right and additive
 *  - every business route agrees: business/stats, vendor analytics (daily, weekly, monthly,
 *    forecast, by-service, booking-health), dashboard/analytics
 *  - admin stats / revenue use the same rule and add the Outsyde-only cancellation fee
 *  - a vendor marking an order paid records paid_at
 */
import http from 'http';

const BASE = process.env.RV_TEST_BASE_URL;
const PG_URL = process.env.RV_TEST_PG_URL;

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
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.7.7' };
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
  if (!BASE) { console.log('⏭  skipped: set RV_TEST_BASE_URL (+ RV_TEST_PG_URL) to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'rv-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const [{ n }] = await q(`SELECT ((SELECT COUNT(*) FROM appointments) + (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM shoot_bookings))::int AS n`);
  if (n !== 0) throw new Error('refusing to run: scratch DB must start with no appointments, orders or shoot bookings');

  const P = `rv${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const today = new Date().toISOString().slice(0, 10);
  const vendorId = id('vendor');
  const clientId = id('client');
  const adminId = id('admin');
  const bizId = id('biz');

  try {
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [vendorId, `${vendorId}@rv.test`]);
    await q(`INSERT INTO users (id, username, email) VALUES ($1::varchar, $1::text, $2)`, [clientId, `${clientId}@rv.test`]);
    await q(`INSERT INTO users (id, username, email, is_admin) VALUES ($1::varchar, $1::text, $2, true)`, [adminId, 'info@goutsyde.com']); // scratch DB only: the admin guard checks the allowed email list
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1, $2, 'RV Biz', 'beauty', 'approved')`, [bizId, vendorId]);

    // [key, status, total_price, deposit, settled, refund, feeKept]
    const appts: [string, string, number, number | null, boolean, number | null, number | null][] = [
      ['a1', 'pending_payment', 21000, null, false, null, null],   // #A0033 shape → $0
      ['a2', 'pending_provider', 10000, 3000, false, null, null],  // authorized only → $0
      ['a3', 'confirmed', 20000, 3000, true, null, null],          // $30, due $170
      ['a4', 'completed', 15000, null, true, null, null],          // $150, nothing in person
      ['a5', 'completed', 20000, 5000, true, null, null],          // $50, collected $150
      ['a6', 'no_show', 20000, 3000, true, null, null],            // $30 kept
      ['a7', 'canceled', 20000, 3000, true, null, 1000],           // $30 deposit kept; $10 fee is Outsyde's
      ['a8', 'canceled', 10000, null, false, null, null],          // released authorization → $0
      ['a9', 'canceled', 10000, null, true, 4000, null],           // $100 − $40 refund = $60
      ['a10', 'expired', 5000, null, false, null, null],
      ['a11', 'declined', 5000, null, false, null, null],
    ];
    let slot = 8;
    for (const [k, status, total, dep, settled, refund, fee] of appts) {
      const time = `${String(slot++).padStart(2, '0')}:00`;
      await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, deposit_amount_cents, status, settled_at, refund_amount, refunded_at, cancellation_fee_kept_cents)
               VALUES ($1, $2, $3, $4, $10, $5, $6, $7, ${settled ? 'now()' : 'NULL'}, $8, ${refund ? 'now()' : 'NULL'}, $9)`,
        [id(k), bizId, clientId, today, total, dep, status, refund, fee, time]);
    }
    // Orders: paid with paid_at, delivered from before 048 (no paid_at), pending, cancelled.
    await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount, status, paid_at) VALUES ($1, $2, $3, '[]', 4000, 'paid', now())`, [id('o1'), bizId, clientId]);
    await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount, status) VALUES ($1, $2, $3, '[]', 1000, 'delivered')`, [id('o4'), bizId, clientId]);
    await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount, status) VALUES ($1, $2, $3, '[]', 9999, 'pending')`, [id('o2'), bizId, clientId]);
    await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount, status) VALUES ($1, $2, $3, '[]', 7777, 'cancelled')`, [id('o3'), bizId, clientId]);

    const vendorToken = generateAccessToken({ userId: vendorId, isVendor: true, businessId: bizId });
    const adminToken = generateAccessToken({ userId: adminId, isVendor: false, isAdmin: true });

    const BOOKINGS = 3000 + 15000 + 5000 + 3000 + 3000 + 6000; // 35000
    const ORDERS = 4000 + 1000;                                // 5000
    const TOTAL = BOOKINGS + ORDERS;                           // 40000

    console.log('GET /api/business/stats');
    let r = await call('GET', '/api/business/stats', { token: vendorToken });
    eq(r.status, 200, 'status 200');
    eq(r.body?.stats?.monthlyRevenueCents, TOTAL, 'monthlyRevenueCents = $400 (no pending, deposits only, refunds out, no fee)');
    eq(r.body?.stats?.inPersonDueCents, 17000, 'inPersonDueCents = $170');
    eq(r.body?.stats?.inPersonCollectedCents, 15000, 'inPersonCollectedCents = $150');
    eq(r.body?.stats?.bookingCount, 3, 'bookingCount = confirmed + completed');
    eq(r.body?.stats?.orderCount, 2, 'orderCount = paid orders');
    eq(Object.keys(r.body?.stats ?? {}).sort(), ['averageRating', 'bookingCount', 'inPersonCollectedCents', 'inPersonDueCents', 'monthlyRevenueCents', 'orderCount', 'reviewCount'], 'existing keys kept, two added');

    console.log('GET /api/vendor/analytics/*');
    r = await call('GET', '/api/vendor/analytics/daily', { token: vendorToken });
    const todayRow = (r.body?.days ?? []).find((d: any) => d.date === today);
    eq(r.body?.days?.length, 7, 'daily has 7 days');
    eq(todayRow?.revenue_cents, TOTAL, 'daily today = $400 (orders + bookings)');
    eq(todayRow?.order_count, 2, 'daily order_count = paid orders only');
    eq(todayRow?.booking_count, 4, 'daily booking_count = confirmed + completed + no_show');

    r = await call('GET', '/api/vendor/analytics/weekly', { token: vendorToken });
    eq(r.body?.days?.map((d: any) => d.label), ['6wk', '5wk', '4wk', '3wk', 'Last', 'This'], 'weekly always 6 fixed labels');
    eq(r.body?.days?.[5]?.revenue_cents, TOTAL, 'weekly This = $400');
    eq(r.body?.days?.[5]?.order_count, 2, 'weekly This order_count = 2');
    eq(r.body?.days?.[5]?.booking_count, 4, 'weekly This booking_count = 4');

    r = await call('GET', '/api/vendor/analytics/monthly', { token: vendorToken });
    const lastMonth = r.body?.days?.[r.body.days.length - 1];
    eq(lastMonth?.revenue_cents, TOTAL, 'monthly current = $400');
    eq(lastMonth?.booking_count, 4, 'monthly booking_count = 4');

    r = await call('GET', '/api/vendor/analytics/revenue-forecast', { token: vendorToken });
    eq(r.body?.mtd_cents, TOTAL, 'forecast mtd_cents = $400');

    r = await call('GET', '/api/vendor/analytics/revenue-by-service', { token: vendorToken });
    eq((r.body?.services ?? []).reduce((s: number, x: any) => s + x.revenue_cents, 0), BOOKINGS, 'by-service total = $350');

    r = await call('GET', '/api/vendor/analytics/booking-health', { token: vendorToken });
    eq(r.body?.booked_count, 4, 'booking-health booked_count excludes pending');
    eq(r.body?.conversion_rate <= 100, true, 'conversion rate never over 100%');

    console.log('GET /api/dashboard/analytics');
    r = await call('GET', '/api/dashboard/analytics?period=30d', { token: vendorToken });
    eq(r.body?.data?.totalRevenue, TOTAL, 'dashboard totalRevenue = $400');
    eq(r.body?.data?.totalOrders, 2, 'dashboard totalOrders = 2');
    eq(r.body?.data?.totalBookings, 3, 'dashboard totalBookings = confirmed + completed');

    console.log('Admin');
    r = await call('GET', '/api/admin/stats', { token: adminToken });
    eq(r.body?.stats?.totalRevenue, (TOTAL + 1000) / 100, 'admin totalRevenue = $410 in dollars (incl. Outsyde cancellation fee)');
    r = await call('GET', '/api/admin/revenue?period=30d', { token: adminToken });
    eq(r.body?.data?.grossMerchandiseValue, TOTAL, 'admin GMV = $400');
    eq(r.body?.data?.refundsIssued, 4000, 'admin refundsIssued = $40 (real refunds now read)');

    console.log('paid_at');
    r = await call('PATCH', `/api/business/orders/${id('o2')}`, { token: vendorToken, body: { status: 'paid' } });
    const [o2] = await q(`SELECT status, paid_at FROM orders WHERE id = $1`, [id('o2')]);
    eq(o2?.status === 'paid' ? !!o2.paid_at : 'not-paid:' + r.status, true, 'vendor marking an order paid records paid_at');
  } finally {
    await q(`DELETE FROM appointments WHERE business_id = $1`, [bizId]);
    await q(`DELETE FROM orders WHERE business_id = $1`, [bizId]);
    await q(`DELETE FROM businesses WHERE id = $1`, [bizId]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [[vendorId, clientId, adminId]]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
