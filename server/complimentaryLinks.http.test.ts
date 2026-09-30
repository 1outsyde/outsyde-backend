/**
 * Free-plan claim-link HTTP tests — run with: npx tsx server/complimentaryLinks.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema
 * + migration 038) with a fake Stripe, and the same secrets in this process:
 *   COMPLIMENTARY_TEST_BASE_URL   e.g. http://localhost:5057            (must be localhost)
 *   COMPLIMENTARY_TEST_PG_URL     the SAME scratch database (localhost only; seeds + cleans up)
 *   COMPLIMENTARY_TEST_SERVER_LOG the server's stdout/stderr file (asserted to hold no token/hash)
 *   JWT_SECRET, GRANT_LINK_SECRET  identical to the server's
 *   server fake Stripe: FAKE_SUBS='{"sub_clh_active":"active","sub_clh_dead":"canceled","sub_clh_throw":"__throw__"}'
 * It skips (exit 0) when COMPLIMENTARY_TEST_BASE_URL is unset and refuses any non-local host, so
 * it can never touch Neon or production. Each request gets its own X-Forwarded-For so the redeem
 * rate limiter (10 / 15 min / IP) only trips where a test means it to.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';

const BASE = process.env.COMPLIMENTARY_TEST_BASE_URL;
const PG_URL = process.env.COMPLIMENTARY_TEST_PG_URL;
const LOG_FILE = process.env.COMPLIMENTARY_TEST_SERVER_LOG;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);

(async () => {
  if (!BASE) {
    console.log('⏭  skipped: set COMPLIMENTARY_TEST_BASE_URL (+ COMPLIMENTARY_TEST_PG_URL) to run the HTTP tests');
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error('refusing to run: base URL and database must both be local scratch instances');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-jwt-secret';
  process.env.GRANT_LINK_SECRET = process.env.GRANT_LINK_SECRET || 'verify-grant-secret';

  const { generateAccessToken } = await import('./auth');
  const { grantToken } = await import('./utils/grantToken');
  const { hash } = await import('./utils/complimentaryLinkToken');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── seed ────────────────────────────────────────────────────────────────
  const P = `clh-${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const jwt = (userId: string, o: { admin?: boolean; vendor?: boolean } = {}) =>
    generateAccessToken({ userId, isVendor: o.vendor ?? true, isAdmin: o.admin ?? false });
  const mkUser = async (u: string, o: { admin?: boolean; email?: string } = {}) =>
    q(`INSERT INTO users (id, username, email, is_admin) VALUES ($1::varchar, $1::text, $2, $3)`, [id(u), o.email ?? `${id(u)}@x.test`, !!o.admin]);
  const mkBiz = async (b: string, owner: string, account?: string) =>
    q(`INSERT INTO businesses (id, owner_id, name, category, stripe_account_id) VALUES ($1::varchar, $2, $1::text, 'beauty', $3)`, [id(b), id(owner), account ?? null]);
  const mkSub = async (b: string, owner: string, o: { stripe?: string | null; status?: string; end?: string }) =>
    q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, stripe_subscription_id, status, current_period_end)
       VALUES ($1, $2, (SELECT id FROM subscription_tiers WHERE name = 'growth'), $3, $4, $5)`, [id(owner), id(b), o.stripe ?? null, o.status ?? 'active', o.end ?? '2099-01-01']);

  const ADMIN = 'u-admin'; // info@goutsyde.com, is_admin — seeded in the scratch schema
  const T: Record<string, string> = {
    admin: jwt(ADMIN, { admin: true, vendor: false }),
    adminJwtFalse: jwt(ADMIN, { admin: false, vendor: false }),
    notAllowedAdmin: jwt('u-notadmin', { admin: true, vendor: false }),
  };
  for (const u of ['owner1', 'owner2', 'owner3', 'owner4', 'owner5', 'owner6', 'owner7', 'nobiz']) {
    await mkUser(u);
    T[u] = jwt(id(u));
  }
  await mkBiz('b1', 'owner1', 'acct_ready');
  await mkBiz('b2', 'owner2');
  await mkBiz('b3', 'owner3');
  await mkBiz('b4', 'owner4');
  await mkBiz('b5', 'owner5');
  await mkBiz('b6', 'owner6');
  await mkBiz('b7', 'owner7');

  let ipSeq = 0;
  async function call(method: string, path: string, o: { token?: string; body?: unknown; raw?: string; ip?: string } = {}) {
    const headers: Record<string, string> = { 'X-Forwarded-For': o.ip ?? `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    let body: string | undefined;
    if (o.raw !== undefined) { headers['Content-Type'] = 'application/json'; body = o.raw; }
    else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(BASE + path, { method, headers, body });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text };
  }
  const CREATE = '/api/admin/subscription/complimentary-link';
  const LIST = '/api/admin/subscription/complimentary-links';
  const REDEEM = '/api/subscription/complimentary-link/redeem';
  const FUT = new Date(Date.now() + 30 * 86400e3).toISOString().replace('Z', '-05:00'); // valid ISO with an offset
  const secrets = new Set<string>(); // every token + hash this run creates
  const tokenOf = (url: string) => url.split('/subscribe/free/')[1];
  async function newLink(b: string, body: Record<string, unknown> = { permanent: true }) {
    const r = await call('POST', CREATE, { token: T.admin, body: { businessId: id(b), ...body } });
    if (r.status === 200) { const t = tokenOf(r.body.url); secrets.add(t); secrets.add(hash(t)); return { r, token: t, hash: hash(t) }; }
    return { r, token: '', hash: '' };
  }

  try {
    // ── admin guard ─────────────────────────────────────────────────────────
    console.log('\nAdmin routes require requireAdmin');
    const probes: Array<[string, string, unknown?]> = [
      ['POST', CREATE, { businessId: id('b1'), permanent: true }],
      ['GET', `${LIST}?businessId=${id('b1')}`],
      ['DELETE', `${CREATE}/whatever`],
    ];
    for (const [m, p, b] of probes) {
      const none = await call(m, p, { body: b });
      const notAdmin = await call(m, p, { token: T.owner1, body: b });
      const jwtFalse = await call(m, p, { token: T.adminJwtFalse, body: b });
      const badEmail = await call(m, p, { token: T.notAllowedAdmin, body: b });
      assert(none.status === 401, `${m} ${p.split('?')[0]} — no auth → 401`, none.status);
      assert(notAdmin.status === 403 && jwtFalse.status === 403 && badEmail.status === 403, `${m} ${p.split('?')[0]} — vendor / non-admin JWT / admin-flag-but-wrong-email → 403`, [notAdmin.status, jwtFalse.status, badEmail.status]);
    }
    assert((await q(`SELECT count(*)::int AS n FROM complimentary_grant_links WHERE business_id LIKE $1`, [`${P}%`]))[0].n === 0, 'no link was created by any rejected call');

    // ── create ──────────────────────────────────────────────────────────────
    console.log('\nPOST /api/admin/subscription/complimentary-link');
    let r = await call('POST', CREATE, { token: T.admin, body: { permanent: true } });
    assert(r.status === 400, 'missing businessId → 400', r.status);
    r = await call('POST', CREATE, { token: T.admin, body: { businessId: id('b1'), permanent: true, tierId: 'x' } });
    assert(r.status === 400, 'extra key (tierId) → 400', r.status);
    r = await call('POST', CREATE, { token: T.admin, body: { businessId: id('b1'), expiresAt: '2020-01-01T00:00:00-05:00' } });
    assert(r.status === 400 && r.body.error === 'expiresAt must be in the future', 'past expiresAt → 400 "expiresAt must be in the future"', r.body);
    r = await call('POST', CREATE, { token: T.admin, body: { businessId: id('nope'), permanent: true } });
    assert(r.status === 404 && r.body.error === 'Business not found', 'unknown business → 404', r.body);

    const perm = await newLink('b1');
    assert(perm.r.status === 200, 'permanent link → 200', perm.r.body);
    assert(JSON.stringify(Object.keys(perm.r.body)) === '["linkExpiresAt","url"]', 'response keys are [linkExpiresAt, url] in that order', Object.keys(perm.r.body));
    assert(new RegExp(`/subscribe/free/[A-Za-z0-9_-]{43}$`).test(perm.r.body.url) && perm.r.body.url.startsWith(`${process.env.FRONTEND_URL ?? ''}`), 'url = ${FRONTEND_URL}/subscribe/free/<43-char token>', perm.r.body.url);
    const row = (await q(`SELECT *, extract(epoch FROM (link_expires_at - (now() AT TIME ZONE 'UTC')))::float AS ttl FROM complimentary_grant_links WHERE token_hash = $1`, [perm.hash]))[0];
    assert(!!row && row.plan_expires_at === null && row.created_by === ADMIN && row.redeemed_at === null && row.revoked_at === null, 'stored: plan_expires_at NULL (permanent), created_by = the admin, unused');
    assert(row.ttl > 7 * 86400 - 120 && row.ttl <= 7 * 86400, 'link_expires_at is created + 7 days', row.ttl);
    const rowText = JSON.stringify(row);
    assert(!rowText.includes(perm.token) && row.token_hash === createHash('sha256').update(perm.token).digest('hex'), 'the DB row holds only the sha256 — the raw token is nowhere in it');
    const dated = await newLink('b2', { expiresAt: FUT });
    const drow = (await q(`SELECT plan_expires_at FROM complimentary_grant_links WHERE token_hash = $1`, [dated.hash]))[0];
    const wantPlan = new Date(FUT).toISOString().replace('T', ' ').replace(/\.000Z$/, '').replace('Z', '');
    assert(dated.r.status === 200 && String(drow.plan_expires_at).startsWith(wantPlan.slice(0, 19)), 'dated link stores plan_expires_at in UTC', [drow.plan_expires_at, wantPlan]);

    console.log('\nCreate refuses live paid rows with the SAME messages as the #273 grant route');
    await mkSub('b3', 'owner3', { stripe: 'sub_clh_active', status: 'active' });
    await mkSub('b4', 'owner4', { stripe: 'sub_clh_dead', status: 'active', end: '2099-01-01' }); // Stripe says canceled, DB row still live
    await mkSub('b5', 'owner5', { stripe: 'sub_clh_throw', status: 'active' });
    await mkSub('b6', 'owner6', { stripe: 'sub_clh_dead', status: 'canceled', end: '2020-01-01' }); // dead everywhere → convertible
    for (const b of ['b3', 'b4', 'b5']) {
      const link = await call('POST', CREATE, { token: T.admin, body: { businessId: id(b), expiresAt: FUT } });
      const grant = await call('POST', `/api/admin/businesses/${id(b)}/complimentary-subscription`, { token: T.admin, body: { expiresAt: FUT } });
      assert(link.status === 409 && grant.status === 409 && link.body.error === grant.body.error, `${b}: link creation and grant give the identical 409`, [link.body, grant.body]);
    }
    assert((await q(`SELECT count(*)::int AS n FROM complimentary_grant_links WHERE business_id = ANY($1)`, [[id('b3'), id('b4'), id('b5')]]))[0].n === 0, 'no link row was written for the refused businesses');
    const okPast = await newLink('b6', { expiresAt: FUT });
    assert(okPast.r.status === 200, 'a past payer whose subscription Stripe AND the DB show as ended can get a link', okPast.r.body);

    // ── list ────────────────────────────────────────────────────────────────
    console.log('\nGET /api/admin/subscription/complimentary-links');
    const second = await newLink('b1', { permanent: true });
    r = await call('GET', `${LIST}?businessId=${id('b1')}`, { token: T.admin });
    const cols = ['businessId', 'createdAt', 'createdBy', 'id', 'linkExpiresAt', 'planExpiresAt', 'redeemedAt', 'redeemedBy', 'revokedAt'];
    assert(r.status === 200 && Array.isArray(r.body.links) && r.body.links.length === 2, 'lists the business\'s links', r.body);
    assert(r.body.links.every((l: any) => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(cols)), 'explicit columns only', Object.keys(r.body.links[0]));
    assert(!/token/i.test(Object.keys(r.body.links[0]).join()) && ![perm.token, perm.hash, second.token, second.hash].some((s) => r.text.includes(s)), 'the response holds no token, no hash, no token_hash column');
    assert(new Date(r.body.links[0].createdAt) >= new Date(r.body.links[1].createdAt) && r.body.links[0].id !== r.body.links[1].id, 'newest first, ISO timestamps', r.body.links.map((l: any) => l.createdAt));
    assert(/Z$/.test(r.body.links[0].linkExpiresAt), 'timestamps are ISO with Z');
    r = await call('GET', LIST, { token: T.admin });
    assert(r.status === 400, 'missing businessId → 400', r.status);
    r = await call('GET', `${LIST}?businessId=${id('nope')}`, { token: T.admin });
    assert(r.status === 200 && r.body.links.length === 0, 'unknown business → empty list');

    // ── revoke ──────────────────────────────────────────────────────────────
    console.log('\nDELETE /api/admin/subscription/complimentary-link/:id');
    const revLink = await newLink('b7');
    const revId = (await q(`SELECT id FROM complimentary_grant_links WHERE token_hash = $1`, [revLink.hash]))[0].id;
    r = await call('DELETE', `${CREATE}/${id('no-such-link')}`, { token: T.admin });
    assert(r.status === 404, 'unknown id → 404', r.body);
    r = await call('DELETE', `${CREATE}/${revId}`, { token: T.admin });
    assert(r.status === 200 && (await q(`SELECT revoked_at FROM complimentary_grant_links WHERE id = $1`, [revId]))[0].revoked_at !== null, 'pending link → revoked');
    r = await call('DELETE', `${CREATE}/${revId}`, { token: T.admin });
    assert(r.status === 409 && r.body.error === 'This link was already used or revoked.', 'second revoke → 409', r.body);
    r = await call('POST', REDEEM, { token: T.owner7, body: { token: revLink.token } });
    assert(r.status === 410 && r.body.code === 'LINK_UNAVAILABLE', 'claiming a revoked link → 410 LINK_UNAVAILABLE', r.body);

    // ── redeem ──────────────────────────────────────────────────────────────
    console.log('\nPOST /api/subscription/complimentary-link/redeem');
    const responses: string[] = [];
    const redeem = async (who: string | undefined, body: unknown, ip?: string) => { const x = await call('POST', REDEEM, { token: who ? T[who] : undefined, body, ip }); responses.push(x.text); return x; };
    r = await redeem(undefined, { token: perm.token });
    assert(r.status === 401, 'no auth → 401', r.status);
    for (const [label, body] of [['missing token', {}], ['non-string token', { token: 12345 }], ['wrong length', { token: 'abc' }], ['a grandfathered-style signed token', { token: grantToken.generate(id('b1'), 'tier') }], ['well-formed but unknown', { token: 'A'.repeat(43) }]] as Array<[string, unknown]>) {
      r = await redeem('owner1', body);
      assert(r.status === 404 && r.body.code === 'NOT_FOUND', `${label} → 404 NOT_FOUND`, r.body);
    }
    r = await redeem('owner2', { token: perm.token });
    assert(r.status === 403 && r.body.code === 'WRONG_ACCOUNT', 'another business owner → 403 WRONG_ACCOUNT', r.body);
    r = await redeem('nobiz', { token: perm.token });
    assert(r.status === 403 && r.body.code === 'NO_BUSINESS', 'an account with no business → 403 NO_BUSINESS', r.body);
    assert((await q(`SELECT redeemed_at FROM complimentary_grant_links WHERE token_hash = $1`, [perm.hash]))[0].redeemed_at === null, 'refused claims left the link unused');

    await q(`UPDATE complimentary_grant_links SET link_expires_at = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE token_hash = $1`, [second.hash]);
    r = await redeem('owner1', { token: second.token });
    assert(r.status === 410 && r.body.code === 'LINK_UNAVAILABLE', 'expired link → 410', r.body);
    const planGone = await newLink('b1');
    await q(`UPDATE complimentary_grant_links SET plan_expires_at = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE token_hash = $1`, [planGone.hash]);
    r = await redeem('owner1', { token: planGone.token });
    assert(r.status === 410 && r.body.code === 'LINK_UNAVAILABLE', 'expired plan → 410', r.body);

    // live paid rows: create rows directly (link creation would refuse them)
    const direct = async (b: string) => { const t = (await import('./utils/complimentaryLinkToken')).generate(); secrets.add(t); secrets.add(hash(t)); await q(`INSERT INTO complimentary_grant_links (token_hash, business_id, link_expires_at, created_by) VALUES ($1, $2, (now() AT TIME ZONE 'UTC') + interval '7 days', $3)`, [hash(t), id(b), ADMIN]); return t; };
    const t3 = await direct('b3');
    r = await redeem('owner3', { token: t3 });
    assert(r.status === 409 && /still active/.test(r.body.error), 'Stripe says the old subscription is still active → 409 (grant-route message)', r.body);
    const t4 = await direct('b4');
    r = await redeem('owner4', { token: t4 });
    assert(r.status === 409 && r.body.error === 'This business has a paid subscription that is still live. Complimentary grant refused.', 'Stripe terminal but DB row live → 409 "paid subscription that is still live"', r.body);
    const t5 = await direct('b5');
    r = await redeem('owner5', { token: t5 });
    assert(r.status === 409 && /Could not verify/.test(r.body.error), 'Stripe lookup error → 409 "Could not verify…"', r.body);
    assert((await q(`SELECT count(*)::int AS n FROM complimentary_grant_links WHERE business_id = ANY($1) AND redeemed_at IS NOT NULL`, [[id('b3'), id('b4'), id('b5')]]))[0].n === 0, 'every refused claim left its link UNUSED');
    assert((await q(`SELECT count(*)::int AS n FROM vendor_subscriptions WHERE business_id = ANY($1) AND tier_id = (SELECT id FROM subscription_tiers WHERE name = 'waived')`, [[id('b3'), id('b4'), id('b5')]]))[0].n === 0, 'and no paid row was overwritten');

    // success + body business id ignored
    r = await redeem('owner1', { token: perm.token, businessId: id('b2'), tierId: 'growth' });
    assert(r.status === 200 && JSON.stringify(Object.keys(r.body).sort()) === '["connectReady","subscription"]', 'owner claims → 200 { subscription, connectReady }', r.body);
    assert(r.body.subscription.businessId === id('b1') && r.body.subscription.status === 'active' && r.body.subscription.currentPeriodEnd === '2099-01-01T00:00:00.000Z' && r.body.subscription.stripeSubscriptionId === null, 'granted to the LINK\'s business (a businessId in the body is ignored), permanent, no Stripe id', r.body.subscription);
    assert(r.body.connectReady === true, 'connectReady true when the business has a ready Connect account (fake Stripe)');
    assert((await q(`SELECT count(*)::int AS n FROM vendor_subscriptions WHERE business_id = $1`, [id('b2')]))[0].n === 0, 'the business named in the body got nothing');
    assert((await q(`SELECT subscription_active FROM businesses WHERE id = $1`, [id('b1')]))[0].subscription_active === true, 'businesses.subscription_active = true');
    const audit = await q(`SELECT actor_type, action, metadata FROM audit_logs WHERE target_id = $1`, [r.body.subscription.id]);
    assert(audit.length === 1 && audit[0].actor_type === 'vendor' && audit[0].action === 'complimentary_subscription.redeem', 'one audit row (vendor / redeem)');
    assert(!JSON.stringify(audit).includes(perm.token) && !JSON.stringify(audit).includes(perm.hash), 'audit metadata holds neither token nor hash');
    r = await redeem('owner1', { token: perm.token });
    assert(r.status === 410 && r.body.code === 'LINK_UNAVAILABLE', 'claiming the same link again → 410', r.body);
    r = await call('DELETE', `${CREATE}/${(await q(`SELECT id FROM complimentary_grant_links WHERE token_hash = $1`, [perm.hash]))[0].id}`, { token: T.admin });
    assert(r.status === 409, 'revoking a redeemed link → 409', r.body);

    // connectReady false + dated end + past payer conversion
    r = await redeem('owner6', { token: okPast.token });
    assert(r.status === 200 && r.body.connectReady === false && r.body.subscription.stripeSubscriptionId === null && r.body.subscription.tierId !== undefined, 'past payer (canceled everywhere) converts; no Connect account → connectReady false', r.body);

    // concurrent double-claim over HTTP
    const conc = await newLink('b2');
    const [c1, c2] = await Promise.all([redeem('owner2', { token: conc.token }), redeem('owner2', { token: conc.token })]);
    assert([c1.status, c2.status].sort().join() === '200,410', 'two simultaneous claims → exactly one 200 and one 410', [c1.status, c2.status]);
    assert((await q(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'complimentary_subscription.redeem' AND metadata->>'businessId' = $1`, [id('b2')]))[0].n === 1, 'exactly one audit row for the double claim');

    // responses never hold a token or hash
    const all = responses.join('\n');
    assert([...secrets].every((s) => !all.includes(s)), `none of ${secrets.size} tokens/hashes appears in ${responses.length} redeem responses`);

    // malformed JSON
    const parts = 'SECRETFRAGMENT' + conc.token.slice(0, 20);
    r = await call('POST', REDEEM, { token: T.owner1, raw: `{"token":${parts}}` });
    assert(r.status === 400, 'malformed JSON → 400', r.status);

    // grandfathered isolation
    console.log('\nGrandfathered grant links are untouched');
    const gfTier = (await q(`SELECT id FROM subscription_tiers WHERE name = 'grandfathered'`))[0].id;
    r = await call('POST', '/api/admin/subscription/grant-link', { token: T.admin, body: { businessId: id('b1'), tierId: gfTier } });
    assert(r.status === 200 && /\/subscribe\/grant\/[^/]+\.[^/]+$/.test(r.body.grantUrl), 'grandfathered link still generated (signed, contains ".")', r.body);
    const gfToken = r.body.grantUrl.split('/subscribe/grant/')[1];
    r = await redeem('owner1', { token: gfToken });
    assert(r.status === 404 && r.body.code === 'NOT_FOUND', 'a grandfathered token is rejected on the free path', r.body);
    const freshFree = await newLink('b1');
    r = await call('POST', '/api/subscription/grant-link/redeem', { token: T.owner1, body: { token: freshFree.token } });
    assert(r.status === 400 && r.body.error === 'Invalid grant link.', 'a free-plan token is rejected on the grandfathered path', r.body);
    r = await call('POST', '/api/subscription/grant-link/redeem', { token: T.owner1, body: { token: gfToken } });
    assert(r.status === 200 && r.body.tierId === gfTier, 'a valid grandfathered token still redeems exactly as before', r.body);

    // rate limit: a dedicated bucket of 10 per IP, separate from authRateLimiter
    console.log('\nRedeem rate limiter');
    const RL_IP = '10.200.0.1';
    const statuses: number[] = [];
    let last: any;
    for (let i = 0; i < 11; i++) { last = await redeem('owner1', { token: 'B'.repeat(43) }, RL_IP); statuses.push(last.status); }
    assert(statuses.slice(0, 10).every((s) => s === 404) && statuses[10] === 429, 'IP is limited on the 11th attempt within the window (10 × 404 then 429)', statuses);
    assert(typeof last.body.error === 'string' && last.body.code === 'RATE_LIMITED' && typeof last.body.message === 'string', '429 body carries a plain-string `error`, `message` and code RATE_LIMITED', last.body);
    r = await redeem('owner1', { token: 'B'.repeat(43) }, '10.200.0.2');
    assert(r.status === 404, 'a different IP is unaffected');
    const signupProbe = await call('POST', '/api/auth/register', { body: {}, ip: RL_IP });
    assert(signupProbe.status !== 429, 'the shared authRateLimiter bucket (signup) is NOT consumed by redeem attempts', signupProbe.status);

    // ── admin businesses list (B6) ──────────────────────────────────────────
    console.log('\nGET /api/admin/businesses (additive fields, limit clamp)');
    const list = async (qs: string) => call('GET', `/api/admin/businesses${qs}`, { token: T.admin });
    r = await list(`?limit=500&search=${P}`);
    const mine = r.body.businesses.filter((b: any) => b.id.startsWith(P));
    assert(r.status === 200 && mine.length === 7, 'admin list still returns all rows', r.body.total);
    assert(r.body.businesses.every((b: any) => 'subscription' in b && typeof b.hasConnectAccount === 'boolean'), 'every row has `subscription` and boolean `hasConnectAccount`');
    const lanaLike = mine.find((b: any) => b.id === id('b1'));
    assert(lanaLike.hasConnectAccount === true && lanaLike.subscription && lanaLike.subscription.isComplimentary === true && lanaLike.subscription.tierName === 'waived' && lanaLike.subscription.hasStripeSubscription === false && lanaLike.subscription.currentPeriodEnd === '2099-01-01T00:00:00.000Z' && JSON.stringify(Object.keys(lanaLike.subscription).sort()) === '["currentPeriodEnd","hasStripeSubscription","isComplimentary","status","tierDisplayName","tierName"]', 'complimentary row: six-key summary, 2099 ISO, has Connect account', lanaLike.subscription);
    const paid = mine.find((b: any) => b.id === id('b3'));
    assert(paid.subscription.isComplimentary === false && paid.subscription.hasStripeSubscription === true && paid.subscription.tierName === 'growth' && paid.hasConnectAccount === false, 'paid row: not complimentary, has Stripe subscription, no Connect account');
    const none = mine.find((b: any) => b.id === id('b5')) ;
    assert(['ownerEmail', 'ownerName', 'stripeAccountId', 'subscriptionActive', 'approvalStatus', 'name', 'id'].every((k) => k in lanaLike), 'existing fields (ownerEmail, ownerName, stripeAccountId, subscriptionActive, …) are all still present');
    assert(none !== undefined, 'rows without changes still appear');
    r = await list(`?limit=abc`);
    assert(r.status === 200 && r.body.businesses.length <= 50 && r.body.businesses.length > 0, 'limit=abc → default 50 (not an empty page)', r.body.businesses.length);
    r = await list('?limit=0');
    assert(r.body.businesses.length === 1, 'limit=0 → clamped to 1', r.body.businesses.length);
    r = await list('?limit=1');
    assert(r.body.businesses.length === 1 && 'subscription' in r.body.businesses[0], 'limit=1 → one row (subscription summary bounded by the page)');
    r = await list('?limit=100000');
    assert(r.status === 200 && r.body.businesses.length === Math.min(200, r.body.total), 'limit=100000 → clamped to 200', [r.body.businesses.length, r.body.total]);
    r = await call('GET', '/api/admin/businesses', { token: T.owner1 });
    assert(r.status === 403, 'admin list still 403 for non-admins');

    // ── the server log ──────────────────────────────────────────────────────
    console.log('\nServer log');
    if (LOG_FILE) {
      const log = readFileSync(LOG_FILE, 'utf8');
      assert(log.length > 0 && [...secrets].every((s) => !log.includes(s)), `none of ${secrets.size} tokens/hashes appears anywhere in the ${log.length}-byte server log`);
      assert(!log.includes('SECRETFRAGMENT') && !log.includes(conc.token.slice(0, 20)), 'the malformed-JSON body fragment never reached the log');
      assert(log.includes('[ERROR] Malformed JSON body'), 'the fixed malformed-body line is what got logged');
    } else {
      console.log('  ⏭  set COMPLIMENTARY_TEST_SERVER_LOG to scan the server log');
    }
  } finally {
    const like = `${P}%`;
    await q(`DELETE FROM audit_logs WHERE target_id IN (SELECT id FROM vendor_subscriptions WHERE business_id LIKE $1) OR actor_id LIKE $1`, [like]);
    await q(`DELETE FROM complimentary_grant_links WHERE business_id LIKE $1`, [like]);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id LIKE $1`, [like]);
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [like]);
    await db.end();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
