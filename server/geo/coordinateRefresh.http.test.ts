/**
 * Business + photographer map point follows their city (2026-10-23) — run with:
 *   npx tsx server/geo/coordinateRefresh.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres, with the
 * geocode stub (GEOCODE_STUB=1, NODE_OPTIONS ... --import ./.dev/geocode-stub-preload.mjs) and
 * GEOCODE_STUB_LOG pointing at a file this test can read:
 *   CR_TEST_BASE_URL   e.g. http://localhost:5094   (must be localhost)
 *   CR_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   CR_TEST_STUB_LOG   the same path as the server's GEOCODE_STUB_LOG
 * Skips (exit 0) when CR_TEST_BASE_URL is unset; refuses any non-local host.
 */
import fs from "fs";

const BASE = process.env.CR_TEST_BASE_URL;
const PG_URL = process.env.CR_TEST_PG_URL;
const STUB_LOG = process.env.CR_TEST_STUB_LOG;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set CR_TEST_BASE_URL (+ CR_TEST_PG_URL, CR_TEST_STUB_LOG) to run the HTTP tests');
    process.exit(0);
  }
  if (!PG_URL || !STUB_LOG || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error('refusing to run: base URL and database must both be local scratch instances, and CR_TEST_STUB_LOG must be set');
  }
  const lookups = () => (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean) : []);

  const bcryptMod: any = await import('bcrypt');
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `cr-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const PASSWORD = 'local-test-pass-123';
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const [who, vendor, photog] of [['owner', true, false], ['photog', false, true]] as const) {
    await q(`INSERT INTO users (id, username, email, password, name, is_vendor, is_photographer) VALUES ($1::varchar, $2, $3, $4, $5, $6, $7)`,
      [id(who), `${who}${Date.now().toString(36)}`, `${id(who)}@x.test`, hash, `CR ${who}`, vendor, photog]);
  }
  await q(`INSERT INTO businesses (id, owner_id, name, category, city, state, latitude, longitude, approval_status)
           VALUES ($1, $2, 'CR Biz', 'Beauty', 'Baldwin', 'NY', 40.6565, -73.6093, 'approved')`, [id('biz'), id('owner')]);
  await q(`INSERT INTO photographers (id, user_id, display_name, city, state, latitude, longitude, visibility_status, hourly_rate)
           VALUES ($1, $2, 'CR Photog', 'Baldwin', 'NY', 40.6565, -73.6093, 'public', 100)`, [id('ph'), id('photog')]);

  let ipSeq = 0;
  async function call(method: string, path: string, o: { bearer?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.95.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
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
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.94.0.${++ipSeq % 250 + 1}` },
      body: JSON.stringify({ email: `${id(who)}@x.test`, password: PASSWORD }),
    });
    const body: any = await r.json();
    if (r.status !== 200 || !body?.accessToken) throw new Error(`login failed for ${who}: ${r.status}`);
    return body.accessToken as string;
  }
  const point = async (table: 'businesses' | 'photographers', rowId: string) =>
    (await q(`SELECT city, state, latitude, longitude FROM ${table} WHERE id = $1`, [rowId]))[0];

  try {
    const owner = await login('owner');
    const photog = await login('photog');

    for (const [label, table, rowId, path, bearer] of [
      ['business', 'businesses', id('biz'), '/api/vendor/my-business', owner],
      ['photographer', 'photographers', id('ph'), '/api/photographers/me', photog],
    ] as const) {
      console.log(`${label}: ${path}`);
      let n = lookups().length;
      const other = label === 'business' ? { description: 'only text' } : { bio: 'only text' };
      const r0 = await call('PATCH', path, { bearer, body: other });
      let row = await point(table, rowId);
      assert(r0.status === 200 && row.latitude === 40.6565 && lookups().length === n, 'unrelated save: point unchanged, no lookup', { s: r0.status, row });

      n = lookups().length;
      const r1 = await call('PATCH', path, { bearer, body: { city: ' baldwin ', state: 'New York' } });
      row = await point(table, rowId);
      assert(r1.status === 200 && row.latitude === 40.6565 && lookups().length === n, 'same city resent: no lookup', { s: r1.status, row });

      const before2 = lookups().length;
      const r2 = await call('PATCH', path, { bearer, body: { city: 'Freeport' } });
      row = await point(table, rowId);
      assert(r2.status === 200 && row.latitude === 40.6576 && row.longitude === -73.5832, 'city changed: new point', { s: r2.status, row });
      const new2 = lookups().slice(before2);
      // First time: one city-level lookup with the normalized state. Second row: served from the cache.
      assert(JSON.stringify(new2) === JSON.stringify(['Freeport, NY, United States']) || new2.length === 0,
        'city-level lookup with normalized state (or cached)', new2);

      const r3 = await call('PATCH', path, { bearer, body: { city: 'Nowhereville' } });
      row = await point(table, rowId);
      assert(r3.status === 200 && row.latitude === null && row.longitude === null, 'unknown city: point cleared (not the old one)', { s: r3.status, row });

      const r4 = await call('PATCH', path, { bearer, body: { city: 'Queens', state: 'Ny' } });
      row = await point(table, rowId);
      assert(r4.status === 200 && row.latitude === 40.7282, 'new city + "Ny" state: point found', { s: r4.status, row });
    }

  } finally {
    await q(`DELETE FROM photographers WHERE id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM refresh_tokens WHERE user_id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}-%`]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
