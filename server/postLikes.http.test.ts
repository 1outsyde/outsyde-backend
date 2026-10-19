/**
 * Post likes HTTP tests — run with:
 *   npx tsx server/postLikes.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema +
 * migration 061), and the same database here:
 *   LIKES_TEST_BASE_URL   e.g. http://localhost:5093            (must be localhost)
 *   LIKES_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 * It skips (exit 0) when LIKES_TEST_BASE_URL is unset and refuses any non-local host, so it can
 * never touch Neon or production.
 *
 * Rules under test:
 *  - POST/DELETE /api/feed/:postId/like accept the app's Bearer token with NO session cookie
 *    (the app's session expires after 7 days, its token doesn't). Session still works. No auth → 401.
 *  - Response shape unchanged: { success, liked } / { success, unliked }.
 *  - Liking twice, or 20 times at once (fast double tap), keeps one row and counts once.
 *  - Unlike removes it and the count goes back down; unliking again is harmless.
 *  - GET /api/profiles/:userId/posts gains isLiked per viewer (Bearer or session), false logged out,
 *    and keeps every existing field.
 */

const BASE = process.env.LIKES_TEST_BASE_URL;
const PG_URL = process.env.LIKES_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set LIKES_TEST_BASE_URL (+ LIKES_TEST_PG_URL) to run the HTTP tests');
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
  const P = `lk-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = 'local-test-pass-123';
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const who of ['author', 'viewer', 'other']) {
    await q(`INSERT INTO users (id, username, email, password, name) VALUES ($1::varchar, $2, $3, $4, $5)`,
      [id(who), `${who}${Date.now().toString(36)}`, `${id(who)}@x.test`, hash, `Likes ${who}`]);
  }
  const photo = id('photo');
  const second = id('second');
  await q(`INSERT INTO feed_posts (id, author_id, author_type, post_type, content, media_url, image_url, feed_surface, display_layout, is_active, likes_count)
           VALUES ($1, $2, 'consumer', 'image', 'like me', 'https://r2.test.example/p.jpg', 'https://r2.test.example/p.jpg', 'pro', 'pro', true, 0)`, [photo, id('author')]);
  await q(`INSERT INTO feed_posts (id, author_id, author_type, post_type, content, media_url, image_url, feed_surface, display_layout, is_active, likes_count)
           VALUES ($1, $2, 'consumer', 'image', 'second', 'https://r2.test.example/s.jpg', 'https://r2.test.example/s.jpg', 'pro', 'pro', true, 0)`, [second, id('author')]);

  let ipSeq = 0;
  async function call(method: string, path: string, o: { bearer?: string; cookie?: string } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.95.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
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
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.94.0.${++ipSeq % 250 + 1}` },
      body: JSON.stringify({ email: `${id(who)}@x.test`, password: PASSWORD }),
    });
    const body: any = await r.json();
    const sid = (r.headers as any).getSetCookie?.().find((c: string) => c.startsWith('connect.sid='));
    if (r.status !== 200 || !body?.accessToken) throw new Error(`login failed for ${who}: ${r.status}`);
    return { token: body.accessToken as string, cookie: sid ? sid.split(';')[0] : '' };
  }
  const likeRows = async (user: string, post: string) => Number((await q(
    `SELECT count(*)::int AS n FROM post_likes WHERE user_id = $1 AND post_id = $2`, [id(user), post]))[0].n);
  const likesCount = async (post: string) => Number((await q(
    `SELECT likes_count FROM feed_posts WHERE id = $1`, [post]))[0].likes_count);
  const profilePost = (r: any, pid: string) => (r.body?.posts || []).find((p: any) => p.id === pid);

  const viewer = await login('viewer');
  const other = await login('other');
  // The app's case: a valid token and NO session cookie (cookie expired after 7 days).
  const bearer = { bearer: viewer.token };

  try {
    console.log('\nauth');
    let r = await call('POST', `/api/feed/${photo}/like`);
    assert(r.status === 401 && r.body?.error === 'Not authenticated', 'no auth → 401 (unchanged)', { status: r.status, body: r.body });
    r = await call('POST', `/api/feed/${photo}/like`, { bearer: 'not-a-real-token' });
    assert(r.status === 401, 'bad token and no session → 401', { status: r.status });
    r = await call('DELETE', `/api/feed/${photo}/like`);
    assert(r.status === 401, 'unlike with no auth → 401 (unchanged)', { status: r.status });
    assert(await likesCount(photo) === 0, 'nothing counted by refused calls');

    console.log('\nlike with the app token only (no session cookie)');
    r = await call('POST', `/api/feed/${photo}/like`, bearer);
    assert(r.status === 200 && r.body?.success === true && r.body?.liked === true && !r.sid,
      'POST like → 200 { success: true, liked: true }', { status: r.status, body: r.body });
    assert(await likeRows('viewer', photo) === 1 && await likesCount(photo) === 1, 'one row, likes_count 1');

    r = await call('POST', `/api/feed/${photo}/like`, bearer);
    assert(r.status === 200 && r.body?.success === true && r.body?.liked === false,
      'liking again → 200 { liked: false } (unchanged meaning: already liked)', { status: r.status, body: r.body });
    const burst = await Promise.all(Array.from({ length: 20 }, () => call('POST', `/api/feed/${second}/like`, bearer)));
    assert(burst.every(b => b.status === 200), '20 likes at once (fast double tap) → all 200', burst.map(b => b.status));
    assert(burst.filter(b => b.body?.liked === true).length === 1, 'exactly one of them reports liked: true',
      burst.map(b => b.body?.liked));
    assert(await likeRows('viewer', second) === 1 && await likesCount(second) === 1, 'still one row and likes_count 1 after the burst',
      { rows: await likeRows('viewer', second), count: await likesCount(second) });
    assert(await likesCount(photo) === 1, 'first post count untouched by the burst');

    console.log('\nsession cookie still works (web)');
    r = await call('POST', `/api/feed/${photo}/like`, { cookie: other.cookie });
    assert(r.status === 200 && r.body?.liked === true, 'like with session cookie only → liked', { status: r.status, body: r.body, hadCookie: !!other.cookie });
    assert(await likesCount(photo) === 2, 'likes_count 2 with two users');

    console.log('\nisLiked on profile posts');
    r = await call('GET', `/api/profiles/${id('author')}/posts`, bearer);
    let pp = profilePost(r, photo);
    assert(r.status === 200 && pp?.isLiked === true && profilePost(r, second)?.isLiked === true,
      'viewer (Bearer) → isLiked true on both liked posts', { status: r.status, pp });
    assert(pp?.caption === 'like me' && pp?.mediaUrl === 'https://r2.test.example/p.jpg' && Array.isArray(pp?.mediaItems)
      && pp?.likesCount === 2 && pp?.userId === id('author'),
      'existing fields unchanged (caption, mediaUrl, mediaItems, likesCount, userId)', pp);
    r = await call('GET', `/api/profiles/${id('author')}/posts`, { cookie: other.cookie });
    assert(profilePost(r, photo)?.isLiked === true && profilePost(r, second)?.isLiked === false,
      'other (session) → true only on the post they liked', (r.body?.posts || []).map((p: any) => [p.id, p.isLiked]));
    r = await call('GET', `/api/profiles/${id('author')}/posts`);
    assert(r.status === 200 && (r.body?.posts || []).length === 2 && (r.body?.posts || []).every((p: any) => p.isLiked === false),
      'logged out → 200, isLiked false', { status: r.status });

    console.log('\nunlike with the app token only');
    r = await call('DELETE', `/api/feed/${photo}/like`, bearer);
    assert(r.status === 200 && r.body?.success === true && r.body?.unliked === true,
      'DELETE like → 200 { success: true, unliked: true }', { status: r.status, body: r.body });
    assert(await likeRows('viewer', photo) === 0 && await likesCount(photo) === 1, 'row gone, count back to 1');
    r = await call('DELETE', `/api/feed/${photo}/like`, bearer);
    assert(r.status === 200 && r.body?.unliked === false && await likesCount(photo) === 1,
      'unliking again → 200 { unliked: false }, count unchanged', { status: r.status, body: r.body });
    r = await call('POST', `/api/feed/${photo}/like`, bearer);
    assert(r.status === 200 && r.body?.liked === true && await likesCount(photo) === 2, 'like again after unlike → counted again');

    console.log('\nfeed isLiked still works');
    r = await call('GET', `/api/feed/${photo}`, bearer);
    assert(r.status === 200 && r.body?.post?.id === photo, 'GET /api/feed/:id still 200', { status: r.status });
  } finally {
    await q(`DELETE FROM post_likes WHERE post_id IN ($1, $2)`, [photo, second]);
    await q(`DELETE FROM feed_posts WHERE id IN ($1, $2)`, [photo, second]);
    await q(`DELETE FROM sessions WHERE sess::text LIKE $1`, [`%${P}%`]).catch(() => {});
    await q(`DELETE FROM refresh_tokens WHERE user_id LIKE $1`, [`${P}%`]).catch(() => {});
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}%`]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
