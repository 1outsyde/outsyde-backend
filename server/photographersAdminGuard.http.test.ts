/**
 * Photographer admin-guard HTTP tests (R1) — run with: npx tsx server/photographersAdminGuard.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema),
 * and the same JWT_SECRET in this process:
 *   PHOTOG_GUARD_TEST_BASE_URL   e.g. http://localhost:5061            (must be localhost)
 *   PHOTOG_GUARD_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   JWT_SECRET                   identical to the server's
 * It skips (exit 0) when PHOTOG_GUARD_TEST_BASE_URL is unset and refuses any non-local host, so it
 * can never touch Neon or production.
 *
 * Guarded routes (admin only): POST /api/photographers, PATCH + DELETE /api/photographers/:id.
 * Unchanged routes (GET /, GET /:id, GET /:id/services, GET+PATCH /me, GET /me/services) are asserted
 * against the statuses main returns today. The one intended change: DELETE /me (was 404, now 401).
 * Set PHOTOG_GUARD_TEST_PRINT=1 to print every unchanged-route status instead of asserting it.
 * Set PHOTOG_GUARD_TEST_ONLY_UNCHANGED=1 to skip the guarded-route cases — use it to run against main,
 * where those routes are unguarded and the "denied" calls would really write to the scratch DB.
 */

