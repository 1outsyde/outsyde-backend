/**
 * Login and password reset limits (p4-loginlimit, 2026-10-28): unit + HTTP integration tests.
 *
 * Run with: npx tsx server/authLimits.http.test.ts
 *
 * The unit block (key functions) always runs. The HTTP block is SCRATCH ONLY: a backend booted on
 * localhost against a LOCAL scratch Postgres, with OUTSYDE_PROXY_KEY set:
 *   PS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   QS_TEST_PROXY_KEY  identical to the server's OUTSYDE_PROXY_KEY (32+ characters)
 * Restart the server between runs: limiter buckets live in memory.
 *
 * Rules under test:
 *   login (/api/auth/login + /api/auth/mobile/login): 10 failed tries per 15 min per account
 *     (email or username, any case), successes don't count; plus 100 failed tries per visitor.
 *   password reset (/api/auth/forgot-password[/send-code|/verify-code], /api/auth/reset-password):
 *     5 per 15 min per email; plus 30 per visitor. Separate from the login buckets.
 *
 * Mutation checks: key loginAccountKey on the network again → "guest 2 is not blocked" fails;
 * drop skipSuccessfulRequests → "successes don't count" fails.
 */
import http from "http";
import { ipKeyGenerator } from "express-rate-limit";
import { loginAccountKey, resetEmailKey, badAuthFields, LOGIN_LIMIT_MESSAGE } from "./authLimits";

const BASE = process.env.PS_TEST_BASE_URL;
const PG_URL = process.env.PS_TEST_PG_URL;
const KEY = process.env.QS_TEST_PROXY_KEY || "";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

function unitBlock() {
  console.log("\n=== key functions (unit) ===");
  const r = (body: unknown, ip = "10.1.2.3", headers: Record<string, string> = {}) => ({ body, ip, headers }) as any;
  assert(loginAccountKey(r({ email: "  Maya@Email.com " })) === "acct:maya@email.com", "email: trimmed, lowercased");
  assert(loginAccountKey(r({ identifier: "MAYA@email.com" })) === "acct:maya@email.com", "identifier email: same key as email");
  assert(loginAccountKey(r({ username: "MayaB" })) === "acct:mayab", "username: lowercased");
  assert(loginAccountKey(r({ identifier: "mayab" })) === "acct:mayab", "identifier username: same key as username");
  assert(loginAccountKey(r({ email: "a@b.co", username: "zed" })) === "acct:a@b.co", "email wins over username (same order as the handler)");
  assert(loginAccountKey(r({})) === `net:${ipKeyGenerator("10.1.2.3")}`, "no account given: keyed on the network");
  assert(loginAccountKey(r({ email: 42 })) === `net:${ipKeyGenerator("10.1.2.3")}`, "non string: keyed on the network");
  assert(loginAccountKey(r(undefined)) === `net:${ipKeyGenerator("10.1.2.3")}`, "no body: keyed on the network, never throws");
  assert(loginAccountKey(r({ email: "x".repeat(400) + "@a.co" })).length <= 5 + 254, "very long input is capped");
  assert(resetEmailKey(r({ email: " A@B.co " })) === "email:a@b.co", "reset: email trimmed, lowercased");
  assert(resetEmailKey(r({})) === `net:${ipKeyGenerator("10.1.2.3")}`, "reset without email: keyed on the network");
  assert(!/[\u2013\u2014]| - /.test(LOGIN_LIMIT_MESSAGE), "message has no dashes");
  assert(loginAccountKey(r({ username: "@MayaB" })) === "acct:mayab", "username with a leading @: same key as without (the handler strips it)");
  assert(loginAccountKey(r({ identifier: " @mayab " })) === "acct:mayab", "identifier with @ and spaces: same key");
  assert(loginAccountKey(r({ identifier: "maya@email.com" })) === "acct:maya@email.com", "an email identifier keeps its @");
  assert(badAuthFields({ email: ["victim@x.com"], password: "p" }, ["email", "username", "identifier", "password"]) === "email", "array email is rejected");
  assert(badAuthFields({ username: { a: 1 } }, ["email", "username"]) === "username", "object username is rejected");
  assert(badAuthFields({ email: "a@b.co", password: "p" }, ["email", "username", "identifier", "password"]) === null, "strings pass");
  assert(badAuthFields({ password: "p" }, ["email", "username"]) === null, "missing fields pass (the handler answers them)");
  assert(badAuthFields(undefined, ["email"]) === null, "no body passes");
}

