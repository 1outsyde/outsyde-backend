/**
 * Quick sign up on the event page (p4-quicksignup, 2026-10-28): unit + HTTP integration tests.
 *
 * Run with: npx tsx server/quickSignup.http.test.ts
 *
 * The unit block (quickSignupKey) always runs. The HTTP block is SCRATCH ONLY and needs a backend
 * booted on localhost against a LOCAL scratch Postgres, started with OUTSYDE_PROXY_KEY set:
 *   PS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   QS_TEST_PROXY_KEY  identical to the server's OUTSYDE_PROXY_KEY (32+ characters)
 * Restart the server between runs: the limiter buckets live in memory.
 *
 * Mutation checks: make quickSignupKey always return the header ip → "no key: header ignored" fails;
 * remove the EMAIL_EXISTS branch → "existing email" fails (gets 400).
 */
import http from "http";
import { ipKeyGenerator } from "express-rate-limit";
import { quickSignupKey } from "./quickSignup";

const BASE = process.env.PS_TEST_BASE_URL;
const PG_URL = process.env.PS_TEST_PG_URL;
const KEY = process.env.QS_TEST_PROXY_KEY || "";
const LIMIT_MESSAGE = "Too many sign ups from this network. Please try again in a few minutes.";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

function unitBlock() {
  console.log("\n=== quickSignupKey (unit) ===");
  const good = "k".repeat(40);
  const fakeReq = (headers: Record<string, string>, ip = "10.1.2.3") => ({ ip, headers }) as any;
  const env = (v?: string) => (v === undefined ? {} : { OUTSYDE_PROXY_KEY: v }) as NodeJS.ProcessEnv;

  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": good, "x-outsyde-client-ip": "203.0.113.7" }), env(good)) === ipKeyGenerator("203.0.113.7"),
    "right key: keyed on the client ip header",
  );
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": good, "x-outsyde-client-ip": "2001:db8::1" }), env(good)) === ipKeyGenerator("2001:db8::1"),
    "right key, IPv6 client: wrapped with ipKeyGenerator (subnet)",
  );
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": good, "x-outsyde-client-ip": "203.0.113.7" }), env(undefined)) === ipKeyGenerator("10.1.2.3"),
    "env key unset: req.ip",
  );
  const short = "s".repeat(31);
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": short, "x-outsyde-client-ip": "203.0.113.7" }), env(short)) === ipKeyGenerator("10.1.2.3"),
    "env key shorter than 32: req.ip even when the header matches",
  );
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": good + "x", "x-outsyde-client-ip": "203.0.113.7" }), env(good)) === ipKeyGenerator("10.1.2.3"),
    "mismatched key (different length): req.ip",
  );
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": "j".repeat(40), "x-outsyde-client-ip": "203.0.113.7" }), env(good)) === ipKeyGenerator("10.1.2.3"),
    "mismatched key (same length): req.ip",
  );
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-client-ip": "203.0.113.7" }), env(good)) === ipKeyGenerator("10.1.2.3"),
    "no key header: req.ip",
  );
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": good, "x-outsyde-client-ip": "not-an-ip" }), env(good)) === ipKeyGenerator("10.1.2.3"),
    "header not a valid IP: req.ip",
  );
  assert(
    quickSignupKey(fakeReq({ "x-outsyde-proxy-key": good, "x-outsyde-client-ip": "203.0.113.7, 10.0.0.1" }), env(good)) === ipKeyGenerator("10.1.2.3"),
    "header with a list: req.ip (only one plain address is trusted)",
  );
  assert(
    quickSignupKey({ headers: { "x-outsyde-client-ip": "203.0.113.7" } } as any, env(undefined)) === "unknown",
    "no req.ip and no trusted header: a fixed fallback, never throws",
  );
}

type Res = { status: number; body: any; raw: string };
function call(method: string, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { ...(o.headers || {}) };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, raw: b }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

let clientIpCounter = 1;
const freshClientIp = () => `198.51.100.${clientIpCounter++}`;
const proxied = (clientIp = freshClientIp()) => ({ "x-outsyde-proxy-key": KEY, "x-outsyde-client-ip": clientIp });
const QS = "/api/auth/customer/quick-signup";

