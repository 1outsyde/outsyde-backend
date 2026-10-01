/**
 * Staff + photographer service image HTTP tests (PR 2) — run with: npx tsx server/serviceImages.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema +
 * migration 039), a fake Stripe for the photographer go-live case, and the same JWT_SECRET here:
 *   SVCIMG_TEST_BASE_URL   e.g. http://localhost:5081            (must be localhost)
 *   SVCIMG_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   JWT_SECRET             identical to the server's
 * It skips (exit 0) when SVCIMG_TEST_BASE_URL is unset and refuses any non-local host, so it can
 * never touch Neon or production.
 *
 * Rules under test (same as vendor_services.image_url): imageUrl is z.string().url().nullable().optional()
 * — a valid URL is saved, null clears, "" is a 400, absent on create is NULL, absent on PATCH leaves
 * the stored image untouched. go-live and archive never touch it.
 */

const BASE = process.env.SVCIMG_TEST_BASE_URL;
const PG_URL = process.env.SVCIMG_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set SVCIMG_TEST_BASE_URL (+ SVCIMG_TEST_PG_URL) to run the HTTP tests');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error('refusing to run: base URL and database must both be local scratch instances');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-jwt-secret';

  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── seed ─────────────────────────────────────────────────────────────
  const P = `svi-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const IMG = 'https://cdn.example.test/services/a.jpg';
  const IMG2 = 'https://cdn.example.test/services/b.jpg';

  const mkUser = (u: string, photographer = false) =>
    q(`INSERT INTO users (id, username, email, is_photographer) VALUES ($1::varchar, $1::text, $2, $3)`, [id(u), `${id(u)}@x.test`, photographer]);
  await mkUser('owner');
  await mkUser('staff');
  await mkUser('photog', true);
  await q(`INSERT INTO businesses (id, owner_id, name, category) VALUES ($1::varchar, $2, $1::text, 'beauty')`, [id('biz'), id('owner')]);
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, status, stripe_onboarding_complete)
           VALUES ($1, $2, $3, 'Img Staff', 'active', true)`, [id('sm'), id('biz'), id('staff')]);
  await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate, stripe_account_id, stripe_onboarding_complete)
           VALUES ($1, $2, 'Img Photog', 100, 'acct_fake', true)`, [id('ph'), id('photog')]);

  const staffTok = generateAccessToken({ userId: id('staff'), isVendor: false, isAdmin: false });
  const photogTok = generateAccessToken({ userId: id('photog'), isVendor: false, isPhotographer: true, isAdmin: false, photographerId: id('ph') });

  let ipSeq = 0;
  async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.99.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    let body: string | undefined;
    if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(BASE + path, { method, headers, body });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text };
  }
  const imageOf = async (table: string, sid: string) => (await q(`SELECT image_url FROM ${table} WHERE id = $1`, [sid]))[0]?.image_url;

  const staffBody = (extra: Record<string, unknown> = {}) => ({ name: 'Img staff svc', priceCents: 5000, durationMinutes: 45, ...extra });
  const photogBody = (extra: Record<string, unknown> = {}) => ({ name: 'Img photog svc', priceCents: 15000, estimatedDurationMinutes: 60, ...extra });

  type Kind = { label: string; table: string; tok: string; create: string; item: (sid: string) => string; body: (e?: Record<string, unknown>) => Record<string, unknown>; golive: (sid: string) => string; archive: (sid: string) => string; };
  const kinds: Kind[] = [
    { label: 'staff', table: 'staff_services', tok: staffTok, create: '/api/staff/services', item: s => `/api/staff/services/${s}`, body: staffBody,
      golive: s => `/api/staff/services/${s}/go-live`, archive: s => `/api/staff/services/${s}/archive` },
    { label: 'photographer', table: 'photographer_services', tok: photogTok, create: '/api/photographers/me/services', item: s => `/api/photographers/me/services/${s}`, body: photogBody,
      golive: s => `/api/photographers/me/services/${s}/go-live`, archive: s => `/api/photographers/me/services/${s}/archive` },
  ];
  const svcOf = (r: { body: any }) => r.body?.service;

  try {
    for (const k of kinds) {
      console.log(`\n${k.label}: create`);
      let r = await call('POST', k.create, { token: k.tok, body: k.body({ imageUrl: IMG }) });
      const withImg = svcOf(r);
      assert((r.status === 200 || r.status === 201) && withImg?.imageUrl === IMG && (await imageOf(k.table, withImg?.id)) === IMG, 'imageUrl valid → saved and returned', { status: r.status, body: r.body });

      r = await call('POST', k.create, { token: k.tok, body: k.body({ imageUrl: null }) });
      const withNull = svcOf(r);
      assert((r.status === 200 || r.status === 201) && withNull?.imageUrl === null && (await imageOf(k.table, withNull?.id)) === null, 'imageUrl null → NULL', { status: r.status, body: r.body });

      r = await call('POST', k.create, { token: k.tok, body: k.body() });
      const absent = svcOf(r);
      assert((r.status === 200 || r.status === 201) && (absent?.imageUrl ?? null) === null && (await imageOf(k.table, absent?.id)) === null, 'imageUrl absent on create → NULL', { status: r.status, body: r.body });

      const before = Number((await q(`SELECT count(*)::int AS n FROM ${k.table}`))[0].n);
      r = await call('POST', k.create, { token: k.tok, body: k.body({ imageUrl: '' }) });
      assert(r.status === 400 && r.body?.error === 'Invalid data' && Number((await q(`SELECT count(*)::int AS n FROM ${k.table}`))[0].n) === before, 'imageUrl "" → 400 {error:"Invalid data"}, no row', { status: r.status, body: r.body });
      r = await call('POST', k.create, { token: k.tok, body: k.body({ imageUrl: 'not a url' }) });
      assert(r.status === 400 && r.body?.error === 'Invalid data', 'imageUrl not a URL → 400', { status: r.status, body: r.body });

      console.log(`\n${k.label}: update`);
      const sid = withImg.id as string;
      r = await call('PATCH', k.item(sid), { token: k.tok, body: { name: 'Renamed, no imageUrl' } });
      assert(r.status === 200 && svcOf(r)?.name === 'Renamed, no imageUrl' && (await imageOf(k.table, sid)) === IMG, 'PATCH without imageUrl keeps the stored image', { status: r.status, body: r.body });
      r = await call('PATCH', k.item(sid), { token: k.tok, body: { imageUrl: IMG2 } });
      assert(r.status === 200 && svcOf(r)?.imageUrl === IMG2 && (await imageOf(k.table, sid)) === IMG2, 'PATCH imageUrl valid → replaced', { status: r.status, body: r.body });
      r = await call('PATCH', k.item(sid), { token: k.tok, body: { imageUrl: '' } });
      assert(r.status === 400 && r.body?.error === 'Invalid data' && (await imageOf(k.table, sid)) === IMG2, 'PATCH imageUrl "" → 400, image unchanged', { status: r.status, body: r.body });
      r = await call('PATCH', k.item(sid), { token: k.tok, body: { imageUrl: null } });
      assert(r.status === 200 && svcOf(r)?.imageUrl === null && (await imageOf(k.table, sid)) === null, 'PATCH imageUrl null → NULL', { status: r.status, body: r.body });
      await call('PATCH', k.item(sid), { token: k.tok, body: { imageUrl: IMG } });

      console.log(`\n${k.label}: go-live and archive keep the image`);
      r = await call('POST', k.golive(sid), { token: k.tok });
      assert(r.status === 200 && svcOf(r)?.status === 'live' && (await imageOf(k.table, sid)) === IMG && svcOf(r)?.imageUrl === IMG, 'go-live → live, image kept', { status: r.status, body: r.body });

      // ── reads (service is live now) ──
      console.log(`\n${k.label}: reads include imageUrl`);
      if (k.label === 'staff') {
        r = await call('GET', `/api/businesses/${id('biz')}/staff/${id('sm')}/services`);
        const row = (r.body?.services ?? []).find((s: any) => s.id === sid);
        assert(r.status === 200 && row?.imageUrl === IMG, 'GET /api/businesses/:id/staff/:staffId/services (public mapping) → imageUrl', { status: r.status, body: r.body });
        const noImg = (r.body?.services ?? []).find((s: any) => s.id === absent.id);
        assert(noImg === undefined || noImg.imageUrl === null, 'draft service without an image is not listed as live / has imageUrl null');
        r = await call('GET', '/api/staff/my-services', { token: k.tok });
        assert(r.status === 200 && (r.body?.services ?? []).find((s: any) => s.id === sid)?.imageUrl === IMG, 'GET /api/staff/my-services → imageUrl', { status: r.status });
        r = await call('GET', `/api/staff/services/${sid}`, { token: k.tok });
        assert(r.status === 200 && r.body?.service?.imageUrl === IMG, 'GET /api/staff/services/:id → imageUrl', { status: r.status, body: r.body });
      } else {
        r = await call('GET', '/api/photographers/me/services', { token: k.tok });
        const mine = (r.body?.services ?? []);
        assert(r.status === 200 && mine.find((s: any) => s.id === sid)?.imageUrl === IMG && mine.find((s: any) => s.id === absent.id)?.imageUrl === null, 'GET /api/photographers/me/services → imageUrl (all statuses)', { status: r.status });
        r = await call('GET', `/api/photographers/${id('ph')}/services`);
        const pub = (r.body?.services ?? []);
        assert(r.status === 200 && pub.length === 1 && pub[0].id === sid && pub[0].imageUrl === IMG, 'GET /api/photographers/:id/services → live only, with imageUrl', { status: r.status, body: r.body });
      }

      r = await call('POST', k.archive(sid), { token: k.tok });
      assert(r.status === 200 && svcOf(r)?.status === 'archived' && (await imageOf(k.table, sid)) === IMG && svcOf(r)?.imageUrl === IMG, 'archive → archived, image kept', { status: r.status, body: r.body });
    }
  } finally {
    await q(`DELETE FROM staff_services WHERE business_id = $1`, [id('biz')]);
    await q(`DELETE FROM photographer_services WHERE photographer_id = $1`, [id('ph')]);
    await q(`DELETE FROM staff_members WHERE id = $1`, [id('sm')]);
    await q(`DELETE FROM businesses WHERE id = $1`, [id('biz')]);
    await q(`DELETE FROM photographers WHERE id = $1`, [id('ph')]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}-%`]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
