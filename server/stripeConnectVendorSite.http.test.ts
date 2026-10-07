/**
 * Stripe Connect `vendor-site` return type — run with: npx tsx server/stripeConnectVendorSite.http.test.ts
 *
 * Part 1 (always runs, no network): isAllowedClientOrigin + the clientSiteOrigins list.
 *
 * Part 2 (HTTP, SCRATCH ONLY): needs a backend booted on localhost against a LOCAL scratch Postgres,
 * with Stripe routed to the stub this test starts (never real Stripe, never Neon):
 *   VS_TEST_BASE_URL        e.g. http://localhost:5071                 (must be localhost)
 *   VS_TEST_PG_URL          the SAME scratch database (localhost only; seeds + cleans up)
 *   VS_TEST_STRIPE_PORT     port for the in-process Stripe stub; boot the server with
 *                           STRIPE_STUB_PORT=<same> and NODE_OPTIONS="--import ./.dev/neon-preload.mjs
 *                           --import ./.dev/stripe-stub-preload.mjs"
 *   VS_TEST_API_BASE_URL    the server's API_BASE_URL     (e.g. https://backend.test)
 *   VS_TEST_FRONTEND_URL    the server's FRONTEND_URL     (e.g. https://www.goutsyde.test)
 *   JWT_SECRET              identical to the server's
 * Part 2 skips (exit 0 after part 1) when VS_TEST_BASE_URL is unset, and refuses any non-local host.
 */
import http from 'http';
import { clientSiteOrigins, isAllowedClientOrigin, normalizeClientOrigin } from './clientOrigins';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

// The list as it was inline in server/index.ts at main 7393def, before it moved to ./clientOrigins.
const ORIGINS_AT_7393DEF = [
  'http://localhost:3001',
  'https://xobeautyandlashes.com',
  'https://lotushouseblends.com',
  'https://www.lotushouseblends.com',
  'https://braids-with-love-site.vercel.app',
  'https://www.braids-with-love-site.vercel.app',
  'https://braidsbylana.com',
  'https://www.braidsbylana.com',
  'https://braids-with-lana-site.vercel.app',
];
const NAIL_SNIPER = 'https://nail-sniper-web.vercel.app';
const NAIL_SNIPER_ENC = encodeURIComponent(NAIL_SNIPER);

