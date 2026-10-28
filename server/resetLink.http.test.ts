/**
 * R35 (2026-10-28): the password reset email link only goes to Outsyde's own sites.
 *
 * Run with: npx tsx server/resetLink.http.test.ts
 *
 * The unit block always runs. The HTTP block needs a backend booted on localhost against a LOCAL
 * scratch Postgres with RESEND_API_KEY=re_test and RESEND_BASE_URL=http://127.0.0.1:<RL_TEST_RESEND_PORT>
 * (this test runs that Resend stub itself and reads the email the backend sends):
 *   PS_TEST_BASE_URL, PS_TEST_PG_URL (localhost only), RL_TEST_RESEND_PORT (default 4599)
 *
 * Mutation check: make resetLinkBase return the given value unchanged → every "look alike" check fails.
 */
import http from "http";
import { resetLinkBase, RESET_LINK_SITES } from "./resetLink";

const BASE = process.env.PS_TEST_BASE_URL;
const PG_URL = process.env.PS_TEST_PG_URL;
const RESEND_PORT = Number(process.env.RL_TEST_RESEND_PORT || 4599);

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

// What each site sends today (audit 2026-10-28). Every one must keep working.
const SITES_TODAY = [
  "https://braidswithlove.com",
  "https://braidsbylana.com",
  "https://www.lotushouseblends.com",
  "https://nail-sniper-web.vercel.app",
  "https://royal-elite-site-gamma.vercel.app",
  "https://www.dialuxkollecionn.com",
];
const LOOK_ALIKES = [
  "https://evil.example",
  "https://braidswithlove.com.evil.example",
  "https://evil.example/https://braidswithlove.com",
  "https://braidswithlove.com@evil.example",
  "http://braidswithlove.com",
  "https://BRAIDSWITHLOVE.COM.evil.example",
  "//evil.example",
  "javascript:alert(1)",
  "https://www.goutsyde.com.evil.example",
  " https://evil.example ",
  "https://braidswithlove.com\\@evil.example",
  "https:\\\\evil.example",
  "https://braidswithlove.com:8443",
  "https://braidswithlove.com.",
  "https://braidswithlove.com#@evil.example",
  "https://braidswithlove.com\"><x",
  "https://xobeautyandlashes.com",
  "https://braids-with-love-site.vercel.app",
];

function unitBlock() {
  console.log("\n=== resetLinkBase (unit) ===");
  const env = { FRONTEND_URL: "https://www.goutsyde.com", NODE_ENV: "production" } as NodeJS.ProcessEnv;
  for (const s of SITES_TODAY) assert(resetLinkBase(s, env) === s, `kept: ${s}`, resetLinkBase(s, env));
  assert(resetLinkBase("https://www.braidswithlove.com", env) === "https://www.braidswithlove.com", "kept: www.braidswithlove.com");
  assert(resetLinkBase("https://braidsbylana.com/", env) === "https://braidsbylana.com", "a trailing slash is dropped");
  assert(resetLinkBase("https://Braidsbylana.com", env) === "https://braidsbylana.com", "host case is ignored");
  assert(resetLinkBase("https://goutsyde.com", env) === "https://goutsyde.com", "kept: goutsyde.com");
  for (const bad of LOOK_ALIKES) assert(resetLinkBase(bad, env) === "https://www.goutsyde.com", `replaced: ${JSON.stringify(bad)}`, resetLinkBase(bad, env));
  assert(resetLinkBase(undefined, env) === "https://www.goutsyde.com", "missing → FRONTEND_URL");
  assert(resetLinkBase(["https://braidsbylana.com"], env) === "https://www.goutsyde.com", "not a string → FRONTEND_URL");
  assert(resetLinkBase("https://braidsbylana.com", {} as NodeJS.ProcessEnv) === "https://braidsbylana.com", "allowed site kept with no FRONTEND_URL set");
  assert(resetLinkBase("https://evil.example", {} as NodeJS.ProcessEnv) === "https://www.goutsyde.com", "no FRONTEND_URL: goutsyde.com fallback");
  assert(resetLinkBase("https://staging.example", { FRONTEND_URL: "https://staging.example/" } as NodeJS.ProcessEnv) === "https://staging.example", "FRONTEND_URL itself is always allowed");
  assert(resetLinkBase("http://localhost:3001", {} as NodeJS.ProcessEnv) === "https://www.goutsyde.com", "plain http is never allowed unless it is FRONTEND_URL");
  assert(resetLinkBase("https://braidswithlove.com:443", env) === "https://braidswithlove.com", "the default https port is the same site");
  assert(resetLinkBase("https://braidswithl%6Fve.com", env) === "https://braidswithlove.com", "a percent encoded host parses to the same site");
  assert(RESET_LINK_SITES.every((o) => o.startsWith("https://")), "every listed site is https");
}

