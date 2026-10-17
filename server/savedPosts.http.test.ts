/**
 * Saved posts HTTP tests — run with:
 *   npx tsx server/savedPosts.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema),
 * and the same database here:
 *   SAVED_TEST_BASE_URL   e.g. http://localhost:5092            (must be localhost)
 *   SAVED_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 * It skips (exit 0) when SAVED_TEST_BASE_URL is unset and refuses any non-local host, so it can
 * never touch Neon or production.
 *
 * Rules under test:
 *  - POST/DELETE /api/feed/:postId/save and GET /api/users/me/saved-posts accept the app's
 *    Bearer token with NO session cookie (the app's session expires after 7 days, its token doesn't).
 *  - The session cookie still works (web), and no auth is still 401.
 *  - Saving twice, or several times at once, never errors and keeps one row.
 *  - isSaved is true/false per viewer on GET /api/feed, GET /api/pulse/feed and GET /api/feed/:postId,
 *    and false for logged-out viewers.
 */

const BASE = process.env.SAVED_TEST_BASE_URL;
const PG_URL = process.env.SAVED_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set SAVED_TEST_BASE_URL (+ SAVED_TEST_PG_URL) to run the HTTP tests');
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
  const P = `svp-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = 'local-test-pass-123';
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const who of ['author', 'viewer', 'other']) {
    await q(`INSERT INTO users (id, username, email, password, name) VALUES ($1::varchar, $2, $3, $4, $5)`,
      [id(who), `${who}${Date.now().toString(36)}`, `${id(who)}@x.test`, hash, `Saved ${who}`]);
  }
  const photo = id('photo');
  const video = id('video');
  const gone = id('gone');
  await q(`INSERT INTO feed_posts (id, author_id, author_type, post_type, content, media_url, image_url, feed_surface, display_layout, is_active)
           VALUES ($1, $2, 'consumer', 'image', 'saved photo', 'https://r2.test.example/p.jpg', 'https://r2.test.example/p.jpg', 'pro', 'pro', true)`, [photo, id('author')]);
  await q(`INSERT INTO feed_posts (id, author_id, author_type, post_type, content, media_url, media_type, feed_surface, display_layout, is_active)
           VALUES ($1, $2, 'consumer', 'video', 'saved video', 'https://stream.test.example/v.m3u8', 'video', 'pulse', 'pulse', true)`, [video, id('author')]);
  await q(`INSERT INTO feed_posts (id, author_id, author_type, post_type, content, media_url, feed_surface, is_active)
           VALUES ($1, $2, 'consumer', 'image', 'deleted post', 'https://r2.test.example/g.jpg', 'pro', false)`, [gone, id('author')]);

  let ipSeq = 0;
  async function call(method: string, path: string, o: { bearer?: string; cookie?: string } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.97.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
    if (o.cookie) headers.Cookie = o.cookie;
    const r = await fetch(BASE + path, { method, headers });
    const sid = (r.headers as any).getSetCookie?.().find((c: string) => c.startsWith('connect.sid='));
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text, sid: sid ? sid.split(';')[0] : '' };
  }
  async function login(who: string) {
    const r = await fetch(BASE + '/api/auth/mobile/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.96.0.${++ipSeq % 250 + 1}` },
      body: JSON.stringify({ email: `${id(who)}@x.test`, password: PASSWORD }),
    });
    const body: any = await r.json();
    const sid = (r.headers as any).getSetCookie?.().find((c: string) => c.startsWith('connect.sid='));
    if (r.status !== 200 || !body?.accessToken) throw new Error(`login failed for ${who}: ${r.status}`);
    return { token: body.accessToken as string, cookie: sid ? sid.split(';')[0] : '' };
  }
  const savedRows = async (user: string, post?: string) => Number((await q(
    `SELECT count(*)::int AS n FROM user_saved_posts WHERE user_id = $1 ${post ? 'AND post_id = $2' : ''}`,
    post ? [id(user), post] : [id(user)]))[0].n);
  const listIds = (r: any) => (r.body?.posts || []).map((p: any) => p.id);

  const viewer = await login('viewer');
  const other = await login('other');
  // The app's case: a valid token and NO session cookie (cookie expired after 7 days).
  const bearer = { bearer: viewer.token };

  try {
    console.log('\nauth');
    let r = await call('POST', `/api/feed/${photo}/save`);
    assert(r.status === 401, 'no auth → 401 (unchanged)', { status: r.status });
    r = await call('POST', `/api/feed/${photo}/save`, { bearer: 'not-a-real-token' });
    assert(r.status === 401, 'bad token and no session → 401', { status: r.status });

    console.log('\nsave with the app token only (no session cookie)');
    r = await call('POST', `/api/feed/${photo}/save`, bearer);
    assert(r.status === 200 && r.body?.success === true && r.body?.saved === true && !r.sid,
      'POST save → 200 { success, saved: true }', { status: r.status, body: r.body });
    assert(await savedRows('viewer', photo) === 1, 'one row stored for the viewer');

    r = await call('POST', `/api/feed/${photo}/save`, bearer);
    assert(r.status === 200 && r.body?.saved === true, 'saving again → 200, not 500', { status: r.status, body: r.body });
    const burst = await Promise.all(Array.from({ length: 20 }, () => call('POST', `/api/feed/${video}/save`, bearer)));
    assert(burst.every(b => b.status === 200), '20 saves at once (double tap) → all 200', burst.map(b => b.status));
    assert(await savedRows('viewer', photo) === 1 && await savedRows('viewer', video) === 1, 'still exactly one row per post');

    r = await call('POST', `/api/feed/${id('missing')}/save`, bearer);
    assert(r.status === 404, 'unknown post → 404 (unchanged; app migration relies on this)', { status: r.status });

    console.log('\nlist');
    r = await call('GET', '/api/users/me/saved-posts', bearer);
    const ids = listIds(r);
    assert(r.status === 200 && ids.length === 2 && ids[0] === video && ids[1] === photo,
      'GET saved-posts with token → both posts, newest save first', { status: r.status, ids });
    const sp = (r.body?.posts || []).find((p: any) => p.id === photo);
    assert(sp?.mediaUrl === 'https://r2.test.example/p.jpg' && sp?.caption === 'saved photo' && Array.isArray(sp?.mediaItems),
      'response shape unchanged (mediaUrl, caption, mediaItems)', sp);
    r = await call('GET', '/api/users/me/saved-posts', { bearer: other.token });
    assert(r.status === 200 && listIds(r).length === 0, "another user's list is empty (saves are per user)", { ids: listIds(r) });
    r = await call('GET', '/api/users/me/saved-posts');
    assert(r.status === 401, 'list without auth → 401', { status: r.status });

    console.log('\nisSaved on post detail');
    r = await call('GET', `/api/feed/${photo}`, bearer);
    assert(r.status === 200 && r.body?.post?.isSaved === true && r.body?.post?.id === photo, 'GET /api/feed/:id → isSaved true for the saver', r.body?.post?.isSaved);
    r = await call('GET', `/api/feed/${photo}`, { bearer: other.token });
    assert(r.status === 200 && r.body?.post?.isSaved === false, 'isSaved false for another user', r.body?.post?.isSaved);
    r = await call('GET', `/api/feed/${photo}`);
    assert(r.status === 200 && r.body?.post?.isSaved === false && r.body?.post?.content === 'saved photo', 'logged out → isSaved false, rest of post unchanged', r.body?.post);
    r = await call('GET', `/api/feed/${gone}`, bearer);
    assert(r.status === 404, 'inactive post → 404 (unchanged)', { status: r.status });

    console.log('\nisSaved on the feeds');
    r = await call('GET', '/api/feed?limit=50', bearer);
    const feedPost = (r.body?.data?.posts || r.body?.posts || []).find((p: any) => p.id === photo);
    assert(r.status === 200 && feedPost?.isSaved === true, 'GET /api/feed → isSaved true on the saved post', { status: r.status, found: !!feedPost, isSaved: feedPost?.isSaved });
    r = await call('GET', '/api/feed?limit=50');
    const anonFeed = (r.body?.data?.posts || r.body?.posts || []).find((p: any) => p.id === photo);
    assert(r.status === 200 && anonFeed && anonFeed.isSaved === false, 'GET /api/feed logged out → isSaved false', { found: !!anonFeed, isSaved: anonFeed?.isSaved });

    r = await call('GET', '/api/pulse/feed?limit=50', bearer);
    const vids = r.body?.videos || r.body?.data?.videos || [];
    const card = vids.find((v: any) => v.id === video);
    assert(r.status === 200 && card?.isSaved === true && card?.isLiked === false, 'GET /api/pulse/feed → isSaved true, isLiked unchanged', { status: r.status, found: !!card, card: card && { isSaved: card.isSaved, isLiked: card.isLiked } });
    r = await call('GET', '/api/pulse/feed?limit=50', { bearer: other.token });
    const otherCard = (r.body?.videos || r.body?.data?.videos || []).find((v: any) => v.id === video);
    assert(otherCard?.isSaved === false, 'Pulse → isSaved false for another user', { found: !!otherCard });

    console.log('\nunsave');
    r = await call('DELETE', `/api/feed/${photo}/save`, bearer);
    assert(r.status === 200 && r.body?.saved === false, 'DELETE save with token → 200 { saved: false }', { status: r.status, body: r.body });
    assert(await savedRows('viewer', photo) === 0, 'row removed');
    r = await call('DELETE', `/api/feed/${photo}/save`, bearer);
    assert(r.status === 200, 'unsaving again → 200 (unchanged)', { status: r.status });
    r = await call('GET', `/api/feed/${photo}`, bearer);
    assert(r.body?.post?.isSaved === false, 'isSaved back to false');
    r = await call('DELETE', `/api/feed/${video}/save`);
    assert(r.status === 401, 'DELETE without auth → 401', { status: r.status });

    console.log('\nsession cookie still works (web)');
    if (other.cookie) {
      r = await call('POST', `/api/feed/${photo}/save`, { cookie: other.cookie });
      assert(r.status === 200 && await savedRows('other', photo) === 1, 'POST save with session cookie only → 200', { status: r.status });
      r = await call('GET', '/api/users/me/saved-posts', { cookie: other.cookie });
      assert(r.status === 200 && listIds(r).includes(photo), 'list with session cookie only', { ids: listIds(r) });
      r = await call('DELETE', `/api/feed/${photo}/save`, { cookie: other.cookie });
      assert(r.status === 200 && await savedRows('other', photo) === 0, 'DELETE with session cookie only', { status: r.status });
    } else {
      assert(false, 'mobile login set no session cookie (expected one)');
    }

    console.log('\ninactive posts');
    await q(`INSERT INTO user_saved_posts (user_id, post_id) VALUES ($1, $2)`, [id('viewer'), gone]);
    r = await call('GET', '/api/users/me/saved-posts', bearer);
    assert(!listIds(r).includes(gone), 'a saved post that was deleted is not listed (unchanged filter)', { ids: listIds(r) });
  } finally {
    const users = [id('author'), id('viewer'), id('other')];
    await q(`DELETE FROM user_saved_posts WHERE user_id = ANY($1)`, [users]);
    await q(`DELETE FROM post_distribution WHERE post_id = ANY($1)`, [[photo, video, gone]]).catch(() => {});
    await q(`DELETE FROM feed_engagement_events WHERE post_id = ANY($1)`, [[photo, video, gone]]).catch(() => {});
    await q(`DELETE FROM feed_posts WHERE author_id = $1`, [id('author')]);
    await q(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [users]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch((e: any) => console.warn('user cleanup:', e.message));
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