type Res = { status: number; body: any };
function call(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)), ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
const viaSite = (visitor: string) => ({ "x-outsyde-proxy-key": KEY, "x-outsyde-client-ip": visitor, "X-Forwarded-For": "10.66.0.1" });
const direct = (ip: string) => ({ "X-Forwarded-For": ip });

async function httpBlock() {
  if (!BASE) { console.log("\n⏭  HTTP block skipped: set PS_TEST_BASE_URL + PS_TEST_PG_URL + QS_TEST_PROXY_KEY"); return; }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  if (KEY.length < 32) throw new Error("QS_TEST_PROXY_KEY must match the server's OUTSYDE_PROXY_KEY");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const { hashPassword } = await import("./auth");
  const P = `ll${Date.now().toString(36)}`;
  const email = (s: string) => `${P}-${s}@test.local`;
  const PASS = "rightpass1";
  const hash = await hashPassword(PASS);
  for (const s of ["g1", "g2", "g3", "g4", "web"]) {
    await q(`INSERT INTO users (id, email, name, first_name, username, password) VALUES (gen_random_uuid(), $1, $2, $2, $3, $4)`,
      [email(s), `Guest ${s}`, `${P}${s}`.slice(0, 20), hash]);
  }
  const ML = "/api/auth/mobile/login";

  console.log("\n=== Non string login fields are refused before any lookup ===");
  for (const path of [ML, "/api/auth/login"]) {
    for (const body of [{ email: [email("g4")], password: PASS }, { identifier: [email("g4")], password: PASS }, { username: [`${P}g4`.slice(0, 20)], password: PASS }, { email: email("g4"), password: [PASS] }]) {
      const rr = await call(path, body, direct("10.66.1.1"));
      assert(rr.status === 400 && rr.body?.error?.code === "INVALID_INPUT" && typeof rr.body?.message === "string", `${path} ${Object.keys(body).join("+")} with an odd type → 400 INVALID_INPUT`, rr);
    }
  }
  const ra = await call("/api/auth/forgot-password/send-code", { email: [email("g4")] }, direct("10.66.1.1"));
  assert(ra.status === 400 && ra.body?.error?.code === "INVALID_INPUT", "reset route: array email → 400", ra);

  try {
    console.log("\n=== Per account, through one site (everyone on goutsyde.com shares Vercel's address) ===");
    let st: number[] = [];
    for (let i = 0; i < 10; i++) st.push((await call(ML, { email: email("g1"), password: "wrong" }, direct("10.66.0.1"))).status);
    assert(st.every((s) => s === 401), "guest 1: 10 wrong tries are answered normally", st);
    let r = await call(ML, { email: email("g1"), password: "wrong" }, direct("10.66.0.1"));
    assert(r.status === 429, "guest 1: 11th wrong try → 429", r.status);
    assert(r.body?.message === LOGIN_LIMIT_MESSAGE && r.body?.code === "RATE_LIMITED" && r.body?.error?.code === "RATE_LIMITED" && r.body?.error?.message === LOGIN_LIMIT_MESSAGE,
      "429 body: top level message + code, and error { code, message } like the 401s", r.body);
    r = await call(ML, { email: email("g1"), password: PASS }, direct("10.66.0.1"));
    assert(r.status === 429, "guest 1 is held even with the right password until the window ends", r.status);
    r = await call(ML, { email: email("g2"), password: PASS }, direct("10.66.0.1"));
    assert(r.status === 200 && typeof r.body?.accessToken === "string", "guest 2 is not blocked (same address)", { status: r.status });
    r = await call(ML, { email: email("g2"), password: "wrong" }, direct("10.66.0.1"));
    assert(r.status === 401, "guest 2's own wrong try is a normal 401", r.status);

    console.log("\n=== A locked account's extra clicks don't use up the shared network count ===");
    for (let i = 0; i < 120; i++) await call(ML, { email: email("g1"), password: PASS }, direct("10.66.0.1"));
    r = await call(ML, { email: email("g2"), password: "wrong" }, direct("10.66.0.1"));
    assert(r.status === 401, "after 120 more clicks on the locked account, guest 2's wrong try is still a normal 401", r.status);

    console.log("\n=== The same account from anywhere, any case, both login routes ===");
    r = await call(ML, { identifier: email("g1").toUpperCase(), password: "wrong" }, direct("10.66.9.9"));
    assert(r.status === 429, "guest 1 from another address, upper case identifier → 429", r.status);
    r = await call("/api/auth/login", { email: email("g1"), password: "wrong" }, direct("10.66.9.10"));
    assert(r.status === 429, "/api/auth/login shares the account count", r.status);

    console.log("\n=== Successes don't count ===");
    st = [];
    for (let i = 0; i < 12; i++) st.push((await call(ML, { email: email("g3"), password: PASS }, direct("10.66.0.2"))).status);
    assert(st.every((s) => s === 200), "12 good logins in a row all succeed", st);
    for (let i = 0; i < 9; i++) await call(ML, { email: email("g3"), password: "wrong" }, direct("10.66.0.2"));
    r = await call(ML, { email: email("g3"), password: PASS }, direct("10.66.0.2"));
    assert(r.status === 200, "9 wrong then the right one still logs in", r.status);

    console.log("\n=== Network backstop: 100 failed tries per visitor ===");
    st = [];
    for (let i = 0; i < 99; i++) st.push((await call(ML, { email: `${P}-nobody${i}@test.local`, password: "x" }, direct("10.66.0.3"))).status);
    r = await call(ML, { email: email("g4"), password: PASS }, direct("10.66.0.3"));
    assert(r.status === 200, "after 99 failures a good login still goes through and is not counted", r.status);
    st.push((await call(ML, { email: `${P}-nobody99@test.local`, password: "x" }, direct("10.66.0.3"))).status);
    assert(st.every((s) => s === 401), "100 wrong tries across 100 accounts from one address are answered", st.filter((s) => s !== 401));
    r = await call(ML, { email: `${P}-nobody-x@test.local`, password: "x" }, direct("10.66.0.3"));
    assert(r.status === 429, "101st failed try from that address → 429", r.status);
    r = await call(ML, { email: `${P}-nobody-y@test.local`, password: "x" }, direct("10.66.0.4"));
    assert(r.status === 401, "another address is not affected", r.status);

    console.log("\n=== Backstop per visitor when goutsyde.com sends the key ===");
    for (let i = 0; i < 100; i++) await call(ML, { email: `${P}-site${i}@test.local`, password: "x" }, viaSite("203.0.113.20"));
    r = await call(ML, { email: `${P}-site-x@test.local`, password: "x" }, viaSite("203.0.113.20"));
    assert(r.status === 429, "visitor A through the site: 101st failure → 429", r.status);
    r = await call(ML, { email: `${P}-site-y@test.local`, password: "x" }, viaSite("203.0.113.21"));
    assert(r.status === 401, "visitor B through the same site is not affected", r.status);
    r = await call(ML, { email: `${P}-site-z@test.local`, password: "x" }, { "x-outsyde-proxy-key": "w".repeat(KEY.length), "x-outsyde-client-ip": "203.0.113.22", "X-Forwarded-For": "10.66.0.3" });
    assert(r.status === 429, "wrong key: header ignored, counted on the caller's own (full) address", r.status);

    console.log("\n=== Password reset: asking for a code or link, 5 per email ===");
    st = [];
    for (let i = 0; i < 5; i++) st.push((await call("/api/auth/forgot-password/send-code", { email: email("web") }, direct("10.66.0.5"))).status);
    assert(st.every((s) => s === 200), "5 code requests for one email answered", st);
    r = await call("/api/auth/forgot-password/send-code", { email: email("web").toUpperCase() }, direct("10.66.0.6"));
    assert(r.status === 429 && r.body?.code === "RATE_LIMITED" && typeof r.body?.message === "string", "6th code request for that email (any case, any address) → 429", r.body);
    r = await call("/api/auth/forgot-password", { email: email("web") }, direct("10.66.0.6"));
    assert(r.status === 429, "the link request shares that count", r.status);
    r = await call("/api/auth/forgot-password/verify-code", { email: email("web"), code: "000000" }, direct("10.66.0.6"));
    assert(r.status !== 429, "entering a code is not blocked by too many code requests (own count)", r.status);
    r = await call("/api/auth/forgot-password/send-code", { email: email("g2") }, direct("10.66.0.5"));
    assert(r.status === 200, "another email from the same address is fine", r.status);
    r = await call(ML, { email: email("web"), password: PASS }, direct("10.66.0.5"));
    assert(r.status === 200, "reset requests never use up that account's login tries", r.status);

    console.log("\n=== Password reset: using a code or link, 15 per email ===");
    st = [];
    for (let i = 0; i < 14; i++) st.push((await call("/api/auth/forgot-password/verify-code", { email: email("g3"), code: "000000" }, direct(`10.66.2.${i + 1}`))).status);
    r = await call("/api/auth/reset-password", { email: email("g3"), token: "nope", newPassword: "abcdef" }, direct("10.66.2.99"));
    assert(st.every((s) => s !== 429) && r.status !== 429, "15 code or link uses for one email are answered", { st, last: r.status });
    r = await call("/api/auth/forgot-password/verify-code", { email: email("g3"), code: "000000" }, direct("10.66.2.100"));
    assert(r.status === 429, "16th use for that email → 429", r.status);

    console.log("\n=== Password reset: 30 per visitor ===");
    st = [];
    for (let i = 0; i < 29; i++) st.push((await call("/api/auth/forgot-password", { email: `${P}-r${i}@test.local` }, direct("10.66.0.7"))).status);
    r = await call("/api/auth/reset-password", { email: `${P}-rz@test.local`, token: "x", newPassword: "abcdef" }, direct("10.66.0.7"));
    assert(st.every((s) => s === 200) && r.status !== 429, "30 reset requests per visitor are answered", { st: st.filter((s) => s !== 200), last: r.status });
    r = await call("/api/auth/forgot-password", { email: `${P}-rzz@test.local` }, direct("10.66.0.7"));
    assert(r.status === 429, "31st reset request from one visitor → 429", r.status);

    console.log("\n=== The account's tries left aren't advertised ===");
    const hdrs = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const u = new URL(ML, BASE!); const d = JSON.stringify({ email: email("g4"), password: "wrong" });
      const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(d)), "X-Forwarded-For": "10.66.3.1" } }, (res) => { res.resume(); resolve(res.headers); });
      rq.on("error", reject); rq.write(d); rq.end();
    });
    assert(hdrs["ratelimit-limit"] !== "10", "RateLimit headers belong to the network backstop, not the account count", { limit: hdrs["ratelimit-limit"], remaining: hdrs["ratelimit-remaining"] });
  } finally {
    await q(`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]).catch((e) => console.warn("cleanup:", e.message));
    await db.end();
  }
}

(async () => {
  unitBlock();
  await httpBlock();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