function unitTests() {
  console.log('\n— clientOrigins (unit)');
  assert(JSON.stringify(clientSiteOrigins) === JSON.stringify([...ORIGINS_AT_7393DEF, NAIL_SNIPER]),
    'clientSiteOrigins = the 7393def list (same order) + nail-sniper-web.vercel.app appended', clientSiteOrigins);
  for (const o of clientSiteOrigins) assert(isAllowedClientOrigin(o), `allowed: ${o}`);
  assert(isAllowedClientOrigin(`${NAIL_SNIPER}/`), 'one trailing slash is normalised');
  assert(normalizeClientOrigin(`${NAIL_SNIPER}/`) === NAIL_SNIPER, 'normalizeClientOrigin drops the trailing slash');
  const rejected: unknown[] = [
    'http://nail-sniper-web.vercel.app',          // scheme
    'https://nail-sniper-web.vercel.app.evil.com', // suffix
    'https://evil.nail-sniper-web.vercel.app',     // subdomain
    'https://nail-sniper-web.vercel.app@evil.com', // userinfo trick
    'https://nail-sniper-web.vercel.app/dashboard', // path
    'https://nail-sniper-web.vercel.app//',        // two slashes
    'HTTPS://NAIL-SNIPER-WEB.VERCEL.APP',          // case (exact match only)
    ' https://nail-sniper-web.vercel.app',         // whitespace
    'https://nail-sniper-web.vercel.app\r\nX: y',  // header injection
    'outsyde://stripe-return',                     // the app's returnUrl
    'https://evil.example', '', null, undefined, 123, {}, [NAIL_SNIPER],
  ];
  for (const o of rejected) assert(!isAllowedClientOrigin(o), `rejected: ${JSON.stringify(o)}`);
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(base: string, method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const data = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...(opts.headers || {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: b })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  unitTests();

  const BASE = process.env.VS_TEST_BASE_URL;
  const PG_URL = process.env.VS_TEST_PG_URL;
  const STUB_PORT = Number(process.env.VS_TEST_STRIPE_PORT);
  const API_BASE = process.env.VS_TEST_API_BASE_URL;
  const FRONTEND = process.env.VS_TEST_FRONTEND_URL;
  if (!BASE) {
    console.log('\n⏭  HTTP part skipped: set VS_TEST_BASE_URL (+ VS_TEST_PG_URL, VS_TEST_STRIPE_PORT, VS_TEST_API_BASE_URL, VS_TEST_FRONTEND_URL)');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT || !API_BASE || !FRONTEND) {
    throw new Error('refusing to run: base URL and database must both be local scratch instances, and all VS_TEST_* vars set');
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-jwt-secret';
  const { generateAccessToken } = await import('./auth');

  // ── Stripe stub (the server's https.request to api.stripe.com is routed here) ─────────────
  const stripeAccounts: Record<string, { details_submitted: boolean; charges_enabled: boolean }> = {};
  const accountLinkCalls: Array<{ account: string; refresh_url: string; return_url: string }> = [];
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === 'POST' && req.url === '/v1/account_links') {
        const call = { account: form.get('account') || '', refresh_url: form.get('refresh_url') || '', return_url: form.get('return_url') || '' };
        accountLinkCalls.push(call);
        return send(200, { object: 'account_link', created: 1, expires_at: 2, url: `https://connect.stripe.test/setup/${accountLinkCalls.length}` });
      }
      const m = req.url?.match(/^\/v1\/accounts\/([^/?]+)/);
      if (req.method === 'GET' && m && stripeAccounts[m[1]]) {
        return send(200, { id: m[1], object: 'account', ...stripeAccounts[m[1]], payouts_enabled: stripeAccounts[m[1]].charges_enabled });
      }
      send(404, { error: { type: 'invalid_request_error', message: `stub: no route for ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `vs-${Date.now().toString(36)}`;
  const seededUsers: string[] = [];
  const seededBiz: string[] = [];
  const mkVendor = async (key: string, acct: string | null) => {
    const uid = `${P}-u-${key}`;
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [uid, `${uid}@x.test`]);
    seededUsers.push(uid);
    const bid = `${P}-b-${key}`;
    await q(`INSERT INTO businesses (id, owner_id, name, category, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'beauty', $4, false)`,
      [bid, uid, `VS ${key}`, acct]);
    seededBiz.push(bid);
    return { uid, bid, token: generateAccessToken({ userId: uid, isVendor: true }) };
  };
  const flag = async (bid: string) => (await q(`SELECT stripe_onboarding_complete AS c FROM businesses WHERE id = $1`, [bid]))[0]?.c;

  try {
    // ── create-link ─────────────────────────────────────────────────────────────────────────
    console.log('\n— POST /api/vendor/stripe-onboarding/create-link');
    const acctLink = `acct_${P.replace(/-/g, '')}link`;
    const linkVendor = await mkVendor('link', acctLink);
    const createLink = async (json: unknown) => {
      const before = accountLinkCalls.length;
      const r = await request(BASE, 'POST', '/api/vendor/stripe-onboarding/create-link', { headers: { Authorization: `Bearer ${linkVendor.token}` }, json });
      return { r, call: accountLinkCalls[before], calls: accountLinkCalls.length - before };
    };
    const vendorUrls = {
      refresh: `${API_BASE}/api/stripe/connect-refresh?account=${acctLink}&type=vendor`,
      ret: `${API_BASE}/api/stripe/connect-return?account=${acctLink}&type=vendor`,
    };
    const webUrls = {
      refresh: `${API_BASE}/api/stripe/connect-refresh?account=${acctLink}&type=vendor-web`,
      ret: `${API_BASE}/api/stripe/connect-return?account=${acctLink}&type=vendor-web`,
    };
    const siteUrls = {
      refresh: `${API_BASE}/api/stripe/connect-refresh?account=${acctLink}&type=vendor-site&origin=${NAIL_SNIPER_ENC}`,
      ret: `${API_BASE}/api/stripe/connect-return?account=${acctLink}&type=vendor-site&origin=${NAIL_SNIPER_ENC}`,
    };
    const expectLink = (label: string, out: Awaited<ReturnType<typeof createLink>>, urls: { refresh: string; ret: string }) => {
      const body = (() => { try { return JSON.parse(out.r.body); } catch { return null; } })();
      assert(out.r.status === 200, `${label}: 200`, out.r);
      assert(out.calls === 1 && out.call?.account === acctLink, `${label}: one account link for the business account`, out.call);
      assert(out.call?.refresh_url === urls.refresh, `${label}: refresh_url`, out.call?.refresh_url);
      assert(out.call?.return_url === urls.ret, `${label}: return_url`, out.call?.return_url);
      assert(body && JSON.stringify(Object.keys(body)) === JSON.stringify(['url', 'stripeAccountId']) && body.stripeAccountId === acctLink,
        `${label}: response shape {url, stripeAccountId}`, body);
    };
    expectLink('empty body (old app, BusinessOnboardingScreen) → vendor', await createLink(undefined), vendorUrls);
    expectLink('{} → vendor', await createLink({}), vendorUrls);
    expectLink('old app {returnUrl, refreshUrl} → vendor (ignored, unchanged)',
      await createLink({ returnUrl: 'outsyde://stripe-return', refreshUrl: 'outsyde://stripe-return' }), vendorUrls);
    expectLink('{webRedirect:true} (goutsyde.com) → vendor-web', await createLink({ webRedirect: true }), webUrls);
    expectLink('allowlisted returnOrigin → vendor-site', await createLink({ returnOrigin: NAIL_SNIPER }), siteUrls);
    expectLink('allowlisted returnOrigin with trailing slash → vendor-site', await createLink({ returnOrigin: `${NAIL_SNIPER}/` }), siteUrls);
    expectLink('allowlisted returnOrigin + webRedirect → vendor-site', await createLink({ returnOrigin: NAIL_SNIPER, webRedirect: true }), siteUrls);
    expectLink('non-allowlisted returnOrigin → vendor (ignored)', await createLink({ returnOrigin: 'https://evil.example' }), vendorUrls);
    expectLink('suffix-trick returnOrigin → vendor (ignored)', await createLink({ returnOrigin: `${NAIL_SNIPER}.evil.com` }), vendorUrls);
    expectLink('non-string returnOrigin → vendor (ignored)', await createLink({ returnOrigin: 123 }), vendorUrls);
    expectLink('non-allowlisted returnOrigin + webRedirect → vendor-web', await createLink({ returnOrigin: 'https://evil.example', webRedirect: true }), webUrls);
    const stored = (await q(`SELECT stripe_onboarding_url AS u FROM businesses WHERE id = $1`, [linkVendor.bid]))[0]?.u;
    assert(typeof stored === 'string' && stored.startsWith('https://connect.stripe.test/setup/'), 'stripeOnboardingUrl stored as before', stored);

    // ── connect-return ──────────────────────────────────────────────────────────────────────
    console.log('\n— GET /api/stripe/connect-return');
    const ret = (qs: string) => request(BASE, 'GET', `/api/stripe/connect-return?${qs}`);
    const siteReturn = `${NAIL_SNIPER}/dashboard/stripe/return?status=complete`;
    const webReturn = `${FRONTEND}/vendor-dashboard/stripe/return?status=complete`;

    const acctDetails = `acct_${P.replace(/-/g, '')}det`;
    stripeAccounts[acctDetails] = { details_submitted: true, charges_enabled: false };
    const vDetails = await mkVendor('det', acctDetails);
    let r = await ret(`account=${acctDetails}&type=vendor-site&origin=${NAIL_SNIPER_ENC}`);
    assert(r.status === 302 && r.headers.location === siteReturn, 'vendor-site, details only: redirect to the site return page', r.headers.location);
    assert((await flag(vDetails.bid)) === false, 'vendor-site, details only (no charges): flag NOT set');

    const acctBoth = `acct_${P.replace(/-/g, '')}both`;
    stripeAccounts[acctBoth] = { details_submitted: true, charges_enabled: true };
    const vBoth = await mkVendor('both', acctBoth);
    r = await ret(`account=${acctBoth}&type=vendor-site&origin=${NAIL_SNIPER_ENC}`);
    assert(r.status === 302 && r.headers.location === siteReturn, 'vendor-site, details + charges: redirect to the site return page', r.headers.location);
    assert((await flag(vBoth.bid)) === true, 'vendor-site, details + charges: flag set');

    const acctNone = `acct_${P.replace(/-/g, '')}none`;
    stripeAccounts[acctNone] = { details_submitted: false, charges_enabled: false };
    const vNone = await mkVendor('none', acctNone);
    r = await ret(`account=${acctNone}&type=vendor-site&origin=${NAIL_SNIPER_ENC}`);
    assert(r.headers.location === siteReturn && (await flag(vNone.bid)) === false, 'vendor-site, nothing submitted: flag NOT set, status=complete kept in redirect');

    r = await ret(`account=${acctNone}&type=vendor-site&origin=${encodeURIComponent('https://evil.example')}`);
    assert(r.status === 302 && r.headers.location === webReturn, 'vendor-site, disallowed origin: goutsyde vendor-web fallback', r.headers.location);
    r = await ret(`account=${acctNone}&type=vendor-site`);
    assert(r.status === 302 && r.headers.location === webReturn, 'vendor-site, missing origin: goutsyde vendor-web fallback', r.headers.location);
    r = await ret(`account=${acctNone}&type=vendor-site&origin=${encodeURIComponent(`${NAIL_SNIPER}.evil.com`)}`);
    assert(r.headers.location === webReturn, 'vendor-site, suffix-trick origin: fallback', r.headers.location);
    r = await ret(`account=${acctNone}&type=vendor-site&origin=${NAIL_SNIPER_ENC}&origin=https%3A%2F%2Fevil.example`);
    assert(r.headers.location === webReturn, 'vendor-site, repeated origin param (array): fallback', r.headers.location);

    // Existing types — behaviour unchanged (details_submitted alone still sets the flag).
    const acctVendor = `acct_${P.replace(/-/g, '')}app`;
    stripeAccounts[acctVendor] = { details_submitted: true, charges_enabled: false };
    const vApp = await mkVendor('app', acctVendor);
    r = await ret(`account=${acctVendor}&type=vendor`);
    assert(r.status === 302 && r.headers.location === 'outsyde://stripe-return?status=complete&type=vendor', 'type=vendor: app deep link unchanged', r.headers.location);
    assert((await flag(vApp.bid)) === true, 'type=vendor, details only: flag set (unchanged rule)');

    const acctWeb = `acct_${P.replace(/-/g, '')}web`;
    stripeAccounts[acctWeb] = { details_submitted: true, charges_enabled: false };
    const vWeb = await mkVendor('web', acctWeb);
    r = await ret(`account=${acctWeb}&type=vendor-web&origin=${NAIL_SNIPER_ENC}`);
    assert(r.status === 302 && r.headers.location === webReturn, 'type=vendor-web: goutsyde return page unchanged (origin ignored)', r.headers.location);
    assert((await flag(vWeb.bid)) === true, 'type=vendor-web, details only: flag set (unchanged rule)');

    r = await ret(`account=${acctNone}`);
    assert(r.headers.location === 'outsyde://stripe-return?status=complete&type=vendor', 'no type: app deep link unchanged', r.headers.location);
    r = await ret(`account=${acctNone}&type=staff&staffId=s1`);
    assert(r.headers.location === 'outsyde://stripe-return?status=complete&type=staff&staffId=s1', 'type=staff: deep link unchanged', r.headers.location);

    // ── connect-refresh ─────────────────────────────────────────────────────────────────────
    console.log('\n— GET /api/stripe/connect-refresh');
    const ref = (qs: string) => request(BASE, 'GET', `/api/stripe/connect-refresh?${qs}`);
    r = await ref(`account=x&type=vendor-site&origin=${NAIL_SNIPER_ENC}`);
    assert(r.status === 302 && r.headers.location === `${NAIL_SNIPER}/dashboard/stripe/refresh`, 'vendor-site, allowed origin: site refresh page', r.headers.location);
    r = await ref(`account=x&type=vendor-site&origin=${encodeURIComponent('https://evil.example')}`);
    assert(r.headers.location === `${FRONTEND}/vendor-dashboard/stripe/refresh`, 'vendor-site, disallowed origin: vendor-web fallback', r.headers.location);
    r = await ref(`account=x&type=vendor-web`);
    assert(r.headers.location === `${FRONTEND}/vendor-dashboard/stripe/refresh`, 'type=vendor-web: unchanged', r.headers.location);
    r = await ref(`account=x&type=vendor`);
    assert(r.headers.location === 'outsyde://stripe-return?status=refresh&type=vendor', 'type=vendor: deep link unchanged', r.headers.location);
    r = await ref(`account=x&type=staff&staffId=s1`);
    assert(r.headers.location === 'outsyde://stripe-return?status=refresh&type=staff&staffId=s1', 'type=staff: deep link unchanged', r.headers.location);

    // ── CORS ────────────────────────────────────────────────────────────────────────────────
    console.log('\n— CORS');
    const cors = (origin: string) => request(BASE, 'GET', '/api/stripe/connect-refresh?type=vendor', { headers: { Origin: origin } });
    for (const o of ['https://braidsbylana.com', 'https://lotushouseblends.com', NAIL_SNIPER]) {
      r = await cors(o);
      assert(r.headers['access-control-allow-origin'] === o && r.headers['access-control-allow-credentials'] === 'true', `CORS allows ${o}`, r.headers);
    }
    r = await cors('https://random.example');
    assert(r.headers['access-control-allow-origin'] === undefined && r.status >= 400, 'CORS rejects https://random.example', { status: r.status, acao: r.headers['access-control-allow-origin'] });
    r = await request(BASE, 'GET', '/api/stripe/connect-refresh?type=vendor');
    assert(r.status === 302, 'no Origin header (app / server-to-server): allowed as before', r.status);
  } finally {
    if (seededBiz.length) await q(`DELETE FROM businesses WHERE id = ANY($1)`, [seededBiz]);
    if (seededUsers.length) await q(`DELETE FROM users WHERE id = ANY($1)`, [seededUsers]);
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
