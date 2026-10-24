/**
 * Business referral cash, HTTP side (referral Step 4): code at business signup, the referrer's list route.
 *
 * Run with: npx tsx server/businessReferral.http.test.ts
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (migration 072 applied).
 *   BREF_TEST_BASE_URL   e.g. http://localhost:5062 (must be localhost)
 *   BREF_TEST_PG_URL     the SAME scratch database (localhost only)
 *   JWT_SECRET           identical to the server's
 * Skips (exit 0) when BREF_TEST_BASE_URL is unset.
 */
import crypto from "crypto";

const BASE = process.env.BREF_TEST_BASE_URL;
const PG_URL = process.env.BREF_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u?: string) => !!u && ["localhost", "127.0.0.1"].includes(new URL(u).hostname);

(async () => {
  if (!BASE) { console.log("⏭  skipped: set BREF_TEST_BASE_URL"); process.exit(0); }
  if (!isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: base URL and database must both be local");
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const P = `br${Date.now().toString(36)}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(`${BASE}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  };
  const signup = (s: string, extra: Record<string, unknown> = {}) => call("POST", "/api/auth/vendor/signup", {
    email: `${P}-${s}@x.test`, password: "secret123", name: `Owner ${s}`, phone: "5165550101",
    businessName: `${P} ${s}`, businessCategory: "Beauty & Hair", offerType: "services", username: `${P}${s}`.slice(0, 30),
    acceptedSubscription: true, vendorAgreementAccepted: true, deferAdminNotification: true, ...extra,
  });

  const refId = crypto.randomUUID();
  const code = `B${P.toUpperCase()}`.slice(0, 12);
  await q(`INSERT INTO users (id, username, email, is_active, referral_code) VALUES ($1, $2, $3, true, $4)`, [refId, `${P}ref`, `${P}-ref@x.test`, code]);
  const tok = generateAccessToken({ userId: refId, isAdmin: false } as any);

  console.log("\nBusiness signup with a code");
  const a = await signup("a", { referralCode: code.toLowerCase() });
  assert(a.status === 200 && a.json?.referralApplied === true && !!a.json?.business?.id, "signup 200, referralApplied true", a.json?.referralApplied);
  const row = (await q(`SELECT status, referrer_user_id FROM business_referrals WHERE business_id = $1`, [a.json?.business?.id]))[0];
  assert(row?.status === "pending" && row.referrer_user_id === refId, "pending business referral to the referrer", row);
  const friendRows = await q(`SELECT count(*)::int n FROM referrals WHERE referred_user_id = $1`, [a.json?.user?.id]);
  assert(friendRows[0].n === 0, "no friend referral for a business signup");

  const b = await signup("b", { referralCode: "NOPE2345" });
  assert(b.status === 200 && b.json?.referralApplied === false, "unknown code: signup still 200, referralApplied false", b.status);
  const c = await signup("c", { referralCode: { evil: true } });
  assert(c.status === 200 && c.json?.referralApplied === false, "a non-text code never fails the signup", c.status);
  const d = await signup("d");
  assert(d.status === 200 && d.json?.referralApplied === false && typeof d.json?.message === "string", "signup without a code: same response plus referralApplied false", d.status);

  console.log("\nGET /api/referral/business");
  const list = await call("GET", "/api/referral/business", undefined, tok);
  assert(list.status === 200 && list.json?.rewardCents === 2500 && list.json?.referrals?.length === 1 && list.json.referrals[0].status === "pending" && list.json.totals?.invited === 1,
    "app token: the referred business, pending, $25 reward", list.json);
  const bad = await call("GET", "/api/referral/business", undefined, "not-a-token");
  assert(bad.status === 401 && bad.json?.code === "TOKEN_INVALID", "bad token answers TOKEN_INVALID", bad);
  const none = await call("GET", "/api/referral/business");
  assert(none.status === 401, "signed out: 401", none.status);

  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
