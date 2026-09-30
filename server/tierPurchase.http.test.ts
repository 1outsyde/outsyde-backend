/**
 * Hidden-plan guard, HTTP — run with: npx tsx server/tierPurchase.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema)
 * with a fake Stripe, and the same secrets in this process:
 *   TIER_TEST_BASE_URL    e.g. http://localhost:5058         (must be localhost)
 *   TIER_TEST_PG_URL      the SAME scratch database (localhost only; seeds + cleans up)
 *   TIER_TEST_SERVER_LOG  the server's stdout/stderr file (asserted to hold no grant token)
 *   JWT_SECRET, GRANT_LINK_SECRET  identical to the server's
 *   server fake Stripe: FAKE_SUBS='{"sub_tp_pro":"active","sub_tp_pro2":"active","sub_tp_gf":"active","sub_tp_old":"canceled"}'
 * It skips (exit 0) when TIER_TEST_BASE_URL is unset and refuses any non-local host, so it can never
 * touch Neon or production. Every request carries its own X-Forwarded-For (login is rate limited).
 */

import { createHmac } from 'crypto';
import { readFileSync } from 'fs';

const BASE = process.env.TIER_TEST_BASE_URL;
const PG_URL = process.env.TIER_TEST_PG_URL;
const LOG_FILE = process.env.TIER_TEST_SERVER_LOG;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);
const MSG = "This plan isn't available for your account.";