type Captured = { to: unknown; html: string };
const sent: Captured[] = [];

function call(path: string, body: unknown, ip: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)), "X-Forwarded-For": ip } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j: any = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: j }); });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function httpBlock() {
  if (!BASE) { console.log("\n⏭  HTTP block skipped: set PS_TEST_BASE_URL + PS_TEST_PG_URL"); return; }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  const stub = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { const j = JSON.parse(b); sent.push({ to: j.to, html: String(j.html ?? "") }); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "stub" }));
    });
  });
  await new Promise<void>((r) => stub.listen(RESEND_PORT, "127.0.0.1", () => r()));
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const P = `rl${Date.now().toString(36)}`;
  let n = 0;
  const mkUser = async () => {
    const email = `${P}-${++n}@test.local`;
    await q(`INSERT INTO users (id, email, name, username, password) VALUES (gen_random_uuid(), $1, 'Reset Test', $2, 'x')`, [email, `${P}${n}`.slice(0, 20)]);
    return email;
  };
  const linkFor = async (redirect: unknown, label: string) => {
    const email = await mkUser();
    sent.length = 0;
    const body: Record<string, unknown> = { email };
    if (redirect !== undefined) body.redirect_uri = redirect;
    const r = await call("/api/auth/forgot-password", body, `10.77.0.${n}`);
    for (let i = 0; i < 40 && !sent.length; i++) await new Promise((res) => setTimeout(res, 50));
    const m = sent[0]?.html.match(/<a href="([^"]+)" style/);
    return { status: r.status, body: r.body, link: m ? m[1] : null, label };
  };

  try {
    console.log("\n=== The emailed link (backend + Resend stub) ===");
    for (const s of SITES_TODAY) {
      const r = await linkFor(s, s);
      assert(r.status === 200 && !!r.link && r.link.startsWith(`${s}/reset-password?token=`), `site link kept: ${s}`, r);
    }
    let r = await linkFor(undefined, "none");
    assert(r.status === 200 && !!r.link && r.link.startsWith("https://www.goutsyde.com/reset-password?token="), "no redirect_uri: the goutsyde.com default (server has no FRONTEND_URL)", r);
    for (const bad of ["https://evil.example", "https://braidswithlove.com.evil.example", "https://braidswithlove.com@evil.example"]) {
      r = await linkFor(bad, bad);
      assert(r.status === 200 && !!r.link && !r.link.includes("evil.example"), `look alike replaced in the email: ${bad}`, r);
      assert(r.body?.success === true, "response unchanged (always success)", r.body);
    }
    r = await linkFor("https://evil.example", "app link");
    assert(!!sent[0] && sent[0].html.includes("outsyde://reset-password?token="), "the app deep link is still in the email", sent[0]?.html.slice(0, 200));
  } finally {
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]).catch((e) => console.warn("cleanup:", e.message));
    await db.end();
    stub.close();
  }
}

(async () => {
  unitBlock();
  await httpBlock();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
