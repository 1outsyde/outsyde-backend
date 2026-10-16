/**
 * Multi-photo posts (feed_posts.media_items, migration 045) HTTP tests — run with:
 *   npx tsx server/feedMediaItems.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema +
 * migration 045), with R2_PUBLIC_URL set on the server, and the same values here:
 *   FEEDMI_TEST_BASE_URL   e.g. http://localhost:5091            (must be localhost)
 *   FEEDMI_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   R2_PUBLIC_URL          identical to the server's (e.g. https://r2.test.example)
 * It skips (exit 0) when FEEDMI_TEST_BASE_URL is unset and refuses any non-local host, so it can
 * never touch Neon or production.
 *
 * Rules under test:
 *  - A create without mediaItems stores exactly what it stored before (media_items = []).
 *  - mediaItems: 2-10 photos, https, inside R2_PUBLIC_URL, photos only; photo 1 also fills
 *    media_url / image_url / media_type / width / height / aspect_ratio.
 *  - Every post read route returns mediaItems.
 */

const BASE = process.env.FEEDMI_TEST_BASE_URL;
const PG_URL = process.env.FEEDMI_TEST_PG_URL;
const R2 = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set FEEDMI_TEST_BASE_URL (+ FEEDMI_TEST_PG_URL, R2_PUBLIC_URL) to run the HTTP tests');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !R2) {
    throw new Error('refusing to run: base URL and database must both be local scratch instances, and R2_PUBLIC_URL must be set');
  }

  const bcryptMod: any = await import('bcrypt');
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── seed ─────────────────────────────────────────────────────────────
  const P = `fmi-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = 'local-test-pass-123';
  const hash = await bcrypt.hash(PASSWORD, 4);
  await q(`INSERT INTO users (id, username, email, password, name) VALUES ($1::varchar, $2, $3, $4, 'Photo Poster')`,
    [id('author'), `fmi${Date.now().toString(36)}`, `${id('author')}@x.test`, hash]);

  let ipSeq = 0;
  let cookie = '';
  async function call(method: string, path: string, o: { body?: unknown; auth?: boolean } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.98.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.auth !== false && cookie) headers.Cookie = cookie;
    let body: string | undefined;
    if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(BASE + path, { method, headers, body });
    const sid = (r.headers as any).getSetCookie?.().find((c: string) => c.startsWith('connect.sid='));
    if (sid) cookie = sid.split(';')[0];
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text };
  }

  const login = await call('POST', '/api/auth/mobile/login', { body: { email: `${id('author')}@x.test`, password: PASSWORD } });
  if (login.status !== 200 || !cookie) throw new Error(`login failed: ${login.status} ${login.text.slice(0, 200)}`);

  const img = (n: number) => `${R2}/posts/${P}-${n}.jpeg`;
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ url: img(i + 1), type: 'image', width: 1080 + i, height: 1350 + i, aspectRatio: 0.8 }));
  const rowOf = async (pid: string) => (await q(`SELECT * FROM feed_posts WHERE id = $1`, [pid]))[0];
  const countPosts = async () => Number((await q(`SELECT count(*)::int AS n FROM feed_posts WHERE author_id = $1`, [id('author')]))[0].n);

  try {
    // ── create: legacy paths unchanged ──────────────────────────────────
    console.log('\ncreate without mediaItems (today\'s behaviour)');
    let r = await call('POST', '/api/feed', { body: { content: 'single', imageUrl: img(100), displayLayout: 'pro', feedSurface: 'pro' } });
    const single = r.body?.post;
    let row = single ? await rowOf(single.id) : null;
    assert(r.status === 200 && row?.media_url === img(100) && row?.image_url === img(100) && row?.media_type === null
      && row?.media_width === null && row?.media_height === null && row?.aspect_ratio === null
      && Array.isArray(row?.media_items) && row.media_items.length === 0 && row?.feed_surface === 'pro',
      'app single photo (imageUrl) → same columns as before, media_items []', { status: r.status, row });
    assert(Array.isArray(single?.mediaItems) && single.mediaItems.length === 0 && single?.media?.mediaUrl === img(100), 'create response: mediaItems [] and media object unchanged', single);

    r = await call('POST', '/api/feed', { body: { content: 'web', media: { url: img(101), type: 'image', width: 800, height: 600, aspectRatio: 1.33 } } });
    row = r.body?.post ? await rowOf(r.body.post.id) : null;
    assert(r.status === 200 && row?.media_url === img(101) && row?.media_type === 'image' && row?.media_width === 800 && row?.media_height === 600
      && row?.aspect_ratio === 1.33 && row?.media_items.length === 0, 'web nested media object → width/height/aspect saved as before', { status: r.status, row });

    r = await call('POST', '/api/feed', { body: { content: 'outside link still allowed on legacy path', imageUrl: 'https://elsewhere.example/a.jpg' } });
    assert(r.status === 200, 'legacy imageUrl outside R2 still accepted (unchanged rule)', { status: r.status, body: r.body });

    r = await call('POST', '/api/feed', { body: { content: 'text only' } });
    assert(r.status === 200 && (await rowOf(r.body?.post?.id))?.media_items.length === 0, 'text-only post still works', { status: r.status });

    r = await call('POST', '/api/feed', { body: { imageUrl: img(102) } , auth: false });
    assert(r.status === 401, 'no session → 401 (auth unchanged)', { status: r.status });

    // ── create: mediaItems ──────────────────────────────────────────────
    console.log('\ncreate with mediaItems');
    r = await call('POST', '/api/feed', { body: { content: 'two', imageUrl: img(1), mediaItems: items(2), displayLayout: 'pro', feedSurface: 'pro' } });
    const two = r.body?.post;
    row = two ? await rowOf(two.id) : null;
    assert(r.status === 200 && row?.media_items.length === 2 && row.media_items[0].url === img(1) && row.media_items[1].url === img(2)
      && row?.media_url === img(1) && row?.image_url === img(1) && row?.media_type === 'image'
      && row?.media_width === 1080 && row?.media_height === 1350 && row?.aspect_ratio === 0.8,
      '2 photos → stored in order; photo 1 fills media_url/image_url/media_type/size', { status: r.status, row });
    assert(two?.mediaItems?.length === 2 && two?.media?.mediaUrl === img(1), 'create response carries mediaItems', two);

    r = await call('POST', '/api/feed', { body: { mediaItems: items(10) } });
    row = r.body?.post ? await rowOf(r.body.post.id) : null;
    assert(r.status === 200 && row?.media_items.length === 10 && row?.media_url === img(1) && row?.content === '', '10 photos, no caption → 200, content ""', { status: r.status, len: row?.media_items?.length });

    r = await call('POST', '/api/feed', { body: { content: 'reversed', mediaItems: [items(3)[2], items(3)[0], items(3)[1]] } });
    row = r.body?.post ? await rowOf(r.body.post.id) : null;
    assert(r.status === 200 && row?.media_url === img(3) && row?.media_items.map((m: any) => m.url).join() === [img(3), img(1), img(2)].join(), 'order kept as sent; media_url = first sent', row?.media_items);

    // ── create: rejections (no row written) ─────────────────────────────
    console.log('\nrejections');
    const before = await countPosts();
    const reject = async (body: unknown, expectCode: string | null, name: string) => {
      const res = await call('POST', '/api/feed', { body });
      const okCode = expectCode === null ? res.body?.error === 'Invalid data' : res.body?.code === expectCode;
      assert(res.status === 400 && okCode, name, { status: res.status, body: res.body });
    };
    await reject({ mediaItems: items(11) }, null, '11 photos → 400 Invalid data');
    await reject({ mediaItems: items(1) }, null, '1 photo in mediaItems → 400 Invalid data');
    await reject({ mediaItems: [] }, null, 'empty mediaItems → 400 Invalid data');
    await reject({ mediaItems: [{ url: img(1), type: 'video' }, { url: img(2), type: 'image' }] }, null, 'item type video → 400 Invalid data');
    await reject({ mediaItems: [{ url: 'http://r2.test.example/posts/a.jpg', type: 'image' }, items(2)[1]] }, null, 'http (not https) → 400 Invalid data');
    await reject({ mediaItems: [{ url: 'not a url', type: 'image' }, items(2)[1]] }, null, 'not a URL → 400 Invalid data');
    await reject({ mediaItems: [{ url: 'https://evil.example/a.jpg', type: 'image' }, items(2)[1]] }, 'INVALID_MEDIA_URL', 'https outside R2 → 400 INVALID_MEDIA_URL');
    await reject({ mediaItems: [{ url: `${R2}.evil.example/a.jpg`, type: 'image' }, items(2)[1]] }, 'INVALID_MEDIA_URL', 'look-alike host (R2 prefix + .evil) → 400 INVALID_MEDIA_URL');
    await reject({ mediaItems: items(2), mediaType: 'video' }, 'MULTI_MEDIA_IMAGES_ONLY', 'mediaType video + mediaItems → 400 MULTI_MEDIA_IMAGES_ONLY');
    await reject({ mediaItems: items(2), feedSurface: 'pulse' }, 'MULTI_MEDIA_IMAGES_ONLY', 'feedSurface pulse + mediaItems → 400');
    await reject({ mediaItems: items(2), videoUrl: 'upload-123' }, 'MULTI_MEDIA_IMAGES_ONLY', 'videoUrl + mediaItems → 400');
    await reject({ mediaItems: items(2), media: { url: img(9), type: 'video' } }, 'MULTI_MEDIA_IMAGES_ONLY', 'media.type video + mediaItems → 400');
    assert((await countPosts()) === before, 'no row written by any rejected request', { before, after: await countPosts() });

    // ── reads ───────────────────────────────────────────────────────────
    console.log('\nreads');
    const twoId = two.id as string;
    const singleId = single.id as string;
    const find = (list: any[], pid: string) => (list || []).find((p: any) => p.id === pid);

    r = await call('GET', '/api/feed?limit=50');
    const feed = r.body?.posts || r.body?.data?.posts;
    assert(r.status === 200 && find(feed, twoId)?.mediaItems?.length === 2 && Array.isArray(find(feed, singleId)?.mediaItems) && find(feed, singleId).mediaItems.length === 0,
      'GET /api/feed → mediaItems on multi post, [] on single', { status: r.status, two: find(feed, twoId)?.mediaItems, single: find(feed, singleId)?.mediaItems });

    r = await call('GET', `/api/feed/${twoId}`, { auth: false });
    assert(r.status === 200 && r.body?.post?.mediaItems?.length === 2, 'GET /api/feed/:id → mediaItems', { status: r.status });

    r = await call('GET', `/api/profiles/${id('author')}/posts`, { auth: false });
    assert(r.status === 200 && find(r.body?.posts, twoId)?.mediaItems?.length === 2 && find(r.body?.posts, singleId)?.mediaItems?.length === 0
      && find(r.body?.posts, twoId)?.mediaUrl === img(1), 'GET /api/profiles/:id/posts → mediaItems (+ mediaUrl = photo 1)', { status: r.status });

    r = await call('GET', `/api/users/${id('author')}/posts`, { auth: false });
    const userPosts = r.body?.posts || r.body?.data?.posts || r.body?.data;
    assert(r.status === 200 && find(userPosts, twoId)?.mediaItems?.length === 2, 'GET /api/users/:id/posts → mediaItems', { status: r.status, keys: Object.keys(r.body || {}) });

    r = await call('POST', `/api/feed/${twoId}/save`);
    const saved = await call('GET', '/api/users/me/saved-posts');
    assert(r.status === 200 && saved.status === 200 && find(saved.body?.posts, twoId)?.mediaItems?.length === 2, 'saved posts → mediaItems', { save: r.status, list: saved.status });

    r = await call('PATCH', `/api/feed/${twoId}`, { body: { content: 'edited caption' } });
    row = await rowOf(twoId);
    assert(r.status === 200 && row?.content === 'edited caption' && row?.media_items.length === 2 && row?.media_url === img(1), 'caption edit keeps photos', { status: r.status });

    r = await call('DELETE', `/api/feed/${twoId}`);
    row = await rowOf(twoId);
    assert(r.status === 200 && row?.is_active === false && row?.media_items.length === 2, 'soft delete keeps the row (and its photos list)', { status: r.status });
  } finally {
    await q(`DELETE FROM user_saved_posts WHERE user_id = $1`, [id('author')]);
    await q(`DELETE FROM feed_posts WHERE author_id = $1`, [id('author')]);
    await q(`DELETE FROM refresh_tokens WHERE user_id = $1`, [id('author')]).catch(() => {});
    await q(`DELETE FROM users WHERE id = $1`, [id('author')]).catch(() => {});
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
