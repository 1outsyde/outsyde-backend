/**
 * Google signup + admin email (2026-10-19), end to end against a LOCAL server + scratch DB (never production).
 *
 *   GAS_TEST_BASE_URL=http://127.0.0.1:5062 GAS_TEST_PG_URL=postgresql://...@127.0.0.1:5432/outsyde \
 *   JWT_SECRET=<same as the server> npx tsx server/googleAdminSignup.http.test.ts
 *
 * Rule: POST /api/auth/oauth/complete-signup trusts googleSub + email from the body, so admin is granted
 * ONLY with a googleSignupToken issued by /api/auth/mobile/google or the Google callback for that exact
 * googleSub + email. No token = older app builds: signup still works, never admin. Bad token = 401.
 * isOAuthUser + googleSub are saved in that one route (createUser ignores both, R31).
 *
 * Uses the real allowlisted admin email on the LOCAL scratch DB only; refuses if it already exists there.
 * Uses 8 of the 20 complete-signup calls per 15 min (authRateLimiter); restart the server between runs.
 *
 * Mutation checks: making isAdminEmail ignore hasGoogleProof must turn section 2 red; dropping the
 * 401 for a bad proof must turn section 3 red; dropping isOAuthUser from the updateUser must turn 4 red.
 */
import jwt from "jsonwebtoken";

const BASE = process.env.GAS_TEST_BASE_URL;
const PG_URL = process.env.GAS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