const BASE = process.env.PHOTOG_GUARD_TEST_BASE_URL;
const PG_URL = process.env.PHOTOG_GUARD_TEST_PG_URL;
const PRINT = process.env.PHOTOG_GUARD_TEST_PRINT === '1';
const ONLY_UNCHANGED = process.env.PHOTOG_GUARD_TEST_ONLY_UNCHANGED === '1';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set PHOTOG_GUARD_TEST_BASE_URL (+ PHOTOG_GUARD_TEST_PG_URL) to run the HTTP tests');
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
  const P = `pag-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const ADMIN_EMAIL = 'info@goutsyde.com'; // in the allowed list (routes.ts:16028)
  const seededUsers: string[] = [];
  const mkUser = async (u: string, o: { admin?: boolean; email?: string; photographer?: boolean } = {}) => {
    await q(`INSERT INTO users (id, username, email, is_admin, is_photographer) VALUES ($1::varchar, $1::text, $2, $3, $4)`,
      [id(u), o.email ?? `${id(u)}@x.test`, !!o.admin, !!o.photographer]);
    seededUsers.push(id(u));
    return id(u);
  };
  const mkPhotog = async (p: string, owner: string, name = p) => {
    await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate) VALUES ($1, $2, $3, 100)`, [id(p), owner, name]);
    return id(p);
  };

  // The allowed admin email is unique in users — reuse an existing row if the scratch schema has one.
  const existing = await q(`SELECT id FROM users WHERE lower(email) = $1`, [ADMIN_EMAIL]);
  let adminId: string;
  if (existing.length) {
    adminId = existing[0].id;
    await q(`UPDATE users SET is_admin = true WHERE id = $1`, [adminId]);
  } else {
    adminId = await mkUser('admin', { admin: true, email: ADMIN_EMAIL });
  }
  const regularId = await mkUser('regular');
  const notAllowedAdminId = await mkUser('notallowed', { admin: true, email: `${id('notallowed')}@x.test` });
  const ownerId = await mkUser('owner', { photographer: true });
  const photogId = await mkPhotog('known', ownerId, 'Guard Known');

  const jwt = (userId: string, o: { admin?: boolean; photographerId?: string } = {}) =>
    generateAccessToken({ userId, isVendor: false, isPhotographer: !!o.photographerId, isAdmin: o.admin ?? false, photographerId: o.photographerId });
  const T = {
    admin: jwt(adminId, { admin: true }),
    nonAdmin: jwt(regularId),                       // isAdmin falsy in the token
    adminJwtFalse: jwt(adminId, { admin: false }),  // real admin user, token says isAdmin:false
    notAllowedEmail: jwt(notAllowedAdminId, { admin: true }), // token + DB flag admin, email not allowed
    photographer: jwt(ownerId, { photographerId: photogId }),
  };

  let ipSeq = 0;
  async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.88.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    let body: string | undefined;
    if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(BASE + path, { method, headers, body });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text };
  }
  const ROOT = '/api/photographers';
  const countPhotog = async () => Number((await q(`SELECT count(*)::int AS n FROM photographers`))[0].n);
  const nameOf = async (pid: string) => (await q(`SELECT display_name FROM photographers WHERE id = $1`, [pid]))[0]?.display_name;
  const createdIds: string[] = [];
  let r: { status: number; body: any; text: string };

  try {
    if (!ONLY_UNCHANGED) {
    // ── guarded routes: denied cases ────────────────────────────────────────
    const denied: Array<[string, string, string | undefined, number, string]> = [
      ['no token', '', undefined, 401, 'Not authenticated'],
      ['invalid Bearer token', '', 'not.a.jwt', 401, 'Not authenticated'],
      ['non-admin JWT', '', T.nonAdmin, 403, 'Admin access required'],
      ['JWT isAdmin:false for the admin user', '', T.adminJwtFalse, 403, 'Admin access required'],
      ['JWT isAdmin:true but email not allowed', '', T.notAllowedEmail, 403, 'Admin access required'],
      ['photographer owner JWT', '', T.photographer, 403, 'Admin access required'],
    ];
    const guarded: Array<[string, string, unknown]> = [
      ['POST', ROOT, { userId: regularId, displayName: 'Denied', hourlyRate: 50, stripeAccountId: 'acct_denied' }],
      ['PATCH', `${ROOT}/${photogId}`, { displayName: 'HACKED', stripeAccountId: 'acct_hacked' }],
      ['DELETE', `${ROOT}/${photogId}`, undefined],
    ];
    for (const [method, path, body] of guarded) {
      console.log(`\n${method} ${path.replace(photogId, ':id')} — denied`);
      for (const [label, , token, status, msg] of denied) {
        const before = await countPhotog();
        const r = await call(method, path, { token, body });
        assert(r.status === status && r.body?.error === msg, `${label} → ${status} {error:"${msg}"}`, { status: r.status, body: r.body });
        assert((await countPhotog()) === before && (await nameOf(photogId)) === 'Guard Known', `${label}: no write happened`);
      }
    }

    // ── guarded routes: admin keeps today's behaviour ─────────────────────────
    console.log('\nPOST /api/photographers — admin');
    r = await call('POST', ROOT, { token: T.admin, body: { displayName: 'No User' } });
    assert(r.status === 400 && r.body?.success === false, 'missing fields → 400', { status: r.status, body: r.body });
    const newUser = await mkUser('newphotog');
    r = await call('POST', ROOT, { token: T.admin, body: { userId: newUser, displayName: 'Guard Created', hourlyRate: 75, stripeAccountId: 'acct_guard_test' } });
    assert(r.status === 201 && r.body?.success === true && r.body?.photographer?.displayName === 'Guard Created', 'valid body → 201 {success, photographer}', { status: r.status, body: r.body });
    if (r.body?.photographer?.id) createdIds.push(r.body.photographer.id);

    console.log('\nPATCH /api/photographers/:id — admin');
    r = await call('PATCH', `${ROOT}/${id('does-not-exist')}`, { token: T.admin, body: { displayName: 'x' } });
    assert(r.status === 404 && r.body?.success === false, 'unknown id → 404', { status: r.status, body: r.body });
    r = await call('PATCH', `${ROOT}/${photogId}`, { token: T.admin, body: { displayName: 'Guard Renamed' } });
    assert(r.status === 200 && r.body?.photographer?.displayName === 'Guard Renamed' && (await nameOf(photogId)) === 'Guard Renamed', 'known id → 200 and row updated', { status: r.status, body: r.body });

    console.log('\nDELETE /api/photographers/:id — admin');
    r = await call('DELETE', `${ROOT}/${id('does-not-exist')}`, { token: T.admin });
    assert(r.status === 404 && r.body?.success === false, 'unknown id → 404', { status: r.status, body: r.body });
    const delOwner = await mkUser('delowner');
    const delId = await mkPhotog('todelete', delOwner);
    r = await call('DELETE', `${ROOT}/${delId}`, { token: T.admin });
    assert(r.status === 200 && r.body?.success === true && (await nameOf(delId)) === undefined, 'known id → 200 and row deleted', { status: r.status, body: r.body });

    }

    // ── unchanged routes: same statuses as main, with and without a token ───────
    console.log('\nUnchanged routes (statuses must equal main)');
    const unchanged: Array<[string, string, string, string | undefined, number]> = [
      // [label, method, path, token key, expected status on main]
      ['GET /', 'GET', ROOT, undefined, 200],
      ['GET / (admin token)', 'GET', ROOT, 'admin', 200],
      ['GET /:id', 'GET', `${ROOT}/${photogId}`, undefined, 200],
      ['GET /:id (admin token)', 'GET', `${ROOT}/${photogId}`, 'admin', 200],
      ['GET /:id/services', 'GET', `${ROOT}/${photogId}/services`, undefined, 200],
      ['GET /:id/services (admin token)', 'GET', `${ROOT}/${photogId}/services`, 'admin', 200],
      ['GET /me', 'GET', `${ROOT}/me`, undefined, 401],
      ['GET /me (photographer token)', 'GET', `${ROOT}/me`, 'photographer', 200],
      ['PATCH /me', 'PATCH', `${ROOT}/me`, undefined, 401],
      ['PATCH /me (photographer token, empty body)', 'PATCH', `${ROOT}/me`, 'photographer', 400],
      ['GET /me/services', 'GET', `${ROOT}/me/services`, undefined, 401],
      ['GET /me/services (photographer token)', 'GET', `${ROOT}/me/services`, 'photographer', 200],
    ];
    for (const [label, method, path, tk, expected] of unchanged) {
      const rr = await call(method, path, { token: tk ? (T as any)[tk] : undefined, body: method === 'PATCH' ? {} : undefined });
      if (PRINT) console.log(`  ${label}: ${rr.status}`);
      else assert(rr.status === expected, `${label} → ${expected}`, { status: rr.status, body: rr.body });
    }

    console.log('\nIntended change: DELETE /me (was 404 on main)');
    r = await call('DELETE', `${ROOT}/me`);
    if (PRINT) console.log(`  DELETE /me: ${r.status}`);
    else assert(r.status === 401, 'DELETE /me no token → 401', { status: r.status, body: r.body });
  } finally {
    await q(`DELETE FROM photographers WHERE id LIKE $1 OR id = ANY($2::varchar[])`, [`${P}-%`, createdIds]);
    await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [seededUsers]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
