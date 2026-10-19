/**
 * Follows HTTP tests — run with:
 *   npx tsx server/follows.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema),
 * and the same database here:
 *   FOLLOWS_TEST_BASE_URL   e.g. http://localhost:5093            (must be localhost)
 *   FOLLOWS_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 * Skips (exit 0) when FOLLOWS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Rules under test (2026-10-19):
 *  - Follow / unfollow / check work with the app's Bearer token only (no session cookie).
 *  - Following twice (or 10 at once) = success, one row. Unfollowing when not following = success.
 *  - "New follower" notification is sent once per follower, even after unfollow + follow again.
 *  - Blocked either way: follow → 403, no notification. Blocking removes follows both ways.
 *  - Lists: business owner shows as the business (name, logo, role, businessId); isFollowing per
 *    viewer; banned and blocked accounts hidden; :userId accepts a business id; limit capped at 100.
 *  - GET /api/feed?scope=following: only followed accounts, newest first, no own posts;
 *    logged out → empty + requiresAuth. Main feed: authorIsFollowed, followed authors rank higher.
 */

const BASE = process.env.FOLLOWS_TEST_BASE_URL;
const PG_URL = process.env.FOLLOWS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set FOLLOWS_TEST_BASE_URL (+ FOLLOWS_TEST_PG_URL) to run the HTTP tests');
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

  // ── seed ─────────────────────────────────────────────────────────────
  const P = `fw-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = 'local-test-pass-123';
  const hash = await bcrypt.hash(PASSWORD, 4);
  const people = ['viewer', 'alice', 'bob', 'owner', 'banned', 'blocker', 'other'];
  for (const who of people) {
    await q(`INSERT INTO users (id, username, email, password, name, first_name, last_name, profile_image_url)
             VALUES ($1::varchar, $2, $3, $4, $5, 'Realfirst', 'Reallast', $6)`,
      [id(who), `${who}${Date.now().toString(36)}`, `${id(who)}@x.test`, hash, `Disp ${who}`, `https://r2.test.example/${who}.jpg`]);
  }
  await q(`UPDATE users SET is_vendor = true WHERE id = $1`, [id('owner')]);
  await q(`UPDATE users SET is_active = false WHERE id = $1`, [id('banned')]);
  const bizId = id('biz');
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, logo_image)
           VALUES ($1, $2, 'Follow Test Studio', 'beauty', 'approved', 'https://r2.test.example/logo.png')`, [bizId, id('owner')]);

  // Two posts with identical stats; bob's is 10s OLDER, so without a follow alice ranks first.
  const alicePost = id('alice-post');
  const bobPost = id('bob-post');
  const viewerPost = id('viewer-post');
  const insertPost = (pid: string, author: string, ageSec: number) => q(
    `INSERT INTO feed_posts (id, author_id, author_type, post_type, content, media_url, image_url, feed_surface, display_layout, is_active, likes_count, comments_count, created_at)
     VALUES ($1, $2, 'consumer', 'image', 'post', 'https://r2.test.example/p.jpg', 'https://r2.test.example/p.jpg', 'pro', 'pro', true, 0, 0, now() - ($3 || ' seconds')::interval)`,
    [pid, author, String(ageSec)]);
  await insertPost(alicePost, id('alice'), 60);
  await insertPost(bobPost, id('bob'), 70);
  await insertPost(viewerPost, id('viewer'), 5);

  let ipSeq = 0;
  async function call(method: string, path: string, o: { bearer?: string; cookie?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.93.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
    if (o.cookie) headers.Cookie = o.cookie;
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
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.92.0.${++ipSeq % 250 + 1}` },
      body: JSON.stringify({ email: `${id(who)}@x.test`, password: PASSWORD }),
    });
    const body: any = await r.json();
    const sid = (r.headers as any).getSetCookie?.().find((c: string) => c.startsWith('connect.sid='));
    if (r.status !== 200 || !body?.accessToken) throw new Error(`login failed for ${who}: ${r.status}`);
    return { token: body.accessToken as string, cookie: sid ? sid.split(';')[0] : '' };
  }
  const followRows = async (from: string, to: string) => Number((await q(
    `SELECT count(*)::int AS n FROM follows WHERE follower_user_id = $1 AND target_user_id = $2`, [id(from), id(to)]))[0].n);
  const notifCount = async (to: string, from: string) => Number((await q(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'new_follower' AND triggered_by_user_id = $2`, [id(to), id(from)]))[0].n);
  const feedIds = (r: any) => (r.body?.posts || []).map((p: any) => p.id);

  const viewer = await login('viewer');
  const owner = await login('owner');
  const blocker = await login('blocker');
  const other = await login('other');
  const V = { bearer: viewer.token };

  try {
    console.log('\nfollow with the app token only');
    let r = await call('POST', '/api/follows', { body: { targetUserId: id('alice') } });
    assert(r.status === 401, 'no auth → 401');
    r = await call('POST', '/api/follows', { ...V, body: { targetUserId: id('alice') } });
    assert(r.status === 201 && r.body?.success === true && r.body?.follow?.targetUserId === id('alice'), 'follow → 201', r);
    r = await call('GET', `/api/follows/check/${id('alice')}`, V);
    assert(r.status === 200 && r.body?.isFollowing === true, 'check with token → isFollowing true', r.body);
    r = await call('POST', '/api/follows', { ...V, body: { targetUserId: id('alice') } });
    assert(r.status === 200 && r.body?.success === true && r.body?.alreadyFollowing === true, 'following again → 200 alreadyFollowing (was 409)', r);
    const burst = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/follows', { ...V, body: { targetUserId: id('bob') } })));
    assert(burst.every((b) => b.status === 201 || b.status === 200), '10 follows at once → all success, no 500', burst.map((b) => b.status));
    assert(await followRows('viewer', 'bob') === 1, 'one follow row after the burst');
    assert(await notifCount('bob', 'viewer') === 1, 'one notification after the burst');

    console.log('\nnotification once per follower');
    r = await call('DELETE', `/api/follows/${id('alice')}`, V);
    assert(r.status === 200 && r.body?.success === true, 'unfollow → 200');
    r = await call('DELETE', `/api/follows/${id('alice')}`, V);
    assert(r.status === 200 && r.body?.success === true, 'unfollow again → 200 (was 404)', r);
    r = await call('POST', '/api/follows', { ...V, body: { targetUserId: id('alice') } });
    assert(r.status === 201, 'follow again → 201');
    assert(await notifCount('alice', 'viewer') === 1, 'still exactly one notification for alice from viewer', await notifCount('alice', 'viewer'));

    console.log('\nfollow a business by business id');
    r = await call('POST', '/api/follows', { ...V, body: { targetUserId: bizId } });
    assert(r.status === 201 && await followRows('viewer', 'owner') === 1, 'business id resolves to the owner');
    r = await call('POST', '/api/follows', { bearer: owner.token, body: { targetUserId: id('viewer') } });
    assert(r.status === 201, 'business owner follows viewer');
    const ownerNotif = await q(`SELECT message FROM notifications WHERE user_id = $1 AND triggered_by_user_id = $2 AND type = 'new_follower'`, [id('viewer'), id('owner')]);
    assert(ownerNotif[0]?.message === 'Follow Test Studio started following you.', 'notification uses the business name', ownerNotif[0]);

    console.log('\nblocks');
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [id('blocker'), id('viewer')]);
    r = await call('POST', '/api/follows', { ...V, body: { targetUserId: id('blocker') } });
    assert(r.status === 403 && await followRows('viewer', 'blocker') === 0 && await notifCount('blocker', 'viewer') === 0,
      'follow someone who blocked you → 403, no row, no notification', r);
    r = await call('POST', '/api/follows', { bearer: blocker.token, body: { targetUserId: id('viewer') } });
    assert(r.status === 403, 'follow someone you blocked → 403', r);
    // other follows viewer, then viewer blocks other through the route → follow gone both ways
    await call('POST', '/api/follows', { bearer: other.token, body: { targetUserId: id('viewer') } });
    await call('POST', '/api/follows', { ...V, body: { targetUserId: id('other') } });
    assert(await followRows('other', 'viewer') === 1 && await followRows('viewer', 'other') === 1, 'setup: other and viewer follow each other');
    r = await call('POST', `/api/users/${id('other')}/block`, V);
    assert(r.status === 200 && await followRows('other', 'viewer') === 0 && await followRows('viewer', 'other') === 0,
      'blocking removes follows both ways', r.status);

    console.log('\nlists');
    // banned user follows viewer directly in the DB (they can't log in)
    await q(`INSERT INTO follows (id, follower_user_id, target_user_id) VALUES ($1, $2, $3)`, [id('f-banned'), id('banned'), id('viewer')]);
    // blocker follows alice (visible to others, hidden from viewer because blocker blocked viewer)
    await q(`INSERT INTO follows (id, follower_user_id, target_user_id) VALUES ($1, $2, $3)`, [id('f-blocker'), id('blocker'), id('alice')]);

    r = await call('GET', `/api/users/${id('viewer')}/followers`, V);
    const vf = r.body?.followers || [];
    const ownerRow = vf.find((x: any) => x.userId === id('owner'));
    assert(r.status === 200 && ownerRow?.displayName === 'Follow Test Studio' && ownerRow?.profilePhotoUrl === 'https://r2.test.example/logo.png'
      && ownerRow?.role === 'business' && ownerRow?.businessId === bizId && ownerRow?.isFollowing === true && ownerRow?.isSelf === false,
      "viewer's followers: business owner shown as the business, isFollowing true", ownerRow);
    assert(!vf.some((x: any) => x.userId === id('banned')), 'banned account hidden from the list');
    assert(!JSON.stringify(r.body).includes('Realfirst') && !JSON.stringify(r.body).includes('Reallast') && !JSON.stringify(r.body).includes('@x.test'),
      'no real names or emails in the list');
    assert(r.body?.total === 2 && r.body?.limit === 50 && r.body?.offset === 0, 'total is the raw count (owner + banned), paging echoed', { total: r.body?.total });

    r = await call('GET', `/api/users/${id('alice')}/followers`, V);
    const af = (r.body?.followers || []).map((x: any) => x.userId);
    assert(af.includes(id('viewer')) && !af.includes(id('blocker')), "alice's followers for viewer: viewer shown, blocker hidden", af);
    const selfRow = (r.body?.followers || []).find((x: any) => x.userId === id('viewer'));
    assert(selfRow?.isSelf === true && selfRow?.isFollowing === false, 'viewer row marked isSelf');
    r = await call('GET', `/api/users/${id('alice')}/followers`, { bearer: owner.token });
    assert((r.body?.followers || []).some((x: any) => x.userId === id('blocker')), 'someone else still sees blocker in the list');
    r = await call('GET', `/api/users/${id('alice')}/followers`);
    assert(r.status === 200 && (r.body?.followers || []).every((x: any) => x.isFollowing === false), 'logged out → 200, isFollowing false');

    r = await call('GET', `/api/users/${bizId}/followers`, V);
    assert(r.status === 200 && (r.body?.followers || []).some((x: any) => x.userId === id('viewer')), 'business id accepted for lists');
    r = await call('GET', `/api/users/${id('viewer')}/following?limit=1000&offset=-5`, V);
    assert(r.status === 200 && r.body?.limit === 100 && r.body?.offset === 0, 'limit capped at 100, negative offset → 0', { limit: r.body?.limit, offset: r.body?.offset });
    const fo = (r.body?.following || []).map((x: any) => x.userId);
    assert(fo.includes(id('alice')) && fo.includes(id('bob')) && fo.includes(id('owner')), 'viewer following: alice, bob, owner', fo);
    r = await call('GET', '/api/users/me/following', V);
    assert(r.status === 200 && (r.body?.following || []).length === fo.length, '/me/following matches');
    r = await call('GET', '/api/users/me/followers');
    assert(r.status === 401, '/me/followers logged out → 401 (unchanged)');
    r = await call('GET', `/api/users/${id('nobody')}/followers`);
    assert(r.status === 404, 'unknown id → 404 (unchanged)');

    console.log('\nFollowing feed');
    r = await call('GET', '/api/feed?scope=following&limit=50');
    assert(r.status === 200 && r.body?.requiresAuth === true && feedIds(r).length === 0, 'logged out → empty + requiresAuth', r.body?.requiresAuth);
    r = await call('GET', '/api/feed?scope=following&limit=50', V);
    let ids = feedIds(r);
    assert(r.status === 200 && ids.includes(alicePost) && ids.includes(bobPost), 'following feed has alice and bob posts', ids);
    assert(!ids.includes(viewerPost), 'own post not pinned into the following feed');
    assert(ids.indexOf(alicePost) < ids.indexOf(bobPost), 'newest first');
    const fp = (r.body?.posts || []).find((p: any) => p.id === alicePost);
    assert(fp?.authorIsFollowed === true && fp?.author?.userId === id('alice') && typeof fp?.isLiked === 'boolean', 'same enriched shape + authorIsFollowed');
    assert(Array.isArray(r.body?.data?.posts) && 'hasMore' in (r.body?.data || {}), 'data envelope unchanged');
    r = await call('GET', '/api/feed?scope=following&limit=50', { bearer: other.token });
    assert(r.status === 200 && feedIds(r).length === 0, 'someone following nobody → empty');

    console.log('\nmain feed boost');
    // unfollow alice so only bob is followed; bob's post is older with the same stats.
    await call('DELETE', `/api/follows/${id('alice')}`, V);
    r = await call('GET', '/api/feed?limit=50', V);
    ids = feedIds(r);
    assert(ids.includes(alicePost) && ids.includes(bobPost) && ids.indexOf(bobPost) < ids.indexOf(alicePost),
      'viewer follows bob → bob ranks above the newer alice post', { a: ids.indexOf(alicePost), b: ids.indexOf(bobPost) });
    const mp = (r.body?.posts || []);
    assert(mp.find((p: any) => p.id === bobPost)?.authorIsFollowed === true && mp.find((p: any) => p.id === alicePost)?.authorIsFollowed === false,
      'authorIsFollowed true for bob, false for alice');
    assert(ids[0] === viewerPost, 'own posts still pinned on top of the main feed (unchanged)');
    r = await call('GET', '/api/feed?limit=50', { bearer: owner.token });
    ids = feedIds(r);
    assert(ids.indexOf(alicePost) < ids.indexOf(bobPost), 'someone not following bob → newer alice post first (unchanged)', { a: ids.indexOf(alicePost), b: ids.indexOf(bobPost) });
    r = await call('GET', '/api/feed?limit=50');
    assert(r.status === 200 && (r.body?.posts || []).every((p: any) => p.authorIsFollowed === false), 'logged out main feed → authorIsFollowed false');
  } finally {
    const like = `${P}%`;
    await q(`DELETE FROM notifications WHERE user_id LIKE $1 OR triggered_by_user_id LIKE $1`, [like]);
    await q(`DELETE FROM follows WHERE follower_user_id LIKE $1 OR target_user_id LIKE $1`, [like]);
    await q(`DELETE FROM user_blocks WHERE blocker_id LIKE $1 OR blocked_id LIKE $1`, [like]);
    await q(`DELETE FROM feed_posts WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM refresh_tokens WHERE user_id LIKE $1`, [like]).catch(() => {});
    await q(`DELETE FROM users WHERE id LIKE $1`, [like]).catch((e: any) => console.warn('cleanup users:', e.message));
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
