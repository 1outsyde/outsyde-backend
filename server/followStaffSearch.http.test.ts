/**
 * Staff + photographer follows, and the search-ready rule — run with:
 *   npx tsx server/followStaffSearch.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres, and the same DB:
 *   FSS_TEST_BASE_URL   e.g. http://localhost:5093   (must be localhost)
 *   FSS_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 * Skips (exit 0) when FSS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Rules under test (2026-10-21):
 *  - An active staff member can be followed by staff id (resolves to the linked user): follow,
 *    check, unfollow and lists all accept the staff id. Inactive staff id → 404.
 *  - Public staff list adds followerCount / followingCount / canFollow and never the user id.
 *  - Photographer ids work for follow, check, lists and unfollow.
 *  - GET /api/search: a business (and its products, services and staff) shows only when approved,
 *    with an active plan and working payouts (flag + Stripe account). Admins see everything.
 */

const BASE = process.env.FSS_TEST_BASE_URL;
const PG_URL = process.env.FSS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set FSS_TEST_BASE_URL (+ FSS_TEST_PG_URL) to run the HTTP tests');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error('refusing to run: base URL and database must both be local scratch instances');
  }

  const bcryptMod: any = await import('bcrypt');
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `fss-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const TERM = `zq${Date.now().toString(36)}`; // unique word so search only matches our rows
  const PASSWORD = 'local-test-pass-123';
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const who of ['viewer', 'admin', 'staffuser', 'oldstaffuser', 'photog', 'own-ok', 'own-noacct', 'own-nosub', 'own-pending']) {
    await q(`INSERT INTO users (id, username, email, password, name, is_admin, is_vendor, is_photographer)
             VALUES ($1::varchar, $2, $3, $4, $5, $6, $7, $8)`,
      [id(who), `${who.replace(/-/g, '')}${Date.now().toString(36)}`, `${id(who)}@x.test`, hash, `Disp ${who}`,
        who === 'admin', who.startsWith('own'), who === 'photog']);
  }
  const [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true ORDER BY sort_order, created_at LIMIT 1`);
  if (!tier) throw new Error('No active subscription_tiers in the scratch DB');

  // Four businesses: only "ok" is search-ready.
  const biz = { ok: id('b-ok'), noacct: id('b-noacct'), nosub: id('b-nosub'), pending: id('b-pending') };
  const mkBiz = async (key: keyof typeof biz, approval: string, flag: boolean, acct: string | null, sub: boolean) => {
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_onboarding_complete, stripe_account_id)
             VALUES ($1, $2, $3, 'beauty', $4, $5, $6)`, [biz[key], id(`own-${key}`), `${TERM} Biz ${key}`, approval, flag, acct]);
    if (sub) {
      await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_end) VALUES ($1, $2, $3, $4, 'active', $5)`,
        [id(`sub-${key}`), id(`own-${key}`), biz[key], tier.id, new Date(Date.now() + 30 * 86400000).toISOString()]);
    }
    await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, status, is_active) VALUES ($1, $2, $3, 5000, 60, 'live', true)`,
      [id(`svc-${key}`), biz[key], `${TERM} Service ${key}`]);
    await q(`INSERT INTO vendor_products (id, business_id, name, price, status, is_active) VALUES ($1, $2, $3, 2000, 'live', true)`,
      [id(`prod-${key}`), biz[key], `${TERM} Product ${key}`]);
    await q(`INSERT INTO staff_members (id, business_id, display_name, status, stripe_onboarding_complete) VALUES ($1, $2, $3, 'active', true)`,
      [id(`st-${key}`), biz[key], `${TERM} Staff ${key}`]);
  };
  await mkBiz('ok', 'approved', true, 'acct_ok', true);
  await mkBiz('noacct', 'approved', true, null, true);      // flag but no Stripe account (like Lana)
  await mkBiz('nosub', 'approved', true, 'acct_ns', false); // payouts but no plan
  await mkBiz('pending', 'pending', true, 'acct_pd', true);

  // The followable staff member: linked user, active, with a live staff service (public list rule).
  const staffId = id('staff');
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, status, stripe_onboarding_complete) VALUES ($1, $2, $3, 'Staff Pat', 'active', true)`,
    [staffId, biz.ok, id('staffuser')]);
  await q(`INSERT INTO staff_services (id, business_id, staff_member_id, name, price_cents, duration_minutes, status) VALUES ($1, $2, $3, 'Cut', 3000, 30, 'live')`,
    [id('stsvc'), biz.ok, staffId]);
  const oldStaffId = id('oldstaff');
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, status) VALUES ($1, $2, $3, 'Old Staff', 'removed')`,
    [oldStaffId, biz.ok, id('oldstaffuser')]);
  const photogId = id('photographer');
  await q(`INSERT INTO photographers (id, user_id, display_name, visibility_status, hourly_rate) VALUES ($1, $2, 'Photo Pro', 'public', 100)`, [photogId, id('photog')]);

  let ipSeq = 0;
  async function call(method: string, path: string, o: { bearer?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.91.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json };
  }
  async function login(who: string) {
    const r = await fetch(BASE + '/api/auth/mobile/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.90.0.${++ipSeq % 250 + 1}` },
      body: JSON.stringify({ email: `${id(who)}@x.test`, password: PASSWORD }),
    });
    const body: any = await r.json();
    if (r.status !== 200 || !body?.accessToken) throw new Error(`login failed for ${who}: ${r.status}`);
    return body.accessToken as string;
  }
  const followRows = async (from: string, toUser: string) => Number((await q(
    `SELECT count(*)::int AS n FROM follows WHERE follower_user_id = $1 AND target_user_id = $2`, [id(from), toUser]))[0].n);

  const viewer = await login('viewer');
  const admin = await login('admin');
  const V = { bearer: viewer };

  try {
    console.log('\nfollow a staff member by staff id');
    let r = await call('POST', '/api/follows', { ...V, body: { targetUserId: staffId } });
    assert(r.status === 201 && await followRows('viewer', id('staffuser')) === 1, 'staff id → follows the linked user', r);
    r = await call('GET', `/api/follows/check/${staffId}`, V);
    assert(r.body?.isFollowing === true, 'check by staff id → true');
    r = await call('GET', `/api/users/${staffId}/followers`, V);
    assert(r.status === 200 && (r.body?.followers || []).some((x: any) => x.userId === id('viewer')), 'followers list by staff id');
    r = await call('GET', `/api/businesses/${biz.ok}/staff`);
    const pub = (r.body?.staff || []).find((x: any) => x.id === staffId);
    assert(pub?.followerCount === 1 && pub?.followingCount === 0 && pub?.canFollow === true, 'public staff list: followerCount 1, canFollow', pub);
    assert(!JSON.stringify(r.body).includes(id('staffuser')), "public staff list never includes the staff member's user id");
    r = await call('DELETE', `/api/follows/${staffId}`, V);
    assert(r.status === 200 && await followRows('viewer', id('staffuser')) === 0, 'unfollow by staff id');
    r = await call('POST', '/api/follows', { ...V, body: { targetUserId: oldStaffId } });
    assert(r.status === 404 && await followRows('viewer', id('oldstaffuser')) === 0, 'removed staff id → 404, nothing followed', r.status);

    console.log('\nfollow a photographer by photographer id');
    r = await call('POST', '/api/follows', { ...V, body: { targetUserId: photogId, targetType: 'photographer' } });
    assert(r.status === 201 && await followRows('viewer', id('photog')) === 1, 'photographer id → follows the photographer user');
    r = await call('GET', `/api/follows/check/${photogId}`, V);
    assert(r.body?.isFollowing === true, 'check by photographer id → true');
    r = await call('GET', `/api/users/${photogId}/followers`, V);
    assert((r.body?.followers || []).some((x: any) => x.userId === id('viewer')), 'followers list by photographer id');
    r = await call('GET', `/api/photographers/${photogId}`);
    assert((r.body?.photographer?.followerCount ?? r.body?.followerCount) === 1, 'photographer profile shows followerCount 1', r.body?.photographer?.followerCount);
    r = await call('GET', `/api/users/${id('viewer')}/following`, V);
    const prow = (r.body?.following || []).find((x: any) => x.userId === id('photog'));
    assert(prow?.role === 'photographer' && prow?.photographerId === photogId && prow?.displayName === 'Photo Pro', 'following row shows the photographer identity', prow);
    r = await call('DELETE', `/api/follows/${photogId}`, V);
    assert(r.status === 200 && await followRows('viewer', id('photog')) === 0, 'unfollow by photographer id');

    console.log('\nsearch: only complete businesses');
    const ids = (body: any) => (body?.results || []).map((x: any) => x.id);
    r = await call('GET', `/api/search?q=${TERM}&scope=businesses&limit=50`, V);
    let got = ids(r.body);
    assert(r.status === 200 && got.includes(biz.ok), 'complete business shows', got);
    assert(!got.includes(biz.noacct), 'payouts flag without a Stripe account → hidden');
    assert(!got.includes(biz.nosub), 'no active plan → hidden (unchanged)');
    assert(!got.includes(biz.pending), 'not approved → hidden (unchanged)');

    r = await call('GET', `/api/search?q=${TERM}&scope=products&limit=50`, V);
    got = ids(r.body);
    assert(got.includes(id('prod-ok')) && !got.includes(id('prod-noacct')) && !got.includes(id('prod-nosub')) && !got.includes(id('prod-pending')),
      'products: only the complete business', got);
    r = await call('GET', `/api/search?q=${TERM}&scope=services&limit=50`, V);
    got = ids(r.body);
    assert(got.includes(id('svc-ok')) && !got.includes(id('svc-noacct')) && !got.includes(id('svc-nosub')) && !got.includes(id('svc-pending')),
      'services: only the complete business (no plan → now hidden too)', got);
    r = await call('GET', `/api/search?q=${TERM}&scope=staff&limit=50`, V);
    got = ids(r.body);
    assert(got.includes(id('st-ok')) && !got.includes(id('st-noacct')) && !got.includes(id('st-nosub')) && !got.includes(id('st-pending')),
      'staff: only the complete business (staff of unapproved businesses no longer show)', got);
    r = await call('GET', `/api/search?q=${TERM}&scope=all`, V);
    got = ids(r.body);
    assert(got.includes(biz.ok) && !got.includes(biz.noacct) && !got.includes(id('prod-nosub')), 'scope=all follows the same rule', got);
    r = await call('GET', `/api/search?q=${TERM}&scope=businesses&limit=50`);
    assert(ids(r.body).includes(biz.ok) && !ids(r.body).includes(biz.noacct), 'logged out: same rule');

    r = await call('GET', `/api/search?q=${TERM}&scope=businesses&limit=50`, { bearer: admin });
    got = ids(r.body);
    assert(got.includes(biz.ok) && got.includes(biz.noacct) && got.includes(biz.nosub) && got.includes(biz.pending), 'admin still sees every business (unchanged)', got);
    r = await call('GET', `/api/search?q=${TERM}&scope=services&limit=50`, { bearer: admin });
    assert(ids(r.body).includes(id('svc-nosub')), 'admin still sees services of incomplete businesses');
  } finally {
    const like = `${P}%`;
    await q(`DELETE FROM notifications WHERE user_id LIKE $1 OR triggered_by_user_id LIKE $1`, [like]);
    await q(`DELETE FROM follows WHERE follower_user_id LIKE $1 OR target_user_id LIKE $1`, [like]);
    await q(`DELETE FROM staff_services WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM staff_members WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM vendor_services WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM vendor_products WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM vendor_subscriptions WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM photographers WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM refresh_tokens WHERE user_id LIKE $1`, [like]).catch(() => {});
    await q(`DELETE FROM users WHERE id LIKE $1`, [like]).catch((e: any) => console.warn('cleanup users:', e.message));
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
