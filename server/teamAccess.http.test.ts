/**
 * Business team access (migration 112, Royal Elite) — HTTP integration tests.
 *
 * Run with: npx tsx server/teamAccess.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema + migration 112),
 * like server/estimateRequests.http.test.ts:
 *   TA_TEST_BASE_URL   e.g. http://localhost:5063   (must be localhost)
 *   TA_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when TA_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * What it proves:
 *  - owner adds (by Outsyde email, any case), lists and removes team members; clear errors for unknown email,
 *    the owner's own email, duplicates
 *  - a team member (role "requests"), only with x-business-id of that business: reads + updates estimate
 *    requests, reads who gets requests; every other route stays closed (saving recipients, request forms,
 *    quotes, my-business, the team itself)
 *  - another business, no x-business-id, a stranger, a removed member: no access
 *  - /api/auth/me lists the team; an Outsyde admin manages the team with x-business-id
 */

import http from 'http';

const BASE = process.env.TA_TEST_BASE_URL;
const PG_URL = process.env.TA_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);
const closed = (s: number) => s === 401 || s === 403 || s === 404;

async function call(method: string, path: string, o: { token?: string; body?: unknown; biz?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.99.6.${Math.floor(Math.random() * 200) + 1}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    if (o.biz) headers['x-business-id'] = o.biz;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set TA_TEST_BASE_URL (+ TA_TEST_PG_URL) to run');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: BASE and PG_URL must both be localhost');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ta-test-jwt-secret';
  const { generateAccessToken } = await import('./auth');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `ta${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, isVendor = false, first = 'Test') => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor, first_name, last_name) VALUES ($1::varchar, $1::text, $2, $3, $4, 'Person')`, [uid, `${uid}@ta.test`, isVendor, first]);
    users.push(uid);
    return uid;
  };
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(key);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, service_cities) VALUES ($1, $2, $3, 'moving', 'approved', $4)`, [bid, ownerId, `Biz ${key}`, ['Norfolk']]);
    bizs.push(bid);
    return bid;
  };
  const owner = await mkUser('own', true);
  const biz = await mkBiz('b', owner);
  const otherOwner = await mkUser('oown', true);
  const otherBiz = await mkBiz('ob', otherOwner);
  const helper = await mkUser('jer', false, 'Jeremiah');
  const stranger = await mkUser('str');
  const customer = await mkUser('cust');
  const [existingAdmin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
  const admin = existingAdmin?.id ?? await mkUser('adm');
  if (!existingAdmin) await q(`UPDATE users SET email = 'info@goutsyde.com' WHERE id = $1`, [admin]);
  const tok = (u: string, v = false) => generateAccessToken({ userId: u, isVendor: v, isAdmin: false });
  const tOwn = tok(owner, true), tOther = tok(otherOwner, true), tHelp = tok(helper), tStr = tok(stranger), tAdm = tok(admin);
  const [er] = await q(`INSERT INTO estimate_requests (business_id, customer_id, customer_name, customer_email, customer_phone, city, status, details, source)
    VALUES ($1, $2, 'Cust', 'c@ta.test', '757 555 0100', 'Norfolk', 'new', '{}'::jsonb, 'test') RETURNING id`, [biz, customer]);
  const [er2] = await q(`INSERT INTO estimate_requests (business_id, customer_id, customer_name, customer_email, customer_phone, city, status, details, source)
    VALUES ($1, $2, 'Other', 'o@ta.test', '757 555 0101', 'Norfolk', 'new', '{}'::jsonb, 'test') RETURNING id`, [otherBiz, customer]);

  try {
    console.log('\n── 1. before being added, no access ──');
    let r = await call('GET', '/api/vendor/estimate-requests', { token: tHelp, biz });
    assert(closed(r.status), 'not on the team → estimate requests closed', r.status);

    console.log('\n── 2. owner manages the team ──');
    r = await call('POST', '/api/vendor/team', { token: tOwn, body: { email: `  ${helper.toUpperCase()}@TA.TEST ` } });
    assert(r.status === 201 && r.body?.member?.userId === helper && r.body?.member?.role === 'requests' && r.body?.member?.name === 'Jeremiah Person', 'add by email, any case → 201 as role requests', r.body);
    r = await call('POST', '/api/vendor/team', { token: tOwn, body: { email: `${helper}@ta.test` } });
    assert(r.status === 409 && r.body?.error === "They're already on your team.", 'adding twice → 409', r.body);
    r = await call('POST', '/api/vendor/team', { token: tOwn, body: { email: `nobody.${P}@ta.test` } });
    assert(r.status === 404 && /No Outsyde account uses that email/.test(r.body?.error ?? ''), 'unknown email → 404 with a clear message', r.body);
    r = await call('POST', '/api/vendor/team', { token: tOwn, body: { email: `${owner}@ta.test` } });
    assert(r.status === 400 && /owner/.test(r.body?.error ?? ''), "owner's own email → 400", r.body);
    r = await call('POST', '/api/vendor/team', { token: tOwn, body: {} });
    assert(r.status === 400, 'no email → 400', r.status);
    r = await call('GET', '/api/vendor/team', { token: tOwn });
    assert(r.status === 200 && r.body?.members?.length === 1 && r.body.members[0].email === `${helper}@ta.test`, 'owner lists the team', r.body);
    const [row] = await q(`SELECT role, added_by FROM business_team_members WHERE business_id = $1 AND user_id = $2`, [biz, helper]);
    assert(row?.role === 'requests' && row?.added_by === owner, 'saved with role and who added them', row);

    console.log('\n── 3. team member, with this business named ──');
    r = await call('GET', '/api/vendor/estimate-requests', { token: tHelp, biz });
    assert(r.status === 200 && r.body?.requests?.length === 1 && r.body.requests[0].id === er.id, "sees this business's requests only", r.body);
    r = await call('PATCH', `/api/vendor/estimate-requests/${er.id}`, { token: tHelp, biz, body: { status: 'called', vendorNotes: 'Left a voicemail' } });
    assert(r.status === 200, 'updates status and notes', r);
    const [after] = await q(`SELECT status, vendor_notes FROM estimate_requests WHERE id = $1`, [er.id]);
    assert(after?.status === 'called' && after?.vendor_notes === 'Left a voicemail', 'saved', after);
    r = await call('PATCH', `/api/vendor/estimate-requests/${er2.id}`, { token: tHelp, biz, body: { status: 'closed' } });
    assert(r.status === 404, "another business's request → 404", r.status);
    r = await call('GET', '/api/vendor/request-recipients', { token: tHelp, biz });
    assert(r.status === 200 && Array.isArray(r.body?.emails), 'reads who gets requests', r.body);
    r = await call('PUT', '/api/vendor/request-recipients', { token: tHelp, biz, body: { emails: ['x@y.co'] } });
    assert(closed(r.status), 'cannot change who gets requests', r.status);
    r = await call('GET', '/api/vendor/request-forms', { token: tHelp, biz });
    assert(closed(r.status), 'request form routes stay owner only', r.status);
    r = await call('POST', '/api/vendor/request-forms', { token: tHelp, biz, body: { name: 'x', isBase: true, questions: [] } });
    assert(closed(r.status), 'cannot create a request form', r.status);
    r = await call('GET', '/api/vendor/quotes', { token: tHelp, biz });
    assert(closed(r.status), 'quotes stay owner only', r.status);
    r = await call('GET', '/api/vendor/my-business', { token: tHelp, biz });
    assert(closed(r.status), 'my-business stays owner only', r.status);
    r = await call('PATCH', '/api/vendor/my-business', { token: tHelp, biz, body: { name: 'Hacked' } });
    assert(closed(r.status) || r.status === 400, 'cannot edit the business', r.status);
    r = await call('GET', '/api/vendor/team', { token: tHelp, biz });
    assert(closed(r.status), 'cannot see the team page', r.status);
    r = await call('POST', '/api/vendor/team', { token: tHelp, biz, body: { email: `${stranger}@ta.test` } });
    assert(closed(r.status), 'cannot add people', r.status);
    const [name] = await q(`SELECT name FROM businesses WHERE id = $1`, [biz]);
    assert(name?.name === 'Biz b', 'business unchanged', name);

    console.log('\n── 4. wrong business, no business named, strangers ──');
    r = await call('GET', '/api/vendor/estimate-requests', { token: tHelp });
    assert(closed(r.status), 'no x-business-id → closed', r.status);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tHelp, biz: otherBiz });
    assert(closed(r.status), 'another business named → closed', r.status);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tStr, biz });
    assert(closed(r.status), 'stranger → closed', r.status);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tOther, biz });
    assert(r.status === 403, "another owner naming this business → 403 (unchanged)", r.status);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tOwn });
    assert(r.status === 200 && r.body?.requests?.length === 1, 'owner unchanged without x-business-id', r.status);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tOwn, biz });
    assert(r.status === 200, 'owner unchanged with x-business-id', r.status);

    console.log('\n── 5. /api/auth/me ──');
    r = await call('GET', '/api/auth/me', { token: tHelp });
    assert(r.status === 200 && JSON.stringify(r.body?.user?.team) === JSON.stringify([{ businessId: biz, role: 'requests' }]) && r.body?.user?.businessId === null, 'member: team listed, owns nothing', r.body?.user);
    r = await call('GET', '/api/auth/me', { token: tOwn });
    assert(r.status === 200 && JSON.stringify(r.body?.user?.team) === '[]' && r.body?.user?.businessId === biz, 'owner: empty team, business unchanged', r.body?.user);

    console.log('\n── 6. admin and removal ──');
    r = await call('GET', '/api/vendor/team', { token: tAdm, biz });
    assert(r.status === 200 && r.body?.members?.length === 1, 'admin lists the team with x-business-id', r.status);
    r = await call('GET', '/api/vendor/team', { token: tOther, biz });
    assert(r.status === 403, "another owner can't see this team", r.status);
    r = await call('DELETE', `/api/vendor/team/${helper}`, { token: tOther, biz });
    assert(r.status === 403, "another owner can't remove from this team", r.status);
    r = await call('DELETE', `/api/vendor/team/${helper}`, { token: tOwn });
    assert(r.status === 200 && r.body?.ok === true, 'owner removes them', r.body);
    r = await call('DELETE', `/api/vendor/team/${helper}`, { token: tOwn });
    assert(r.status === 404, 'removing again → 404', r.status);
    r = await call('GET', '/api/vendor/estimate-requests', { token: tHelp, biz });
    assert(closed(r.status), 'removed member loses access', r.status);
    r = await call('GET', '/api/auth/me', { token: tHelp });
    assert(JSON.stringify(r.body?.user?.team) === '[]', 'and auth/me no longer lists it', r.body?.user?.team);
  } finally {
    await q(`DELETE FROM business_team_members WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM estimate_requests WHERE business_id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch(() => {});
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