async function httpBlock() {
  if (!BASE) { console.log("\n⏭  HTTP block skipped: set PS_TEST_BASE_URL + PS_TEST_PG_URL + QS_TEST_PROXY_KEY to run"); return; }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  if (KEY.length < 32) throw new Error("QS_TEST_PROXY_KEY must match the server's OUTSYDE_PROXY_KEY (32+ characters)");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `qs${Date.now().toString(36)}`;
  const email = (s: string) => `${P}-${s}@test.local`;

  try {
    console.log("\n=== Creates a light account ===");
    let r = await call("POST", QS, { headers: proxied(), body: { firstName: "Maya", email: `  ${email("maya")}  `, phone: "(516) 555 0142", password: "secret1" } });
    assert(r.status === 200, "200 for first name, email, phone, password", { status: r.status, body: r.body });
    assert(typeof r.body?.accessToken === "string" && r.body.accessToken.length > 20, "returns accessToken", r.body);
    assert(r.body?.success === true && typeof r.body?.refreshToken === "string" && typeof r.body?.expiresIn === "number" && "referralApplied" in (r.body || {}),
      "same body shape as customer signup (success, user, accessToken, refreshToken, expiresIn, referralApplied)", Object.keys(r.body || {}));
    let rows = await q(`SELECT id, email, source, phone, first_name, username, password FROM users WHERE LOWER(email) = LOWER($1)`, [email("maya")]);
    assert(rows.length === 1, "one users row", rows.length);
    assert(rows[0]?.source === "outsyde-web-event", "users.source = 'outsyde-web-event'", rows[0]?.source);
    assert(rows[0]?.phone === "(516) 555 0142", "users.phone stored as typed", rows[0]?.phone);
    assert(rows[0]?.email === email("maya"), "email stored trimmed", rows[0]?.email);
    assert(rows[0]?.first_name === "Maya", "first_name saved", rows[0]?.first_name);
    assert(typeof rows[0]?.username === "string" && rows[0].username.length >= 3, "username made from the email", rows[0]?.username);
    assert(typeof rows[0]?.password === "string" && rows[0].password !== "secret1", "password stored hashed", null);

    console.log("\n=== Body is limited to the quick fields ===");
    r = await call("POST", QS, { headers: proxied(), body: {
      firstName: "Extra", email: email("extra"), phone: "5165550143", password: "secret1",
      username: `${P}chosen`.slice(0, 20), source: "spoofed-source", inviteCode: "NOPE", referralCode: "NOPE", isAdmin: true, city: "Spoofville",
    } });
    assert(r.status === 200, "extra fields do not fail the sign up", { status: r.status, body: r.body });
    rows = await q(`SELECT source, username, city, is_admin FROM users WHERE email = $1`, [email("extra")]);
    assert(rows[0]?.source === "outsyde-web-event", "client source is replaced", rows[0]?.source);
    assert(rows[0]?.username !== `${P}chosen`.slice(0, 20), "client username is dropped (made from the email)", rows[0]?.username);
    assert(rows[0]?.city == null, "other profile fields are dropped", rows[0]?.city);
    assert(rows[0]?.is_admin !== true, "never admin", rows[0]?.is_admin);
    assert(r.body?.referralApplied == null || r.body?.referralApplied === false, "referral code not applied", r.body?.referralApplied);

    console.log("\n=== Phone is required ===");
    r = await call("POST", QS, { headers: proxied(), body: { firstName: "Short", email: email("short"), phone: "555", password: "secret1" } });
    assert(r.status === 400 && r.body?.code === "PHONE_REQUIRED", "phone '555' → 400 PHONE_REQUIRED", { status: r.status, body: r.body });
    rows = await q(`SELECT 1 FROM users WHERE email = $1`, [email("short")]);
    assert(rows.length === 0, "no users row for a short phone", rows.length);
    r = await call("POST", QS, { headers: proxied(), body: { firstName: "None", email: email("none"), password: "secret1" } });
    assert(r.status === 400 && r.body?.code === "PHONE_REQUIRED", "missing phone → 400 PHONE_REQUIRED", { status: r.status, body: r.body });
    r = await call("POST", QS, { headers: proxied(), body: { firstName: "Plus", email: email("plus"), phone: "+1 516 555 0144", password: "secret1" } });
    assert(r.status === 200, "'+1 516 555 0144' is accepted", { status: r.status, body: r.body });

    console.log("\n=== Existing email ===");
    r = await call("POST", QS, { headers: proxied(), body: { firstName: "Again", email: email("maya").toUpperCase(), phone: "5165550145", password: "secret1" } });
    assert(r.status === 409 && r.body?.code === "EMAIL_EXISTS", "existing email (any case) → 409 EMAIL_EXISTS", { status: r.status, body: r.body });
    assert(r.body?.message === "That email already has an Outsyde account.", "409 message", r.body?.message);
    rows = await q(`SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)`, [email("maya")]);
    assert(rows.length === 1, "no second row", rows.length);

    console.log("\n=== Shared schema rules still apply ===");
    r = await call("POST", QS, { headers: proxied(), body: { firstName: "Pw", email: email("pw"), phone: "5165550146", password: "12345" } });
    assert(r.status === 400 && r.body?.error === "Invalid data", "password '12345' → 400 Invalid data", { status: r.status, body: r.body });
    r = await call("POST", QS, { headers: proxied(), body: { firstName: "", email: email("noname"), phone: "5165550147", password: "secret1" } });
    assert(r.status === 400 && r.body?.error === "Invalid data", "empty first name → 400 Invalid data", { status: r.status, body: r.body });
    r = await call("POST", QS, { headers: proxied(), body: { firstName: "Bad", email: "not-an-email", phone: "5165550148", password: "secret1" } });
    assert(r.status === 400 && r.body?.error === "Invalid data", "bad email → 400 Invalid data", { status: r.status, body: r.body });

    // Cheap body for the limiter runs: fails at the phone check, creates nothing.
    const cheap = { firstName: "L", email: email("limit"), phone: "1", password: "secret1" };

    console.log("\n=== Limit: 60 per 15 minutes per visitor (right key) ===");
    let statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await call("POST", QS, { headers: proxied("203.0.113.7"), body: cheap })).status);
    assert(statuses.every((s) => s === 400), "first 60 from one client ip are not limited", statuses.filter((s) => s !== 400));
    r = await call("POST", QS, { headers: proxied("203.0.113.7"), body: cheap });
    assert(r.status === 429, "61st request in window from one client ip → 429", r.status);
    assert(r.body?.message === LIMIT_MESSAGE && r.body?.error === LIMIT_MESSAGE && r.body?.code === "RATE_LIMITED", "429 body carries the message", r.body);
    r = await call("POST", QS, { headers: proxied("203.0.113.8"), body: { firstName: "Other", email: email("other"), phone: "5165550149", password: "secret1" } });
    assert(r.status === 200, "a different client ip still gets through", r.status);
    r = await call("POST", QS, { headers: proxied("203.0.113.9"), body: { firstName: "Dup", email: email("maya"), phone: "5165550150", password: "secret1" } });
    assert(r.status === 409, "a different client ip still gets its 409", r.status);

    console.log("\n=== No key: header ignored ===");
    statuses = [];
    for (let i = 0; i < 60; i++) {
      statuses.push((await call("POST", QS, { headers: { "x-outsyde-client-ip": `192.0.2.${i + 1}`, "X-Forwarded-For": "10.55.0.1" }, body: cheap })).status);
    }
    assert(statuses.every((s) => s === 400), "60 with varying header ips get through", statuses.filter((s) => s !== 400));
    r = await call("POST", QS, { headers: { "x-outsyde-client-ip": "192.0.2.200", "X-Forwarded-For": "10.55.0.1" }, body: cheap });
    assert(r.status === 429, "61st hits 429 (all shared the caller's own address)", r.status);

    console.log("\n=== Wrong key: header ignored ===");
    statuses = [];
    const wrong = "w".repeat(KEY.length);
    for (let i = 0; i < 60; i++) {
      statuses.push((await call("POST", QS, { headers: { "x-outsyde-proxy-key": wrong, "x-outsyde-client-ip": `192.0.2.${i + 1}`, "X-Forwarded-For": "10.55.0.2" }, body: cheap })).status);
    }
    assert(statuses.every((s) => s === 400), "60 with a wrong key get through", statuses.filter((s) => s !== 400));
    r = await call("POST", QS, { headers: { "x-outsyde-proxy-key": wrong, "x-outsyde-client-ip": "192.0.2.201", "X-Forwarded-For": "10.55.0.2" }, body: cheap });
    assert(r.status === 429, "61st hits 429 with a wrong key", r.status);

    console.log("\n=== Old routes untouched ===");
    r = await call("POST", "/api/auth/customer/signup", { headers: { "X-Forwarded-For": "10.55.0.1" }, body: { email: "x" } });
    assert(r.status === 400, "quick sign up traffic does not use the regular sign up bucket", r.status);
    statuses = [];
    for (let i = 0; i < 19; i++) statuses.push((await call("POST", "/api/auth/customer/signup", { headers: { "X-Forwarded-For": "10.55.0.1" }, body: { email: "x" } })).status);
    assert(statuses.every((s) => s === 400), "regular sign up: 20 in window allowed", statuses.filter((s) => s !== 400));
    r = await call("POST", "/api/auth/customer/signup", { headers: { "X-Forwarded-For": "10.55.0.1" }, body: { email: "x" } });
    assert(r.status === 429, "/api/auth/customer/signup still limits at 21", r.status);
    r = await call("POST", "/api/auth/customer/signup", { headers: { ...proxied("203.0.113.50"), "X-Forwarded-For": "10.55.0.1" }, body: { email: "x" } });
    assert(r.status === 429, "the proxy key does not change the regular sign up bucket", r.status);
  } finally {
    await q(`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
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
