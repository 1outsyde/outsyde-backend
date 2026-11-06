/**
 * R40 hidden business address — HTTP integration tests.
 *
 * Run with: npx tsx server/hiddenAddress.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres:
 *   HA_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   HA_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when HA_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Covers: GET /api/businesses/:id, /api/businesses and /api/vendors drop street, zip and map spot
 * when show_address is false (and keep them when true); GET /api/my-appointments gives a hidden
 * address only on confirmed / completed / no_show bookings; GET /api/unified-search never sends
 * latitude / longitude. Mutation checks: see server/hiddenAddress.test.ts; also drop the map in the
 * unified-search route → "unified search: no latitude" fails.
 */
import http from 'http';

const BASE = process.env.HA_TEST_BASE_URL;
const PG_URL = process.env.HA_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const headers: Record<string, string> = { 'X-Forwarded-For': '10.99.6.1' };
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log('⏭  skipped: set HA_TEST_BASE_URL + HA_TEST_PG_URL to run'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ha-test-jwt';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `ha${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = []; const bizs: string[] = [];
  const [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true ORDER BY sort_order, created_at LIMIT 1`);
  if (!tier) throw new Error('No active subscription_tiers in the scratch DB');

  const mkUser = async (key: string, isVendor = false) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@ha.test`, isVendor]);
    users.push(uid); return uid;
  };
  const mkBiz = async (key: string, showAddress: boolean) => {
    const owner = await mkUser(`${key}-o`, true);
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, show_address, address, city, state, zip_code, latitude, longitude)
             VALUES ($1, $2, $3, 'beauty', 'approved', $4, true, $5, '12 Hidden St', 'Freeport', 'NY', '11520', 40.6576, -73.5832)`,
      [bid, owner, `HA ${key} ${P}`, `acct_${bid.replace(/-/g, '')}`, showAddress]);
    await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, stripe_subscription_id, current_period_end) VALUES ($1, $2, $3, $4, 'active', $5, now() + interval '30 days')`,
      [id(`sub-${key}`), owner, bid, tier.id, `sub_${bid}`]);
    await q(`UPDATE businesses SET subscription_active = true WHERE id = $1`, [bid]).catch(() => {});
    bizs.push(bid); return bid;
  };

  const hiddenBiz = await mkBiz('hid', false);
  const shownBiz = await mkBiz('shw', true);
  const customer = await mkUser('c');
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false });

  const statuses = ['confirmed', 'completed', 'no_show', 'pending_payment', 'pending_provider', 'expired', 'canceled', 'declined'];
  let n = 0;
  for (const bid of [hiddenBiz, shownBiz]) {
    for (const s of statuses) {
      n++;
      await q(`INSERT INTO appointments (id, business_id, client_id, appointment_date, appointment_time, total_price, status) VALUES ($1, $2, $3, '2026-12-01', $4, 5000, $5)`,
        [id(`ap-${bid === hiddenBiz ? 'h' : 's'}-${s}`), bid, customer, `${String(8 + (n % 10)).padStart(2, '0')}:00`, s]);
    }
  }
  await q(`INSERT INTO search_index (entity_type, entity_id, name, city, state, latitude, longitude, is_active, has_active_subscription, is_demo) VALUES ('business', $1, $2, 'Freeport', 'NY', 40.6576, -73.5832, true, true, false)`,
    [hiddenBiz, `HA search ${P}`]);

  try {
    console.log('\n── 1. business profile ──');
    let r = await call('GET', `/api/businesses/${hiddenBiz}`);
    let b = r.body?.business ?? r.body;
    assert(r.status === 200, 'hidden business profile loads', r);
    assert(b?.address === null && b?.zipCode === null, 'hidden profile: no street, no zip', b && { address: b.address, zipCode: b.zipCode });
    assert(b?.latitude === null && b?.longitude === null, 'hidden profile: no map spot', b && { lat: b.latitude, lng: b.longitude });
    assert(b?.city === 'Freeport' && b?.state === 'NY' && b?.showAddress === false, 'hidden profile: city, state and the switch stay', b);
    r = await call('GET', `/api/businesses/${shownBiz}`);
    b = r.body?.business ?? r.body;
    assert(b?.address === '12 Hidden St' && b?.zipCode === '11520' && b?.latitude != null, 'shown profile: unchanged', b && { address: b.address, zip: b.zipCode, lat: b.latitude });

    console.log('\n── 2. business list and vendor list ──');
    for (const path of [`/api/businesses?search=${encodeURIComponent(P)}`, '/api/vendors']) {
      r = await call('GET', path);
      const list: any[] = Array.isArray(r.body) ? r.body : (r.body?.businesses ?? r.body?.vendors ?? []);
      const h = list.find((x) => x.id === hiddenBiz);
      const s = list.find((x) => x.id === shownBiz);
      assert(!!h && h.address === null && h.zipCode === null && h.latitude === null, `${path.split('?')[0]}: hidden business has no street, zip or map spot`, h ?? { status: r.status, count: list.length });
      assert(!!s && s.address === '12 Hidden St', `${path.split('?')[0]}: shown business unchanged`, s ?? { count: list.length });
    }

    console.log('\n── 3. my appointments ──');
    r = await call('GET', '/api/my-appointments', { token });
    const appts: any[] = r.body?.appointments ?? [];
    assert(r.status === 200 && appts.length === statuses.length * 2, 'customer sees all their bookings', { status: r.status, count: appts.length });
    for (const s of statuses) {
      const h = appts.find((a) => a.id === id(`ap-h-${s}`));
      const want = ['confirmed', 'completed', 'no_show'].includes(s) ? '12 Hidden St' : null;
      assert(h?.businessAddress === want, `hidden business, ${s}: address ${want ? 'shared' : 'not shared'}`, h && { status: h.status, businessAddress: h.businessAddress });
      assert(h?.businessCity === 'Freeport', `hidden business, ${s}: city still shown`, h && { businessCity: h.businessCity });
      const sh = appts.find((a) => a.id === id(`ap-s-${s}`));
      assert(sh?.businessAddress === '12 Hidden St', `shown business, ${s}: address unchanged`, sh && { businessAddress: sh.businessAddress });
    }
    assert(appts.every((a) => !('businessShowAddress' in a)), 'internal switch not added to the response');

    console.log('\n── 4. unified search ──');
    r = await call('GET', `/api/unified-search?q=${encodeURIComponent(`HA search ${P}`)}`);
    const hits: any[] = r.body?.results ?? [];
    const hit = hits.find((x) => x.entityId === hiddenBiz);
    assert(r.status === 200 && !!hit, 'search finds the business', { status: r.status, hits: hits.length });
    assert(!!hit && !('latitude' in hit) && !('longitude' in hit), 'unified search: no latitude / longitude', hit);
    assert(!!hit && hit.city === 'Freeport' && typeof r.body?.total === 'number', 'unified search: city and total kept', r.body);
  } finally {
    await q(`DELETE FROM search_index WHERE entity_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM appointments WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
