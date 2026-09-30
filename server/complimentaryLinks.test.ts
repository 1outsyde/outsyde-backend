/**
 * Free-plan claim-link tests — run with: npx tsx server/complimentaryLinks.test.ts
 *
 * Pure logic runs everywhere (no production database, no Stripe; the DATABASE_URL set below is
 * never dialled). The redeem-guard section needs a LOCAL scratch Postgres and is skipped unless
 * COMPLIMENTARY_TEST_PG_URL points at localhost — it refuses any other host, so it can never run
 * against Neon. It builds its own tables in a throwaway schema and applies migrations/037 + 038.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://golden:golden@127.0.0.1:1/never_dialled';

import { readFileSync } from 'fs';
import { join } from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import express from 'express';
import {
  ADMIN_LIST_DEFAULT_LIMIT,
  ADMIN_LIST_MAX_LIMIT,
  PERMANENT_EXPIRY_ISO,
  buildAdminSubscriptionSummary,
  clampAdminListLimit,
  complimentaryGrantSchema,
  complimentaryLinkBodySchema,
  isPaidRowLive,
  isoOrNull,
} from './complimentary';
import { TOKEN_RE, generate, hash } from './utils/complimentaryLinkToken';
import { COMPLIMENTARY_LINK_CREATE_PATH, errorLogArgs, loggedResponseBody } from './utils/requestLogging';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const dialect = new PgDialect();

// Golden: runGrantStatement's SQL + params, rendered through PgDialect on origin/main BEFORE the
// shared-fragment refactor (4baa576), whitespace-normalised.
const GOLDEN_GRANT_SQL = "WITH prev AS ( SELECT * FROM vendor_subscriptions WHERE business_id = $1::varchar ), up AS ( INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, status, current_period_start, current_period_end, current_quarter_start, current_quarter_end, stripe_subscription_id, stripe_customer_id, created_at, updated_at) VALUES ($2::varchar, $3::varchar, $4::varchar, 'active', now() AT TIME ZONE 'UTC', ($5::timestamptz AT TIME ZONE 'UTC'), NULL, NULL, NULL, NULL, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') ON CONFLICT (business_id) DO UPDATE SET vendor_id = EXCLUDED.vendor_id, tier_id = EXCLUDED.tier_id, status = 'active', current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end, current_quarter_start = NULL, current_quarter_end = NULL, stripe_subscription_id = NULL, stripe_customer_id = NULL, updated_at = EXCLUDED.updated_at WHERE vendor_subscriptions.stripe_subscription_id IS NULL OR (vendor_subscriptions.status IN ('canceled','incomplete_expired') AND (vendor_subscriptions.current_period_end IS NULL OR vendor_subscriptions.current_period_end < (now() AT TIME ZONE 'UTC'))) RETURNING * ), biz AS ( UPDATE businesses SET subscription_active = true WHERE id IN (SELECT business_id FROM up) RETURNING id ), aud AS ( INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata, ip_address, user_agent) SELECT $6::text, 'admin', $7::text, 'vendor_subscription', up.id, (SELECT to_jsonb(prev) FROM prev LIMIT 1), to_jsonb(up), jsonb_build_object('businessId', up.business_id, 'expiresAt', up.current_period_end, 'permanent', $8::boolean, 'replacedStripeSubscriptionId', (SELECT stripe_subscription_id FROM prev LIMIT 1), 'replacedStripeCustomerId', (SELECT stripe_customer_id FROM prev LIMIT 1)), $9::text, $10::text FROM up RETURNING id ) SELECT up.*, (SELECT count(*) FROM biz) AS biz_updated, (SELECT count(*) FROM aud) AS aud_written FROM up";
const GOLDEN_GRANT_PARAMS_DATED = ["B", "O", "B", "T", "2026-12-31T23:59:59-05:00", "A", "complimentary_subscription.grant", false, "1.2.3.4", "ua"];
const GOLDEN_GRANT_PARAMS_PERMANENT = ["B", "O", "B", "T", "2099-01-01T00:00:00.000Z", "A", "complimentary_subscription.extend", true, null, null];

(async () => {
  const svc = await import('./services/complimentarySubscription');

  // ── 1. token util ────────────────────────────────────────────────────────
  console.log('\nTest 1: claim-link token util');
  const tokens = Array.from({ length: 200 }, () => generate());
  assert(tokens.every((t) => t.length === 43), 'generate() is 43 characters (32 bytes, base64url)');
  assert(tokens.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t) && TOKEN_RE.test(t)), 'charset is base64url only (no ".", "+", "/", "=")');
  assert(new Set(tokens).size === tokens.length, '200 generated tokens are all unique');
  assert(tokens.every((t) => Buffer.from(t, 'base64url').length === 32), 'each token decodes to 32 random bytes (256 bits)');
  const h = hash(tokens[0]);
  assert(/^[0-9a-f]{64}$/.test(h), 'hash() is 64 lowercase hex chars (sha256)');
  assert(hash(tokens[0]) === h && hash(tokens[1]) !== h, 'hash() is deterministic and token-specific');
  assert(h !== tokens[0] && !h.includes(tokens[0]), 'the hash does not contain the token');
  assert(!TOKEN_RE.test('') && !TOKEN_RE.test(tokens[0] + 'x') && !TOKEN_RE.test(tokens[0].slice(1)) && !TOKEN_RE.test('a.b'), 'TOKEN_RE rejects wrong length and "."');
  assert(!TOKEN_RE.test('eyJidXNpbmVzc0lkIjoiYSJ9.c2ln'), 'a grandfathered-style signed token (has ".") is never a valid claim token');

  // ── 2. golden grant SQL ──────────────────────────────────────────────────
  console.log('\nTest 2: runGrantStatement SQL is unchanged by the shared-fragment refactor');
  const base = { businessId: 'B', ownerId: 'O', tierId: 'T', actorId: 'A' };
  const dated = dialect.sqlToQuery(svc.buildGrantStatement({
    ...base, expiresAtIso: '2026-12-31T23:59:59-05:00', permanent: false,
    action: 'complimentary_subscription.grant', ip: '1.2.3.4', userAgent: 'ua',
  }));
  const permanent = dialect.sqlToQuery(svc.buildGrantStatement({
    ...base, expiresAtIso: PERMANENT_EXPIRY_ISO, permanent: true,
    action: 'complimentary_subscription.extend', ip: null, userAgent: null,
  }));
  assert(norm(dated.sql) === GOLDEN_GRANT_SQL, 'grant SQL (dated) equals the pre-refactor render after whitespace normalisation');
  assert(norm(permanent.sql) === GOLDEN_GRANT_SQL, 'grant SQL (permanent/extend) equals the pre-refactor render');
  assert(JSON.stringify(dated.params) === JSON.stringify(GOLDEN_GRANT_PARAMS_DATED), 'grant params (dated) equal the pre-refactor params, same order');
  assert(JSON.stringify(permanent.params) === JSON.stringify(GOLDEN_GRANT_PARAMS_PERMANENT), 'grant params (permanent) equal the pre-refactor params');

  // ── 3. redeem statement shape ────────────────────────────────────────────
  console.log('\nTest 3: redeem statement');
  const tok = generate();
  const tokHash = hash(tok);
  const redeem = dialect.sqlToQuery(svc.buildRedeemStatement({
    tokenHash: tokHash, userId: 'U', tierId: 'T', ip: '1.2.3.4', userAgent: 'ua',
  }));
  const redeemSql = norm(redeem.sql);
  const upsertTail = GOLDEN_GRANT_SQL.slice(GOLDEN_GRANT_SQL.indexOf('ON CONFLICT'), GOLDEN_GRANT_SQL.indexOf(' RETURNING *'));
  assert(upsertTail.includes('WHERE vendor_subscriptions.stripe_subscription_id IS NULL'), 'sanity: extracted the upsert tail from the golden grant SQL');
  assert(redeemSql.includes(upsertTail), 'redeem uses the SAME ON CONFLICT … WHERE text as the grant statement (no drift)');
  assert(/^WITH link AS \( UPDATE complimentary_grant_links l SET redeemed_at/.test(redeemSql), 'the link CTE is first and is the only writer of the link row');
  for (const guard of [
    'l.redeemed_at IS NULL', 'l.revoked_at IS NULL', 'l.link_expires_at > (now() AT TIME ZONE \'UTC\')',
    'l.plan_expires_at IS NULL OR l.plan_expires_at > (now() AT TIME ZONE \'UTC\')',
    'b.owner_id = $', 'NOT EXISTS ( SELECT 1 FROM vendor_subscriptions vs',
  ]) {
    assert(redeemSql.includes(guard), `link CTE guard present: ${guard}`);
  }
  assert(redeemSql.includes("'vendor', 'complimentary_subscription.redeem'"), "audit row is actor_type 'vendor', action complimentary_subscription.redeem");
  for (const key of ["'businessId'", "'linkId'", "'createdBy'", "'expiresAt'", "'permanent'", "'replacedStripeSubscriptionId'", "'replacedStripeCustomerId'"]) {
    assert(redeemSql.includes(key), `audit metadata carries ${key}`);
  }
  assert(!redeem.params.includes(tok), 'the raw token never reaches the statement');
  assert(redeem.params.includes(tokHash), 'only the sha256 hash is a parameter');
  assert(!/token_hash/.test(redeemSql.slice(redeemSql.indexOf('aud AS'))), 'the audit CTE never references token_hash');
  assert(!redeemSql.includes('db.transaction') && !redeemSql.includes('BEGIN'), 'one statement: no transaction');

  // ── 4. limit clamp ───────────────────────────────────────────────────────
  console.log('\nTest 4: GET /api/admin/businesses limit clamp');
  assert(clampAdminListLimit(undefined) === ADMIN_LIST_DEFAULT_LIMIT && ADMIN_LIST_DEFAULT_LIMIT === 50, 'missing → 50');
  assert(clampAdminListLimit('abc') === 50 && clampAdminListLimit('') === 50 && clampAdminListLimit(null) === 50, 'NaN → 50');
  assert(clampAdminListLimit('100') === 100 && clampAdminListLimit('1') === 1, 'in range passes through (the web BFF sends 100)');
  assert(clampAdminListLimit('0') === 1 && clampAdminListLimit('-5') === 1, '0 and negatives → 1');
  assert(clampAdminListLimit('100000') === 200 && ADMIN_LIST_MAX_LIMIT === 200, 'huge → 200');
  assert(clampAdminListLimit('12.9') === 12, 'parseInt semantics are preserved');

  // ── 5. B6 row shape ──────────────────────────────────────────────────────
  console.log('\nTest 5: admin list per-row subscription shape');
  const KEYS = ['currentPeriodEnd', 'hasStripeSubscription', 'isComplimentary', 'status', 'tierDisplayName', 'tierName'];
  const lana = buildAdminSubscriptionSummary({ tierName: 'waived', tierDisplayName: 'Waived', priceInCents: 0, stripePriceId: null, status: 'active', currentPeriodEnd: '2099-01-01 00:00:00', stripeSubscriptionId: null });
  assert(JSON.stringify(Object.keys(lana).sort()) === JSON.stringify(KEYS), 'exactly the six documented keys');
  assert(lana.isComplimentary === true && lana.hasStripeSubscription === false && lana.currentPeriodEnd === '2099-01-01T00:00:00.000Z', 'Lana: complimentary, no Stripe, ISO end');
  const nails = buildAdminSubscriptionSummary({ tierName: 'pro', tierDisplayName: 'Pro', priceInCents: 9900, stripePriceId: 'price_x', status: 'active', currentPeriodEnd: new Date('2026-07-31T23:59:59Z'), stripeSubscriptionId: 'sub_1' });
  assert(nails.isComplimentary === false && nails.hasStripeSubscription === true && nails.currentPeriodEnd === '2026-07-31T23:59:59.000Z', 'Nails: paid, Stripe, Date → ISO');
  const gf = buildAdminSubscriptionSummary({ tierName: 'grandfathered', tierDisplayName: 'Grandfathered', priceInCents: 4099, stripePriceId: 'price_y', status: 'active', currentPeriodEnd: null, stripeSubscriptionId: 'sub_2' });
  assert(gf.currentPeriodEnd === null && gf.isComplimentary === false, 'null period end stays null; priced tier is never complimentary');
  const noPrice = buildAdminSubscriptionSummary({ tierName: 'x', tierDisplayName: 'X', priceInCents: 0, stripePriceId: 'price_z', status: null, currentPeriodEnd: null, stripeSubscriptionId: null });
  assert(noPrice.isComplimentary === false && noPrice.status === null, 'price 0 WITH a Stripe price is not complimentary; null status preserved');
  assert(isoOrNull(null) === null && isoOrNull('2026-10-07 18:00:00') === '2026-10-07T18:00:00.000Z', 'isoOrNull handles null and Postgres text timestamps');

  // ── 6. request logger ────────────────────────────────────────────────────
  console.log('\nTest 6: request logger redaction');
  const createBody = { linkExpiresAt: '2026-10-07T18:00:00.000Z', url: `https://www.goutsyde.com/subscribe/free/${tok}` };
  const redacted = loggedResponseBody('POST', COMPLIMENTARY_LINK_CREATE_PATH, createBody) as Record<string, unknown>;
  assert(redacted.url === '[redacted]' && redacted.linkExpiresAt === createBody.linkExpiresAt, 'POST /api/admin/subscription/complimentary-link: url → "[redacted]"');
  assert(!JSON.stringify(redacted).includes(tok), 'the token is not in the logged JSON');
  assert(createBody.url.includes(tok), 'the response object itself is not mutated (shallow copy)');
  const others: Array<[string, string, Record<string, any> | undefined]> = [
    ['GET', COMPLIMENTARY_LINK_CREATE_PATH, createBody],
    ['POST', '/api/admin/subscription/grant-link', { grantUrl: 'https://x/subscribe/grant/abc.def', expiresAt: 'z' }],
    ['POST', '/api/admin/subscription/complimentary-link/abc', createBody],
    ['POST', '/api/admin/subscription/complimentary-links', createBody],
    ['POST', '/api/subscription/complimentary-link/redeem', { subscription: { id: '1' }, connectReady: true }],
    ['GET', '/api/admin/businesses', { businesses: [], total: 0 }],
    ['POST', COMPLIMENTARY_LINK_CREATE_PATH, { error: 'Business not found' }],
    ['POST', COMPLIMENTARY_LINK_CREATE_PATH, undefined],
  ];
  assert(others.every(([m, p, b]) => loggedResponseBody(m, p, b) === b), 'every other method/path/body returns the SAME object → byte-identical log line');
  const before = `POST ${COMPLIMENTARY_LINK_CREATE_PATH} 200 in 12ms :: ${JSON.stringify(createBody)}`;
  const after = `POST ${COMPLIMENTARY_LINK_CREATE_PATH} 200 in 12ms :: ${JSON.stringify(redacted)}`;
  const cut = (l: string) => (l.length > 80 ? l.slice(0, 79) + '…' : l);
  assert(!cut(before).includes(tok) && !cut(after).includes(tok), 'old and new 80-char log lines both omit the token');

  // ── 7. malformed JSON body → fixed log line ──────────────────────────────
  console.log('\nTest 7: global error handler logs no body for entity.parse.failed');
  const app = express();
  app.use(express.json());
  app.post('/x', (_req, res) => res.json({ ok: true }));
  const logged: unknown[][] = [];
  app.use((err: any, _req: any, res: any, _next: any) => {
    logged.push(errorLogArgs(err));
    res.status(err.status || 500).json({ ok: false });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  const bad = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"token":${tok}}` });
  server.close();
  assert(bad.status === 400 && logged.length === 1, 'malformed JSON still returns 400');
  assert(logged[0].length === 1 && logged[0][0] === '[ERROR] Malformed JSON body', 'logged exactly "[ERROR] Malformed JSON body" (no message, no stack)');
  assert(!JSON.stringify(logged).includes(tok.slice(0, 12)), 'no fragment of the body appears in what is logged');
  const plain = errorLogArgs(Object.assign(new Error('boom'), { stack: 'STACK' }));
  assert(plain.length === 2 && plain[0] === '[ERROR] boom' && plain[1] === 'STACK', 'every other error is logged exactly as before (message, stack)');
  const unnamed = errorLogArgs({});
  assert(unnamed[0] === '[ERROR] Unknown error' && unnamed[1] === '', 'errors without a message keep the old fallback text');

  // ── 8. static messages ───────────────────────────────────────────────────
  console.log('\nTest 8: redeem/create/list/revoke messages are static');
  const links = await import('./services/complimentaryLinks');
  const messages = [...Object.values(links.LINK_MESSAGES), svc.PAID_ROW_LIVE_MESSAGE];
  assert(messages.every((m) => typeof m === 'string' && !/[A-Za-z0-9_-]{30,}/.test(m)), 'no message contains a token-shaped string');
  const src = readFileSync(join(import.meta.dirname, 'services', 'complimentaryLinks.ts'), 'utf8').split('\n');
  const interpolatedResponses = src.filter((l) => /(error:|coded\(|result\()/.test(l) && l.includes('${') && !l.includes('url:'));
  assert(interpolatedResponses.length === 0, 'no response line interpolates a variable (only the create response url does)');
  const errorLogs = src.filter((l) => l.includes('console.error('));
  assert(errorLogs.length > 0 && errorLogs.every((l) => l.includes('errorLabel(error)') && !/token|hash|\.message/i.test(l)), 'every console.error logs only the error NAME via errorLabel()');
  const urlLines = src.filter((l) => l.includes('/subscribe/free/'));
  assert(urlLines.length === 1 && /url:/.test(urlLines[0]), 'the token appears in exactly one place: the create response url');

  // ── 9. paid-row mirror ───────────────────────────────────────────────────
  console.log('\nTest 9: isPaidRowLive mirrors the upsert conflict WHERE');
  const NOW = new Date('2026-09-30T12:00:00Z');
  const PAST = new Date('2026-09-01T00:00:00Z');
  const FUT = new Date('2026-12-01T00:00:00Z');
  assert(!isPaidRowLive(null, NOW) && !isPaidRowLive({ stripeSubscriptionId: null, status: 'active', currentPeriodEnd: FUT }, NOW), 'no row / no Stripe id → not a paid row');
  assert(isPaidRowLive({ stripeSubscriptionId: 's', status: 'active', currentPeriodEnd: PAST }, NOW), 'active Stripe row is live even with a stale period end');
  assert(isPaidRowLive({ stripeSubscriptionId: 's', status: 'past_due', currentPeriodEnd: PAST }, NOW), 'past_due is live');
  assert(isPaidRowLive({ stripeSubscriptionId: 's', status: null, currentPeriodEnd: PAST }, NOW), 'NULL status counts as live (same as the conflict WHERE)');
  assert(isPaidRowLive({ stripeSubscriptionId: 's', status: 'canceled', currentPeriodEnd: FUT }, NOW), 'canceled but paid through a future date is live');
  assert(!isPaidRowLive({ stripeSubscriptionId: 's', status: 'canceled', currentPeriodEnd: PAST }, NOW), 'canceled with an ended period converts');
  assert(!isPaidRowLive({ stripeSubscriptionId: 's', status: 'incomplete_expired', currentPeriodEnd: null }, NOW), 'incomplete_expired with no period converts');

  // ── 10. request schemas ──────────────────────────────────────────────────
  console.log('\nTest 10: request bodies');
  const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;
  assert(ok(complimentaryGrantSchema, { expiresAt: '2026-12-31T23:59:59-05:00' }) && ok(complimentaryGrantSchema, { permanent: true }), 'grant schema: expiresAt-with-offset or permanent (unchanged)');
  assert(!ok(complimentaryGrantSchema, { expiresAt: '2026-12-31T23:59:59' }) && !ok(complimentaryGrantSchema, { permanent: false }) && !ok(complimentaryGrantSchema, { permanent: true, tierId: 'x' }) && !ok(complimentaryGrantSchema, { businessId: 'b', permanent: true }), 'grant schema still rejects no-offset, permanent:false, and extra keys (incl. businessId)');
  assert(ok(complimentaryLinkBodySchema, { businessId: 'b', expiresAt: '2026-12-31T23:59:59-05:00' }) && ok(complimentaryLinkBodySchema, { businessId: 'b', permanent: true }), 'link schema: businessId + (expiresAt | permanent)');
  assert(!ok(complimentaryLinkBodySchema, { permanent: true }) && !ok(complimentaryLinkBodySchema, { businessId: '', permanent: true }) && !ok(complimentaryLinkBodySchema, { businessId: 'b' }) && !ok(complimentaryLinkBodySchema, { businessId: 'b', permanent: true, expiresAt: '2026-12-31T23:59:59Z' }) && !ok(complimentaryLinkBodySchema, { businessId: 'b', permanent: true, tierId: 'x' }), 'link schema rejects missing/empty businessId, neither/both expiry forms, and extra keys');

  await runDatabaseGuards(svc);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

// ── 11. redeem guards on a LOCAL scratch Postgres ──────────────────────────
// Never Neon: skipped unless COMPLIMENTARY_TEST_PG_URL is set, and refused unless the host is local.
async function runDatabaseGuards(svc: typeof import('./services/complimentarySubscription')) {
  const url = process.env.COMPLIMENTARY_TEST_PG_URL;
  console.log('\nTest 11: redeem guards on a local scratch Postgres');
  if (!url) {
    console.log('  ⏭  skipped (set COMPLIMENTARY_TEST_PG_URL=postgresql://…@localhost/… to run)');
    return;
  }
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`refusing to run DB guards against non-local host "${host}"`);
  }

  const pgMod: any = await import('pg');
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v); // timestamp → text, no timezone guessing
  const schema = `cl_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  const splitStatements = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
  const migration = (f: string) => readFileSync(join(import.meta.dirname, '..', 'migrations', f), 'utf8');

  try {
    await q(`CREATE TABLE users (id varchar(36) PRIMARY KEY)`);
    await q(`CREATE TABLE businesses (id varchar(36) PRIMARY KEY, owner_id varchar(36), subscription_active boolean DEFAULT false)`);
    await q(`CREATE TABLE vendor_subscriptions (
      id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(), vendor_id varchar(36) NOT NULL, business_id varchar(36) NOT NULL,
      tier_id varchar(36) NOT NULL, stripe_subscription_id text, stripe_customer_id text, status text DEFAULT 'active',
      current_period_start timestamp, current_period_end timestamp, current_quarter_start timestamp, current_quarter_end timestamp,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE audit_logs (
      id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(), actor_id varchar(36), actor_type text NOT NULL, action text NOT NULL,
      target_type text NOT NULL, target_id varchar(36) NOT NULL, before_state jsonb, after_state jsonb, metadata jsonb,
      ip_address text, user_agent text, created_at timestamp NOT NULL DEFAULT now())`);
    for (const f of ['037_vendor_subscriptions_business_unique.sql', '038_complimentary_grant_links.sql']) {
      for (const stmt of splitStatements(migration(f))) await q(stmt);
    }
    assert(true, 'migrations 037 + 038 apply cleanly through the runner\'s statement splitter');

    await q(`INSERT INTO users (id) VALUES ('u1'), ('u2'), ('u3'), ('admin')`);
    let bizSeq = 0;
    async function seed(opts: {
      sub?: { stripe: string | null; status: string | null; end: string | null };
      link?: { plan: string | null; linkEnd?: string; revoked?: boolean; redeemed?: boolean };
    }) {
      const n = ++bizSeq;
      const biz = `b${n}`;
      const owner = `o${n}`;
      await q(`INSERT INTO users (id) VALUES ($1)`, [owner]);
      await q(`INSERT INTO businesses (id, owner_id) VALUES ($1, $2)`, [biz, owner]);
      if (opts.sub) {
        await q(
          `INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, stripe_subscription_id, stripe_customer_id, status, current_period_end)
           VALUES ($1, $2, 'tier-old', $3, $4, $5, $6)`,
          [owner, biz, opts.sub.stripe, opts.sub.stripe ? 'cus_x' : null, opts.sub.status, opts.sub.end],
        );
      }
      const token = generate();
      const tokenHash = hash(token);
      const l = opts.link ?? { plan: null };
      await q(
        `INSERT INTO complimentary_grant_links (token_hash, business_id, plan_expires_at, link_expires_at, created_by, revoked_at, redeemed_at, redeemed_by)
         VALUES ($1, $2, $3, COALESCE($4::timestamp, (now() AT TIME ZONE 'UTC') + interval '7 days'), 'admin',
                 CASE WHEN $5::boolean THEN (now() AT TIME ZONE 'UTC') END, CASE WHEN $6::boolean THEN (now() AT TIME ZONE 'UTC') END,
                 CASE WHEN $6::boolean THEN 'u3' END)`,
        [tokenHash, biz, l.plan, l.linkEnd ?? null, !!l.revoked, !!l.redeemed],
      );
      return { biz, owner, token, tokenHash };
    }
    const claim = async (client: { query: (t: string, p?: unknown[]) => Promise<any> }, userId: string, tokenHash: string) => {
      const r = dialect.sqlToQuery(svc.buildRedeemStatement({ tokenHash, userId, tierId: 'tier-waived', ip: '9.9.9.9', userAgent: 'test' }));
      return (await client.query(r.sql, r.params)).rows;
    };
    const linkRow = async (tokenHash: string) => (await q(`SELECT redeemed_at, redeemed_by, revoked_at FROM complimentary_grant_links WHERE token_hash = $1`, [tokenHash])).rows[0];
    const count = async (table: string, where = 'true') => Number((await q(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);

    // happy path: permanent
    let s = await seed({});
    let rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 1 && rows[0].status === 'active' && rows[0].current_period_end === '2099-01-01 00:00:00', 'owner claims a permanent link → active, ends 2099-01-01');
    assert(rows[0].vendor_id === s.owner && rows[0].tier_id === 'tier-waived' && rows[0].stripe_subscription_id === null, 'row is owned by the claimer on the complimentary tier with no Stripe ids');
    assert(Number(rows[0].biz_updated) === 1 && Number(rows[0].aud_written) === 1, 'one statement updated the business flag and wrote one audit row');
    assert((await q(`SELECT subscription_active FROM businesses WHERE id = $1`, [s.biz])).rows[0].subscription_active === true, 'businesses.subscription_active = true');
    let lr = await linkRow(s.tokenHash);
    assert(lr.redeemed_at !== null && lr.redeemed_by === s.owner, 'link is marked redeemed by the claimer');
    const audit = (await q(`SELECT * FROM audit_logs WHERE target_id = $1`, [rows[0].id])).rows;
    assert(audit.length === 1 && audit[0].actor_type === 'vendor' && audit[0].actor_id === s.owner && audit[0].action === 'complimentary_subscription.redeem', "audit: actor_type 'vendor', actor = claimer, action redeem");
    const meta = audit[0].metadata;
    assert(meta.businessId === s.biz && typeof meta.linkId === 'string' && meta.createdBy === 'admin' && meta.permanent === true, 'audit metadata: businessId, linkId, createdBy, permanent');
    assert(JSON.stringify(Object.keys(meta).sort()) === JSON.stringify(['businessId', 'createdBy', 'expiresAt', 'linkId', 'permanent', 'replacedStripeCustomerId', 'replacedStripeSubscriptionId']), 'audit metadata has exactly the documented keys');
    assert(!JSON.stringify(audit[0]).includes(s.token) && !JSON.stringify(audit[0]).includes(s.tokenHash), 'audit row contains neither the token nor its hash');
    assert(audit[0].ip_address === '9.9.9.9' && audit[0].user_agent === 'test', 'audit row records ip and user agent');

    // redeemed link → nothing
    rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 0 && (await count('audit_logs')) === 1, 'claiming an already-redeemed link → 0 rows, no second audit row');

    // dated plan
    s = await seed({ link: { plan: '2031-05-06 03:59:59' } });
    rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 1 && rows[0].current_period_end === '2031-05-06 03:59:59', 'dated link → the plan ends exactly at plan_expires_at');
    assert((await q(`SELECT metadata->>'permanent' AS p FROM audit_logs WHERE target_id = $1`, [rows[0].id])).rows[0].p === 'false', 'dated link → audit permanent=false');

    // concurrent double claim: A holds the link row lock, B runs the identical claim meanwhile
    s = await seed({});
    const a = await pool.connect();
    await a.query('BEGIN');
    const aRows = await claim(a, s.owner, s.tokenHash);
    const bPromise = claim(pool, s.owner, s.tokenHash);
    await new Promise((r) => setTimeout(r, 400));
    await a.query('COMMIT');
    a.release();
    const bRows = await bPromise;
    assert(aRows.length === 1 && bRows.length === 0, 'concurrent double-claim: exactly one claim returns a row');
    assert((await count('vendor_subscriptions', `business_id = '${s.biz}'`)) === 1 && (await count('audit_logs', `action = 'complimentary_subscription.redeem' AND metadata->>'businessId' = '${s.biz}'`)) === 1, 'concurrent double-claim: exactly one grant and one audit row');

    // wrong owner / no business
    s = await seed({});
    rows = await claim(pool, 'u1', s.tokenHash);
    lr = await linkRow(s.tokenHash);
    assert(rows.length === 0 && lr.redeemed_at === null && (await count('vendor_subscriptions', `business_id = '${s.biz}'`)) === 0, 'wrong owner → nothing granted, link stays unused');
    rows = await claim(pool, 'u3', s.tokenHash); // u3 exists but owns no business
    assert(rows.length === 0 && (await linkRow(s.tokenHash)).redeemed_at === null, 'caller with no business → nothing granted, link stays unused');
    rows = await claim(pool, s.owner, hash(generate()));
    assert(rows.length === 0, 'unknown token hash → 0 rows');

    // live paid rows leave the link unused
    const live: Array<[string, { stripe: string; status: string | null; end: string | null }]> = [
      ['active, period in the future', { stripe: 'sub_a', status: 'active', end: '2099-01-01 00:00:00' }],
      ['active with a stale period end', { stripe: 'sub_b', status: 'active', end: '2020-01-01 00:00:00' }],
      ['past_due', { stripe: 'sub_c', status: 'past_due', end: '2020-01-01 00:00:00' }],
      ['NULL status', { stripe: 'sub_d', status: null, end: null }],
      ['canceled but paid through a future date', { stripe: 'sub_e', status: 'canceled', end: '2099-01-01 00:00:00' }],
    ];
    for (const [label, sub] of live) {
      s = await seed({ sub });
      rows = await claim(pool, s.owner, s.tokenHash);
      const still = (await q(`SELECT tier_id, stripe_subscription_id FROM vendor_subscriptions WHERE business_id = $1`, [s.biz])).rows[0];
      assert(rows.length === 0 && (await linkRow(s.tokenHash)).redeemed_at === null && still.tier_id === 'tier-old' && still.stripe_subscription_id === sub.stripe,
        `live paid row (${label}) → refused, link stays UNUSED, paid row untouched`);
    }
    assert((await count('audit_logs', `action = 'complimentary_subscription.redeem'`)) === 3, 'refused claims wrote no audit rows (3 successful claims so far)');

    // canceled paid row with an ended period converts
    s = await seed({ sub: { stripe: 'sub_old', status: 'canceled', end: '2020-01-01 00:00:00' } });
    rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 1 && rows[0].stripe_subscription_id === null && rows[0].stripe_customer_id === null && rows[0].tier_id === 'tier-waived', 'canceled paid row with an ended period converts (Stripe ids cleared)');
    const conv = (await q(`SELECT metadata FROM audit_logs WHERE target_id = $1`, [rows[0].id])).rows[0].metadata;
    assert(conv.replacedStripeSubscriptionId === 'sub_old' && conv.replacedStripeCustomerId === 'cus_x', 'audit records the replaced Stripe ids');
    s = await seed({ sub: { stripe: null, status: 'canceled', end: '2020-01-01 00:00:00' } });
    rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 1, 'an ended complimentary row (no Stripe id) is re-granted');
    s = await seed({ sub: { stripe: null, status: 'active', end: '2031-01-01 00:00:00' } });
    rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 1 && rows[0].current_period_end === '2099-01-01 00:00:00', 'an active complimentary row is extended by a new link');

    // expired plan / expired link / revoked link
    s = await seed({ link: { plan: '2020-01-01 00:00:00' } });
    rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 0 && (await linkRow(s.tokenHash)).redeemed_at === null, 'expired plan → refused, link stays unused');
    s = await seed({ link: { plan: null, linkEnd: '2020-01-01 00:00:00' } });
    rows = await claim(pool, s.owner, s.tokenHash);
    assert(rows.length === 0 && (await linkRow(s.tokenHash)).redeemed_at === null, 'expired link → refused, link stays unused');
    s = await seed({ link: { plan: null, revoked: true } });
    rows = await claim(pool, s.owner, s.tokenHash);
    lr = await linkRow(s.tokenHash);
    assert(rows.length === 0 && lr.redeemed_at === null && lr.revoked_at !== null, 'revoked link → refused, stays revoked and unused');

    // foreign keys
    await q(`DELETE FROM users WHERE id = 'admin'`);
    assert((await count('complimentary_grant_links', 'created_by IS NULL')) > 0, 'deleting the creating admin sets created_by NULL (ON DELETE SET NULL)');
    await q(`DELETE FROM businesses WHERE id = 'b1'`);
    assert((await count('complimentary_grant_links', `business_id = 'b1'`)) === 0, 'deleting a business cascades to its links (ON DELETE CASCADE)');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