(async () => {
  if (!BASE) { console.log('⏭  skipped: set TIER_TEST_BASE_URL (+ TIER_TEST_PG_URL) to run the HTTP tests'); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error('refusing to run: base URL and database must both be local scratch instances');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-jwt-secret';
  process.env.GRANT_LINK_SECRET = process.env.GRANT_LINK_SECRET || 'verify-grant-secret';

  const { generateAccessToken, hashPassword } = await import('./auth');
  const { grantToken } = await import('./utils/grantToken');
  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `tp${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const tier = async (name: string) => (await q(`SELECT id FROM subscription_tiers WHERE name = $1`, [name]))[0].id as string;
  const T = { starter: await tier('starter'), growth: await tier('growth'), pro: await tier('pro'), gf: await tier('grandfathered'), waived: await tier('waived') };
  const PASSWORD = 'Passw0rd!';
  const hash = await hashPassword(PASSWORD);

  const people = ['newv', 'lana', 'pro', 'pro2', 'lapsed', 'livegf', 'grantee', 'other'];
  const jwt: Record<string, string> = {};
  for (const p of people) {
    await q(`INSERT INTO users (id, username, email, password, is_vendor, first_name) VALUES ($1::varchar, $1::text, $2, $3, true, $4)`, [id(p), `${id(p)}@tp.test`, hash, p]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES ($1::varchar, $2, $1::text, 'beauty', 'approved')`, [id(`b-${p}`), id(p)]);
    jwt[p] = generateAccessToken({ userId: id(p), isVendor: true, isAdmin: false });
  }
  const row = (p: string, tierId: string, status: string, stripe: string | null, end: string) =>
    q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, status, stripe_subscription_id, current_period_end) VALUES ($1, $2, $3, $4, $5, $6)`, [id(p), id(`b-${p}`), tierId, status, stripe, end]);
  await row('lana', T.waived, 'active', null, '2099-01-01');
  await row('pro', T.pro, 'active', 'sub_tp_pro', '2099-01-01');
  await row('pro2', T.pro, 'active', 'sub_tp_pro2', '2099-01-01');
  await row('lapsed', T.gf, 'canceled', 'sub_tp_old', '2020-01-01');
  await row('livegf', T.gf, 'active', 'sub_tp_gf', '2099-01-01');

  let ipSeq = 0;
  async function call(method: string, path: string, o: { token?: string; cookie?: string; body?: unknown } = {}) {
    // X-Forwarded-Proto: the production session cookie is `secure`, which express-session only sets on https.
    const headers: Record<string, string> = { 'X-Forwarded-For': `10.55.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`, 'X-Forwarded-Proto': 'https' };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.Cookie = o.cookie;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text, setCookie: r.headers.get('set-cookie') };
  }
  const CHECKOUT = '/api/stripe/checkout/tier-subscription';
  const CHANGE = '/api/vendor/subscription/change-tier';
  const PREVIEW = '/api/vendor/subscription/preview-change';
  const checkout = (who: string, tierId: string, grant?: unknown) => call('POST', CHECKOUT, { token: jwt[who], body: grant === undefined ? { tierId } : { tierId, grant } });
  const change = (who: string, newTierId: string, grant?: unknown) => call('POST', CHANGE, { token: jwt[who], body: grant === undefined ? { newTierId } : { newTierId, grant } });
  const secrets = new Set<string>();
  const mint = (p: string, tierId: string) => { const t = grantToken.generate(id(`b-${p}`), tierId); secrets.add(t); return t; };
  const expiredFor = (p: string, tierId: string) => {
    const enc = Buffer.from(JSON.stringify({ businessId: id(`b-${p}`), tierId, exp: Date.now() - 1000 })).toString('base64url');
    const t = `${enc}.${createHmac('sha256', process.env.GRANT_LINK_SECRET!).update(enc).digest('base64url')}`; secrets.add(t); return t;
  };
  const refused403 = (r: { status: number; body: any }) => r.status === 403 && r.body?.success === false && r.body?.error?.code === 'TIER_NOT_AVAILABLE' && r.body?.error?.message === MSG;
  const refusedFlat = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'TIER_NOT_AVAILABLE' && r.body?.error === MSG;

  try {
    console.log('\nPOST /api/stripe/checkout/tier-subscription');
    let r = await checkout('newv', T.gf);
    assert(refused403(r), 'new vendor → Grandfathered: 403 { success:false, error:{ code:"TIER_NOT_AVAILABLE", message } }', r.body);
    assert((await q(`SELECT stripe_customer_id FROM users WHERE id = $1`, [id('newv')]))[0].stripe_customer_id === null, 'a refused request created no Stripe customer (guard runs first)');
    r = await checkout('newv', T.starter);
    assert(r.status === 200 && r.body.success === true && typeof r.body.url === 'string', 'new vendor → Starter: 200 { success, url }', r.body);
    assert(Object.keys(r.body).sort().join() === 'success,url', 'success shape unchanged');

    r = await checkout('lana', T.gf);
    assert(refused403(r), 'waived (Lana-style) → Grandfathered: 403', r.body);
    r = await checkout('lana', T.growth);
    assert(r.status === 200 && typeof r.body.url === 'string', 'waived → Growth: 200 (visible plan, create path)', r.body);
    r = await checkout('lana', T.waived);
    assert(r.status === 500 && r.body.error?.code === 'SERVER_ERROR', 'waived → Waived (price-less) is refused exactly as today: 500, guard not involved', r.body);
    r = await checkout('lana', 'no-such-tier');
    assert(r.status === 500 && r.body.error?.code === 'SERVER_ERROR', 'an unknown tier id behaves as today on the create path (500)', r.body);

    r = await checkout('pro', T.gf);
    assert(refused403(r), 'live Pro payer → Grandfathered: 403 (update branch never reached)', r.body);
    assert((await q(`SELECT tier_id FROM vendor_subscriptions WHERE business_id = $1`, [id('b-pro')]))[0].tier_id === T.pro, 'and the row is untouched');
    r = await checkout('pro', T.growth);
    assert(r.status === 200 && r.body.tierChanged === true, 'live Pro payer → Growth: update branch still works (tierChanged)', r.body);
    assert((await q(`SELECT tier_id FROM vendor_subscriptions WHERE business_id = $1`, [id('b-pro')]))[0].tier_id === T.growth, 'the update branch now reads the business row and writes it');

    r = await checkout('lapsed', T.gf);
    assert(r.status === 200 && typeof r.body.url === 'string', 'lapsed Grandfathered (canceled row) → Grandfathered: allowed (own tier, any status)', r.body);
    r = await checkout('lapsed', T.pro);
    assert(r.status === 200, 'lapsed holder → Pro: visible plan, allowed');
    r = await checkout('livegf', T.gf);
    assert(r.status === 400 && r.body.error?.code === 'SAME_TIER', 'live Grandfathered → Grandfathered: SAME_TIER as today', r.body);

    console.log('\nGrant holder (business b-grantee, no plan)');
    r = await checkout('grantee', T.gf);
    assert(refused403(r), 'no grant → 403', r.body);
    const good = mint('grantee', T.gf);
    r = await checkout('grantee', T.gf, good);
    assert(r.status === 200 && typeof r.body.url === 'string', 'matching grant → allowed (200 { url })', r.body);
    r = await checkout('grantee', T.gf, mint('other', T.gf));
    assert(refused403(r), "another business's grant → 403", r.body);
    r = await checkout('grantee', T.gf, expiredFor('grantee', T.gf));
    assert(refused403(r), 'expired grant → 403 (same message)', r.body);
    const [enc, sig] = good.split('.');
    const forged = `${Buffer.from(JSON.stringify({ businessId: id('b-grantee'), tierId: T.gf, exp: Date.now() + 1e9 })).toString('base64url')}.${sig}`; secrets.add(forged);
    r = await checkout('grantee', T.gf, forged);
    assert(refused403(r), 'tampered grant (payload swapped, old signature) → 403', r.body);
    r = await checkout('grantee', T.gf, `${enc}.${sig.slice(0, -2)}xx`);
    assert(refused403(r), 'tampered signature → 403', r.body);
    r = await checkout('grantee', T.gf, mint('grantee', T.starter));
    assert(refused403(r), "a grant for another tier does not unlock Grandfathered", r.body);
    r = await checkout('grantee', T.gf, 'garbage');
    assert(refused403(r), 'garbage grant string → 403', r.body);
    r = await checkout('grantee', T.gf, '');
    assert(refused403(r), 'empty grant string → 403 (treated as no grant)', r.body);
    r = await checkout('grantee', T.starter, expiredFor('grantee', T.gf));
    assert(r.status === 200, 'a bad grant is ignored for a visible plan (Starter still 200)');
    r = await checkout('grantee', T.gf, 12345);
    assert(r.status === 400, 'a non-string grant fails the schema (400), like any invalid body', r.body);

    console.log('\nPOST /api/vendor/subscription/change-tier');
    r = await change('pro2', T.gf);
    assert(refusedFlat(r), 'live Pro payer → Grandfathered: 403 { error, code }', r.body);
    r = await change('pro2', T.gf, mint('other', T.gf));
    assert(refusedFlat(r), "with another business's grant → 403", r.body);
    r = await change('pro2', T.gf, expiredFor('pro2', T.gf));
    assert(refusedFlat(r), 'with an expired grant → 403', r.body);
    r = await change('pro2', T.gf, mint('pro2', T.gf));
    assert(r.status === 200 && r.body.success === true, 'with the matching grant → allowed (200)', r.body);
    r = await change('pro2', T.growth);
    assert(r.status === 200 && r.body.success === true, 'live Pro payer → Growth: still works', r.body);
    r = await change('pro2', T.pro);
    assert(r.status === 400 && r.body.error === 'Already on this tier', 'same tier: "Already on this tier" as today', r.body);
    r = await change('livegf', T.gf);
    assert(r.status === 400 && r.body.error === 'Already on this tier', 'live Grandfathered → Grandfathered: "Already on this tier" as today', r.body);
    r = await change('livegf', T.starter);
    assert(r.status === 200, 'live Grandfathered → Starter: still works');
    r = await change('lapsed', T.gf);
    assert(r.status === 400 && /not active/.test(r.body.error), 'canceled row: "subscription is not active" as today', r.body);
    r = await change('newv', T.growth);
    assert(r.status === 404 && r.body.error === 'No active subscription found', 'no subscription row → 404 as today', r.body);
    r = await change('pro2', T.waived);
    assert(r.status === 404 && /not configured/.test(r.body.error), 'waived (price-less) → 404 as today (guard not involved)', r.body);

    console.log('\nPOST /api/vendor/subscription/preview-change (session auth)');
    const login = await call('POST', '/api/auth/login', { body: { email: `${id('pro2')}@tp.test`, password: PASSWORD } });
    const cookie = (login.setCookie ?? '').split(',').map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
    assert(login.status === 200 && cookie.length > 0, 'logged in with a session cookie', login.status);
    const preview = (newTierId: string, grant?: unknown) => call('POST', PREVIEW, { cookie, body: grant === undefined ? { newTierId } : { newTierId, grant } });
    r = await preview(T.gf);
    assert(refusedFlat(r), 'Pro payer → Grandfathered: 403 { error, code }', r.body);
    r = await preview(T.gf, mint('other', T.gf));
    assert(refusedFlat(r), "another business's grant → 403", r.body);
    r = await preview(T.gf, mint('pro2', T.gf));
    assert(r.status === 200 && r.body.newTier?.id === T.gf, 'matching grant → preview works (200)', r.body);
    r = await preview(T.pro);
    assert(r.status === 200 && r.body.newTier?.id === T.pro, 'a visible plan → preview works', r.body);

    console.log('\nNo token in responses or the server log');
    const all = [r.text].join('');
    assert([...secrets].every((s) => !all.includes(s)), 'the last response holds no grant');
    if (LOG_FILE) {
      const log = readFileSync(LOG_FILE, 'utf8');
      assert(log.length > 0 && [...secrets].every((s) => !log.includes(s)), `none of ${secrets.size} grant tokens appears in the ${log.length}-byte server log`);
      assert(!/eyJidXNpbmVzc0lk/.test(log), 'no grant-shaped string (base64 payload) in the server log at all');
    } else {
      console.log('  ⏭  set TIER_TEST_SERVER_LOG to scan the server log');
    }
  } finally {
    const like = `${P}%`;
    await q(`DELETE FROM vendor_subscriptions WHERE business_id LIKE $1`, [like]);
    await q(`DELETE FROM businesses WHERE id LIKE $1`, [like]);
    await q(`DELETE FROM users WHERE id LIKE $1`, [like]);
    await db.end();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