(async () => {
  // ── 1. proof helpers (no server needed) ─────────────────────────────
  console.log("1. proof helpers");
  const { generateGoogleSignupProof, isValidGoogleSignupProof, verifyAccessToken, generateAccessToken } = await import("./auth");
  const proof = generateGoogleSignupProof("sub-123", "Someone@Example.com");
  assert(isValidGoogleSignupProof(proof, "sub-123", "someone@example.com"), "valid proof, email case-insensitive");
  assert(isValidGoogleSignupProof(proof, "sub-123", " SOMEONE@example.com "), "valid proof, email trimmed");
  assert(!isValidGoogleSignupProof(proof, "sub-999", "someone@example.com"), "other googleSub refused");
  assert(!isValidGoogleSignupProof(proof, "sub-123", "info@goutsyde.com"), "other email refused");
  assert(!isValidGoogleSignupProof(undefined, "sub-123", "someone@example.com"), "missing proof refused");
  assert(!isValidGoogleSignupProof(proof + "x", "sub-123", "someone@example.com"), "tampered proof refused");
  assert(verifyAccessToken(proof) === null, "proof is not an access token");
  const access = generateAccessToken({ userId: "u1", isVendor: false, isAdmin: true });
  assert(!isValidGoogleSignupProof(access, "sub-123", "someone@example.com"), "access token is not a proof");
  const secret = (process.env.JWT_SECRET || process.env.SESSION_SECRET) + "-google-signup";
  const expired = jwt.sign({ googleSub: "sub-123", email: "someone@example.com" }, secret, { expiresIn: -10, audience: "outsyde-google-signup" });
  assert(!isValidGoogleSignupProof(expired, "sub-123", "someone@example.com"), "expired proof refused");
  const noAud = jwt.sign({ googleSub: "sub-123", email: "someone@example.com" }, secret, { expiresIn: 60 });
  assert(!isValidGoogleSignupProof(noAud, "sub-123", "someone@example.com"), "proof without audience refused");

  if (!BASE) {
    console.log(`\n⏭  HTTP part skipped: set GAS_TEST_BASE_URL + GAS_TEST_PG_URL. ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) {
    throw new Error("refusing to run: base URL and database must both be local scratch instances");
  }
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const ADMIN_EMAIL = "info@goutsyde.com";
  if ((await q("SELECT 1 FROM users WHERE lower(email) = $1", [ADMIN_EMAIL])).length) {
    throw new Error(`refusing to run: ${ADMIN_EMAIL} already exists in this scratch DB`);
  }

  const P = `gas${Date.now().toString(36)}`;
  const created: string[] = [];
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  };
  const signup = (googleSub: string, email: string, username: string, extra: Record<string, unknown> = {}) =>
    call("/api/auth/oauth/complete-signup", { googleSub, email, username, firstName: "Test", lastName: "Person", ...extra });
  const row = async (email: string) =>
    (await q("SELECT id, is_admin, is_oauth_user, google_sub FROM users WHERE lower(email) = lower($1)", [email]))[0];
  const drop = async (id?: string) => {
    if (!id) return;
    await q("DELETE FROM refresh_tokens WHERE user_id = $1", [id]).catch(() => {});
    // newConsumerSignup notifies admins: the admin made in section 4 gets rows from section 5
    await q("DELETE FROM notifications WHERE user_id = $1", [id]).catch(() => {});
    await q("DELETE FROM users WHERE id = $1", [id]);
  };

  try {
    // ── 2. admin email WITHOUT a proof: account made, never admin (the hole the handoff fix would open)
    console.log("2. admin email, no proof (old builds / forged body)");
    let r = await signup(`${P}-a`, ADMIN_EMAIL, `${P}a`);
    let u = await row(ADMIN_EMAIL);
    assert(r.status === 200, "signup still works without a proof", r);
    assert(u && u.is_admin === false, "not admin", u);
    assert(r.json?.user?.isAdmin !== true, "response not admin", r.json?.user);
    assert(u && u.is_oauth_user === true && u.google_sub === `${P}-a`, "isOAuthUser + googleSub saved", u);
    const forged = r.json?.accessToken ? verifyAccessToken(r.json.accessToken) : null;
    assert(!!forged && forged.isAdmin === false, "issued token isAdmin false", forged);
    const adminTry = await call("/api/admin/users", null, { Authorization: `Bearer ${r.json?.accessToken}` }, "GET");
    assert(adminTry.status === 403, "admin route refused", adminTry.status);
    await drop(u?.id);

    // ── 3. bad proofs: refused, nothing created
    console.log("3. bad proofs");
    r = await signup(`${P}-b`, ADMIN_EMAIL, `${P}b`, { googleSignupToken: "garbage" });
    assert(r.status === 401, "garbage proof → 401", r);
    assert(!(await row(ADMIN_EMAIL)), "no user created");
    // attacker's own real Google proof, but claiming the admin email
    const ownProof = generateGoogleSignupProof(`${P}-c`, `${P}-attacker@example.com`);
    r = await signup(`${P}-c`, ADMIN_EMAIL, `${P}c`, { googleSignupToken: ownProof });
    assert(r.status === 401, "proof for another email → 401", r);
    assert(!(await row(ADMIN_EMAIL)), "no user created");
    // proof for the admin email but someone else's googleSub
    const subProof = generateGoogleSignupProof(`${P}-real`, ADMIN_EMAIL);
    r = await signup(`${P}-d`, ADMIN_EMAIL, `${P}d`, { googleSignupToken: subProof });
    assert(r.status === 401, "proof for another googleSub → 401", r);
    assert(!(await row(ADMIN_EMAIL)), "no user created");

    // ── 4. admin email WITH a matching proof: admin
    console.log("4. admin email + matching proof");
    const good = generateGoogleSignupProof(`${P}-e`, ADMIN_EMAIL);
    r = await signup(`${P}-e`, "Info@Goutsyde.com", `${P}e`, { googleSignupToken: good });
    u = await row(ADMIN_EMAIL);
    if (u) created.push(u.id);
    assert(r.status === 200, "signup ok", r);
    assert(u && u.is_admin === true, "is_admin saved", u);
    assert(u && u.is_oauth_user === true && u.google_sub === `${P}-e`, "isOAuthUser + googleSub saved", u);
    assert(r.json?.user?.isAdmin === true, "response user isAdmin", r.json?.user?.isAdmin);
    const tok = r.json?.accessToken ? verifyAccessToken(r.json.accessToken) : null;
    assert(!!tok && tok.isAdmin === true, "issued token isAdmin true", tok);
    const adminOk = await call("/api/admin/users", null, { Authorization: `Bearer ${r.json?.accessToken}` }, "GET");
    assert(adminOk.status === 200, "admin route allowed (requireAdmin: flag + allowlisted email)", adminOk.status);
    const proofAsBearer = await call("/api/admin/users", null, { Authorization: `Bearer ${good}` }, "GET");
    assert(proofAsBearer.status === 401 || proofAsBearer.status === 403, "proof as Bearer refused", proofAsBearer.status);

    // ── 5. non-admin email + proof: normal account
    console.log("5. normal email + proof");
    const email5 = `${P}-n@example.com`;
    r = await signup(`${P}-f`, email5, `${P}f`, { googleSignupToken: generateGoogleSignupProof(`${P}-f`, email5) });
    u = await row(email5);
    if (u) created.push(u.id);
    assert(r.status === 200, "signup ok", r);
    assert(u && u.is_admin === false && u.is_oauth_user === true, "not admin, isOAuthUser saved", u);
    // the Google-only login message now fires (it reads isOAuthUser || googleSub)
    const login = await call("/api/auth/login", { email: email5, password: "whatever123" });
    assert(login.status === 401 && /Google/.test(login.json?.message || ""), "password login says use Google", login);
  } finally {
    for (const id of created) await drop(id);
    const left = await row(ADMIN_EMAIL);
    if (left) await drop(left.id);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
