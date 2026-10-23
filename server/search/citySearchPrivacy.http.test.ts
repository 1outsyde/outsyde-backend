/**
 * City search by area + customer location privacy (2026-10-23, migration 070) — run with:
 *   npx tsx server/search/citySearchPrivacy.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres, and the same DB:
 *   CSP_TEST_BASE_URL   e.g. http://localhost:5094   (must be localhost)
 *   CSP_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 * Skips (exit 0) when CSP_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Rules under test:
 *  - GET /api/search?city=X finds rows in X and its surrounding area (coordinates within the radius),
 *    plus rows whose city text contains X (old rule, for rows without coordinates). Old apps send only city.
 *  - Customers are found by city only when users.location_public = true; their city/state never shows in
 *    results unless they share it. Admins see everything.
 *  - GET /api/users/:id shows city/state only when shared, to the person themselves, or to an admin.
 *  - GET/POST /api/user/location: signed-in person only (no ?userId= / body userId).
 *  - PATCH /api/users/me accepts locationPublic, city, state; clearing the city clears the coordinates.
 */

const BASE = process.env.CSP_TEST_BASE_URL;
const PG_URL = process.env.CSP_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set CSP_TEST_BASE_URL (+ CSP_TEST_PG_URL) to run the HTTP tests');
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

  const P = `csp-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const TERM = `zc${Date.now().toString(36)}`; // unique word so search only matches our rows
  const PASSWORD = 'local-test-pass-123';
  const hash = await bcrypt.hash(PASSWORD, 4);

  // who, city, state, lat, lng, public, admin
  const people: Array<[string, string | null, string | null, number | null, number | null, boolean, boolean]> = [
    ['pubhialeah', 'Hialeah', 'FL', 25.8576, -80.2781, true, false],   // near Miami, shares → found
    ['hiddenhialeah', 'Hialeah', 'FL', 25.8576, -80.2781, false, false], // near Miami, hidden → never
    ['pubbeach', 'Miami Beach', 'FL', null, null, true, false],          // no coords, text match → found
    ['puborlando', 'Orlando', 'FL', 28.5384, -81.3789, true, false],     // far → not found
    ['pubfreeport', 'Freeport', 'NY', 40.6576, -73.5832, true, false],   // New York area
    ['admin', 'Queens', 'NY', null, null, false, true],
  ];
  for (const [who, city, state, lat, lng, pub, adm] of people) {
    await q(`INSERT INTO users (id, username, email, password, name, is_admin, city, state, latitude, longitude, location_public)
             VALUES ($1::varchar, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id(who), `${who}${Date.now().toString(36)}`, `${id(who)}@x.test`, hash, `${TERM} ${who}`, adm, city, state, lat, lng, pub]);
  }
  // Photographers (same area helper on another table)
  await q(`INSERT INTO users (id, username, email, password, name, is_photographer) VALUES ($1::varchar, $2, $3, $4, $5, true)`,
    [id('photouser'), `photouser${Date.now().toString(36)}`, `${id('photouser')}@x.test`, hash, 'Photo user']);
  const photoIds: string[] = [];
  for (const [tag, city, lat, lng] of [['doral', 'Doral', 25.8195, -80.3553], ['orl', 'Orlando', 28.5384, -81.3789]] as const) {
    const pid = id(`photog-${tag}`);
    photoIds.push(pid);
    await q(`INSERT INTO photographers (id, user_id, display_name, city, state, latitude, longitude, visibility_status, hourly_rate)
             VALUES ($1, $2, $3, $4, 'FL', $5, $6, 'public', 100)`, [pid, id('photouser'), `${TERM} photog ${tag}`, city, lat, lng]);
  }

  let ipSeq = 0;
  async function call(method: string, path: string, o: { bearer?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.93.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
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
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.92.0.${++ipSeq % 250 + 1}` },
      body: JSON.stringify({ email: `${id(who)}@x.test`, password: PASSWORD }),
    });
    const body: any = await r.json();
    if (r.status !== 200 || !body?.accessToken) throw new Error(`login failed for ${who}: ${r.status}`);
    return body.accessToken as string;
  }
  const names = (r: any) => ((r.body?.results ?? []) as any[]).map((x) => String(x.title));
  const has = (r: any, who: string) => names(r).some((n) => n.endsWith(` ${who}`));
  const row = (r: any, who: string) => ((r.body?.results ?? []) as any[]).find((x) => String(x.title).endsWith(` ${who}`));

  try {
    const hidden = await login('hiddenhialeah');
    const admin = await login('admin');

    console.log('Customers: city search by area');
    const miami = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=Miami&state=FL`);
    assert(miami.status === 200, 'search 200', miami.status);
    assert(has(miami, 'pubhialeah'), 'Hialeah (shares, within radius) found for Miami', names(miami));
    assert(has(miami, 'pubbeach'), 'Miami Beach (shares, no coords) found by city text', names(miami));
    assert(!has(miami, 'hiddenhialeah'), 'hidden customer never found by city', names(miami));
    assert(!has(miami, 'puborlando'), 'Orlando (far) not found', names(miami));
    assert(row(miami, 'pubhialeah')?.subtitle === 'Hialeah, FL', 'shared customer shows city', row(miami, 'pubhialeah'));

    const oldApp = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=Miami`);
    assert(has(oldApp, 'pubhialeah') && !has(oldApp, 'hiddenhialeah'), 'old app (city only) gets the same area', names(oldApp));

    const ny = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=New%20York&state=NY`);
    assert(has(ny, 'pubfreeport'), 'Freeport found for New York', names(ny));
    assert(!has(ny, 'pubhialeah'), 'Miami people not in New York', names(ny));

    const coords = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=Freeport&state=NY&lat=40.6576&lng=-73.5832&radiusMiles=5`);
    assert(has(coords, 'pubfreeport') && !has(coords, 'pubhialeah'), 'client coords + small radius', names(coords));

    console.log('Customers: name search without a city');
    const byName = await call('GET', `/api/search?q=${TERM}&scope=consumers`);
    assert(has(byName, 'hiddenhialeah'), 'hidden customer still findable by name', names(byName));
    assert(row(byName, 'hiddenhialeah')?.subtitle === null, 'hidden customer: no city in results', row(byName, 'hiddenhialeah'));
    assert(row(byName, 'pubhialeah')?.subtitle === 'Hialeah, FL', 'shared customer: city shown', row(byName, 'pubhialeah'));

    console.log('Admin sees everything');
    const adminMiami = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=Miami&state=FL`, { bearer: admin });
    assert(has(adminMiami, 'hiddenhialeah'), 'admin finds hidden customer by city', names(adminMiami));
    assert(row(adminMiami, 'hiddenhialeah')?.subtitle === 'Hialeah, FL', 'admin sees hidden city', row(adminMiami, 'hiddenhialeah'));
    const spoof = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=Miami&state=FL&viewerUserId=${id('admin')}`);
    assert(!has(spoof, 'hiddenhialeah'), 'viewerUserId=admin in the URL does not unlock hidden people', names(spoof));

    console.log('Photographers: same area rule');
    const ph = await call('GET', `/api/search?q=${TERM}&scope=photographers&city=Miami&state=FL`);
    assert(names(ph).some((n) => n.endsWith('doral')), 'Doral photographer found for Miami', names(ph));
    assert(!names(ph).some((n) => n.endsWith('orl')), 'Orlando photographer not found for Miami', names(ph));
    const phNoCity = await call('GET', `/api/search?q=${TERM}&scope=photographers`);
    assert(names(phNoCity).length === 2, 'no city filter: both photographers', names(phNoCity));

    console.log('GET /api/users/:id');
    const anonHidden = await call('GET', `/api/users/${id('hiddenhialeah')}`);
    assert(anonHidden.status === 200 && anonHidden.body.user.city === null && anonHidden.body.user.state === null, 'hidden: no city to strangers', anonHidden.body?.user);
    assert(!('locationPublic' in anonHidden.body.user), 'sharing choice not shown to strangers');
    const selfHidden = await call('GET', `/api/users/${id('hiddenhialeah')}`, { bearer: hidden });
    assert(selfHidden.body.user.city === 'Hialeah' && selfHidden.body.user.locationPublic === false, 'hidden: the person sees their own city + choice', selfHidden.body?.user);
    const adminHidden = await call('GET', `/api/users/${id('hiddenhialeah')}`, { bearer: admin });
    assert(adminHidden.body.user.city === 'Hialeah', 'admin sees hidden city', adminHidden.body?.user);
    const otherHidden = await call('GET', `/api/users/${id('hiddenhialeah')}`, { bearer: await login('pubhialeah') });
    assert(otherHidden.body.user.city === null, 'another signed-in customer does not see it', otherHidden.body?.user);
    const anonPublic = await call('GET', `/api/users/${id('pubhialeah')}`);
    assert(anonPublic.body.user.city === 'Hialeah' && anonPublic.body.user.state === 'FL', 'shared: city shown', anonPublic.body?.user);
    assert(!('latitude' in anonPublic.body.user), 'coordinates never on the public profile');

    console.log('/api/user/location is signed-in only');
    const getSpoof = await call('GET', `/api/user/location?userId=${id('hiddenhialeah')}`);
    assert(getSpoof.status === 401, 'GET ?userId= without sign-in → 401', getSpoof);
    const postSpoof = await call('POST', '/api/user/location', { body: { userId: id('hiddenhialeah'), latitude: 1, longitude: 1, city: 'Hacked' } });
    assert(postSpoof.status === 401, 'POST body userId without sign-in → 401', postSpoof);
    const [afterSpoof] = await q(`SELECT city, latitude FROM users WHERE id = $1`, [id('hiddenhialeah')]);
    assert(afterSpoof.city === 'Hialeah' && afterSpoof.latitude === 25.8576, 'spoof changed nothing', afterSpoof);
    const getOwn = await call('GET', '/api/user/location', { bearer: hidden });
    assert(getOwn.status === 200 && getOwn.body.location.city === 'Hialeah', 'own location still readable', getOwn.body);

    console.log('PATCH /api/users/me');
    const bad = await call('PATCH', '/api/users/me', { bearer: hidden, body: { locationPublic: 'yes' } });
    assert(bad.status === 400, 'non-boolean locationPublic → 400', bad.status);
    const on = await call('PATCH', '/api/users/me', { bearer: hidden, body: { locationPublic: true } });
    assert(on.status === 200 && on.body.user.locationPublic === true, 'turn sharing on', on.body?.user?.locationPublic);
    const [kept] = await q(`SELECT latitude FROM users WHERE id = $1`, [id('hiddenhialeah')]);
    assert(kept.latitude === 25.8576, 'existing coordinates kept when turning sharing on', kept);
    const nowFound = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=Miami&state=FL`);
    assert(has(nowFound, 'hiddenhialeah'), 'found by city once shared', names(nowFound));
    const off = await call('PATCH', '/api/users/me', { bearer: hidden, body: { locationPublic: false } });
    assert(off.status === 200 && off.body.user.locationPublic === false, 'turn sharing off', off.body?.user?.locationPublic);
    const goneAgain = await call('GET', `/api/search?q=${TERM}&scope=consumers&city=Miami&state=FL`);
    assert(!has(goneAgain, 'hiddenhialeah'), 'hidden again right away', names(goneAgain));
    const clear = await call('PATCH', '/api/users/me', { bearer: hidden, body: { city: '' } });
    const [cleared] = await q(`SELECT city, latitude, longitude, state FROM users WHERE id = $1`, [id('hiddenhialeah')]);
    assert(clear.status === 200 && cleared.city === null && cleared.latitude === null && cleared.longitude === null, 'clearing the city clears coordinates', cleared);
    assert(cleared.state === 'FL', 'state untouched when not sent', cleared);
    const bio = await call('PATCH', '/api/users/me', { bearer: hidden, body: { bio: 'hi' } });
    const [bioRow] = await q(`SELECT location_public, state FROM users WHERE id = $1`, [id('hiddenhialeah')]);
    assert(bio.status === 200 && bioRow.location_public === false && bioRow.state === 'FL', 'unrelated save changes no location field', bioRow);
    const longCity = await call('PATCH', '/api/users/me', { bearer: hidden, body: { city: 'x'.repeat(101) } });
    assert(longCity.status === 400, 'city over 100 chars → 400', longCity.status);
  } finally {
    await q(`DELETE FROM photographers WHERE id = ANY($1)`, [photoIds]);
    await q(`DELETE FROM refresh_tokens WHERE user_id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}-%`]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
