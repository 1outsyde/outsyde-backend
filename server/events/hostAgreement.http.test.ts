/**
 * Event Host Agreement: HTTP integration tests for /api/events/host-agreement and the publish gate.
 *
 * Run with: npx tsx server/events/hostAgreement.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with
 * migrations/069_host_agreement_acceptances.sql applied.
 *   EV_TEST_BASE_URL   e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - drop `${acceptedCurrentVersionSql(userId)}` from the publish UPDATE → "not accepted: publish refused" fails.
 *  - drop `a.version = ${HOST_AGREEMENT_VERSION}` in acceptedCurrentVersionSql → "an older version doesn't count" fails.
 *  - drop `a.user_id = ${userId}` in acceptedCurrentVersionSql → "someone else's acceptance doesn't count" fails.
 *  - drop the version check in POST /accept → "an older version can't be accepted" fails.
 *  - change ON CONFLICT DO NOTHING to DO UPDATE SET accepted_at = now() → "accepting twice keeps the first time" fails.
 *  - drop the HOST_AGREEMENT_REQUIRED branch → "publish says the agreement is needed" fails (EVENT_CHANGED instead).
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; ua?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    if (o.ua) headers["User-Agent"] = o.ua;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `ha${Date.now().toString(36)}`;
  const mkUser = async (s: string, active = true) => (await q(
    `INSERT INTO users (id, email, name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, `${P}${s}`.slice(0, 20), active],
  ))[0].id as string;
  const host = await mkUser("host");
  const other = await mkUser("other");
  const owner = await mkUser("owner");
  const banned = await mkUser("ban", false);
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES (gen_random_uuid(), $1, $2, 'Events', 'approved', $3, true)`, [owner, `${P} Lounge`, `acct_${P}_biz`]);
  // Every host needs payouts set up to publish (2026-10-26); this suite tests other rules, so its hosts have it.
  for (const u of [host, other]) await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [u, `acct_${P}_${u.slice(0, 8)}`]);

  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  const body = () => ({
    title: "Agreement Party", startsAt: inDays(10), endsAt: inDays(10, 4), timezone: "America/New_York",
    venueName: "The Loft", addressLine1: "1 Main St", city: "Freeport", state: "NY", postalCode: "11520", latitude: 40.65, longitude: -73.58,
    capacity: 50,
  });
  /** A draft with one visible free ticket type: ready to publish except for the agreement. */
  const readyDraft = async (who: string, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/events", { token: tok(who), body: { ...body(), ...extra } });
    if (r.status !== 201) throw new Error("create failed " + JSON.stringify(r));
    await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'Free RSVP', 0, 10)`, [r.body.event.id]);
    return r.body.event.id as string;
  };
  const statusOf = async (id: string) => (await q(`SELECT status FROM events WHERE id = $1`, [id]))[0]?.status;
  const rowsFor = (id: string) => q(`SELECT version, accepted_at, user_agent FROM host_agreement_acceptances WHERE user_id = $1 ORDER BY accepted_at`, [id]);

  try {
    console.log("Reading the agreement");
    let r = await call("GET", "/api/events/host-agreement");
    assert(r.status === 401, "signed out can't read it", r);
    r = await call("GET", "/api/events/host-agreement", { token: tok(host) });
    const a = r.body?.agreement;
    assert(r.status === 200 && typeof a?.version === "string" && a.version.length > 0, "signed in gets the current version", r);
    const VERSION = a.version as string;
    assert(a.title === "Outsyde Event Host Agreement" && a.format === "markdown", "title and format", a);
    assert(a.text.startsWith("## 1. About This Agreement"), "text starts at section 1 (no byline or internal draft note)", a.text.slice(0, 80));
    assert(!a.text.includes("Draft for review") && !a.text.includes("@Legend"), "internal draft note and byline left out");
    assert(a.text.includes(`Version: ${VERSION}.`) && !a.text.includes("\\[VERSION\\]"), "version placeholder filled with the served version");
    assert(a.text.includes("## 13. General Terms") && a.text.trimEnd().endsWith("understand it, and agree to it."), "full text through the closing line");
    assert(a.text.includes("keeps 2% of the Ticket Price") && !/8\s?%/.test(a.text), "states the 2% host fee and never the guest fee percentage");
    assert(a.accepted === false && a.acceptedVersion === null && a.acceptedAt === null, "not accepted yet", a);

    console.log("Publishing before accepting");
    const ev1 = await readyDraft(host);
    r = await call("POST", `/api/events/${ev1}/publish`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "HOST_AGREEMENT_REQUIRED", "publish says the agreement is needed", r);
    assert(r.body?.error?.message === "Read and accept the Event Host Agreement to publish.", "plain message", r.body?.error);
    assert(await statusOf(ev1) === "draft", "not accepted: publish refused (event stays a draft)", await statusOf(ev1));

    console.log("Accepting");
    r = await call("POST", "/api/events/host-agreement/accept", { body: { version: VERSION } });
    assert(r.status === 401, "signed out can't accept", r);
    r = await call("POST", "/api/events/host-agreement/accept", { token: tok(host), body: {} });
    assert(r.status === 400 && r.body.error.code === "INVALID_AGREEMENT", "version is required", r);
    r = await call("POST", "/api/events/host-agreement/accept", { token: tok(host), body: { version: VERSION, userId: other } });
    assert(r.status === 400, "extra fields refused", r);
    r = await call("POST", "/api/events/host-agreement/accept", { token: tok(host), body: { version: "2020-01-01" } });
    assert(r.status === 409 && r.body.error.code === "AGREEMENT_VERSION_CHANGED", "an older version can't be accepted", r);
    assert((await rowsFor(host)).length === 0, "nothing saved for a refused accept");
    r = await call("POST", "/api/events/host-agreement/accept", { token: tok(banned), body: { version: VERSION } });
    assert(r.status === 403 && r.body.error.code === "ACCOUNT_INACTIVE", "inactive account can't accept", r);

    r = await call("POST", "/api/events/host-agreement/accept", { token: tok(host), body: { version: VERSION }, ua: "AgreementTest/1.0" });
    assert(r.status === 200 && r.body.agreement.accepted === true && r.body.agreement.acceptedVersion === VERSION && !!r.body.agreement.acceptedAt, "host accepts", r);
    const first = await rowsFor(host);
    assert(first.length === 1 && first[0].version === VERSION && first[0].user_agent === "AgreementTest/1.0", "one row: version + user agent recorded", first);
    await new Promise((x) => setTimeout(x, 30));
    r = await call("POST", "/api/events/host-agreement/accept", { token: tok(host), body: { version: VERSION } });
    const again = await rowsFor(host);
    assert(r.status === 200 && again.length === 1 && new Date(again[0].accepted_at).getTime() === new Date(first[0].accepted_at).getTime(), "accepting twice keeps the first time", { r, first, again });
    assert(r.body.agreement.acceptedAt === new Date(first[0].accepted_at).toISOString(), "answer shows the first time", r.body.agreement);
    r = await call("GET", "/api/events/host-agreement", { token: tok(host) });
    assert(r.status === 200 && r.body.agreement.accepted === true && r.body.agreement.acceptedVersion === VERSION, "reading again shows it accepted", r.body?.agreement?.accepted);

    // Two accepts at once (a double tap) still leave one row.
    const racer = await mkUser("race");
    const both = await Promise.all([1, 2].map(() => call("POST", "/api/events/host-agreement/accept", { token: tok(racer), body: { version: VERSION } })));
    const raced = await rowsFor(racer);
    assert(both.every((x) => x.status === 200) && raced.length === 1, "two accepts at once: both answer 200, one row", { s: both.map((x) => x.status), raced });

    console.log("Publishing after accepting");
    r = await call("POST", `/api/events/${ev1}/publish`, { token: tok(host) });
    assert(r.status === 200 && r.body.event.status === "published", "accepted: publish works", r);

    console.log("Whose acceptance counts");
    // other has only an older version on record.
    await q(`INSERT INTO host_agreement_acceptances (user_id, version) VALUES ($1, 'older-version')`, [other]);
    const ev2 = await readyDraft(other);
    r = await call("POST", `/api/events/${ev2}/publish`, { token: tok(other) });
    assert(r.status === 409 && r.body.error.code === "HOST_AGREEMENT_REQUIRED" && await statusOf(ev2) === "draft", "an older version doesn't count", r);
    r = await call("GET", "/api/events/host-agreement", { token: tok(other) });
    assert(r.body?.agreement?.accepted === false, "older version reads as not accepted", r.body?.agreement);
    // owner hosts as their business; host's acceptance must not cover them.
    const ev3 = await readyDraft(owner, { hostAs: "business" });
    r = await call("POST", `/api/events/${ev3}/publish`, { token: tok(owner) });
    assert(r.status === 409 && r.body.error.code === "HOST_AGREEMENT_REQUIRED" && await statusOf(ev3) === "draft", "someone else's acceptance doesn't count", r);
    const ag = await call("GET", "/api/events/host-agreement", { token: tok(owner) });
    await call("POST", "/api/events/host-agreement/accept", { token: tok(owner), body: { version: ag.body.agreement.version } });
    r = await call("POST", `/api/events/${ev3}/publish`, { token: tok(owner) });
    assert(r.status === 200 && r.body.event.hostType === "business", "business owner publishes after accepting", r);

    console.log("Other publish reasons still come first");
    const ev4 = (await call("POST", "/api/events", { token: tok(other), body: body() })).body.event.id;
    r = await call("POST", `/api/events/${ev4}/publish`, { token: tok(other) });
    assert(r.status === 409 && r.body.error.code === "NO_TICKET_TYPES", "missing ticket type is reported before the agreement", r);
    r = await call("POST", `/api/events/${ev1}/publish`, { token: tok(other) });
    assert(r.status === 404, "stranger still gets 404", r);
  } finally {
    const ids = (await q(`SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`])).map((x) => x.id);
    if (ids.length) {
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ids]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [ids]);
    }
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM host_agreement_acceptances WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM user_payout_accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
