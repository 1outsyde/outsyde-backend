/**
 * Events door check-in Task 2: door team management routes.
 *
 * Run with: .superpowers/sdd/2026-10-22-events-list-day-of-address/env/run-suite.sh server/events/doorTeam.http.test.ts
 * SCRATCH ONLY. Local scratch Postgres with migrations through 067, backend on localhost (EV_TEST_BASE_URL),
 * EV_TEST_PG_URL, DATABASE_URL via the neon shim preload (for the in-process push checks). Localhost only.
 * Skips (exit 0) when EV_TEST_BASE_URL is unset.
 *
 * Pushes: the HTTP server is another process, so the push copy and "once per add" are checked against an
 * in-process express app that mounts the same router with recording push fakes.
 *
 * Mutation checks:
 *  - drop the host check in the team routes → "stranger gets 404" fails.
 *  - drop LOWER() in the username lookup → "case-insensitive" fails.
 *  - drop `removed_at IS NULL` from the duplicate check → "re-add after remove" / "duplicate 409" fail.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function callAt(base: string, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, raw: b }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const P = `dt${Date.now().toString(36)}`;
  const mkUser = async (s: string, o: { active?: boolean; first?: string } = {}) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s} Last`, o.first ?? `First${s}`, username, o.active ?? true],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host", { first: "Hosty" });
  const other = await mkUser("other");
  const m1 = await mkUser("m1");
  const m2 = await mkUser("m2");
  const m3 = await mkUser("m3");
  const inactive = await mkUser("inact", { active: false });
  const stranger = await mkUser("str");

  const mkEvent = async (hostId: string, startsH: number, endsH: number, title: string, status = "published") => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, now() + ($6 || ' hours')::interval, 'America/New_York') RETURNING id`,
    [hostId, `${P}-${Math.random().toString(36).slice(2, 8)}`, title, status, String(startsH), String(endsH)],
  ))[0].id as string;
  const evA = await mkEvent(host.id, -1, 2, `${P} Alpha`);
  const evB = await mkEvent(host.id, 24, 28, `${P} Beta`);
  const evEnded = await mkEvent(host.id, -6, -2, `${P} Ended`);
  const evDraft = await mkEvent(host.id, 24, 28, `${P} Draft`, "draft");
  const evOther = await mkEvent(other.id, -1, 2, `${P} Other`);
  const eventIds = [evA, evB, evEnded, evDraft, evOther];
  const ht = tok(host.id);
  const add = (ev: string, username: string, scope: string, token = ht) => call("POST", `/api/events/${ev}/door/team`, { token, body: { username, scope } });

  // In-process app for push checks
  const express = (await import("express")).default;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  const pushes: any[] = [];
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p) => { pushes.push(p); return true; },
  });
  const { default: doorRouter } = await import("./doorRouter");
  const app = express();
  app.use(express.json());
  app.use("/api/events", doorRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const LOCAL = `http://127.0.0.1:${(srv.address() as any).port}`;

  try {
    console.log("\nadd");
    let r = await add(evA, m1.username.toUpperCase(), "standing");
    assert(r.status === 201 && r.body.success && r.body.scope === "standing", "standing add by username, case-insensitive", r);
    assert(r.body.member?.userId === m1.id && r.body.member.firstName === "Firstm1" && r.body.member.username === m1.username && !!r.body.member.addedAt, "member shape", r.body);
    assert(!/email|@test\.local/i.test(r.raw), "response never contains an email");
    r = await add(evA, m2.username, "event");
    assert(r.status === 201 && r.body.scope === "event" && r.body.member.userId === m2.id, "event add", r);
    r = await add(evA, host.username, "standing");
    assert(r.status === 400 && r.body.error.code === "CANNOT_ADD_SELF", "self add is 400", r);
    r = await add(evA, "nobody_" + P, "event");
    assert(r.status === 404 && r.body.error.code === "USER_NOT_FOUND", "unknown username is 404", r);
    r = await add(evA, inactive.username, "event");
    assert(r.status === 404 && r.body.error.code === "USER_NOT_FOUND", "inactive user is 404", r);
    r = await add(evA, m1.username, "standing");
    assert(r.status === 409 && r.body.error.code === "ALREADY_ON_TEAM", "duplicate standing is 409", r);
    r = await add(evA, m2.username, "event");
    assert(r.status === 409 && r.body.error.code === "ALREADY_ON_TEAM", "duplicate event is 409", r);
    r = await add(evA, m3.username, "everyone");
    assert(r.status === 400, "bad scope is 400", r);
    r = await call("POST", `/api/events/${evA}/door/team`, { token: ht, body: { username: m3.username, scope: "event", extra: 1 } });
    assert(r.status === 400, "extra body keys are 400 (strict)", r);
    r = await add(evA, "", "event");
    assert(r.status === 400, "empty username is 400", r);
    r = await add(evA, "x".repeat(41), "event");
    assert(r.status === 400, "username over 40 is 400", r);

    console.log("\nhost only");
    const st = tok(stranger.id);
    r = await add(evA, m3.username, "event", st);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger gets 404 on add", r);
    r = await call("GET", `/api/events/${evA}/door/team`, { token: st });
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger gets 404 on list", r);
    r = await call("DELETE", `/api/events/${evA}/door/team/${m2.id}?scope=event`, { token: st });
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger gets 404 on remove", r);
    r = await call("GET", `/api/events/${evA}/door/team`, { token: tok(m1.id) });
    assert(r.status === 404, "standing member can't list the team", r);
    r = await add(evA, m3.username, "event", tok(m2.id));
    assert(r.status === 404, "event member can't add", r);
    r = await call("GET", `/api/events/${evA}/door/team`);
    assert(r.status === 401, "no token is 401", r.status);
    r = await add(evOther, m3.username, "event");
    assert(r.status === 404, "host can't touch someone else's event", r);

    console.log("\nlist");
    r = await call("GET", `/api/events/${evA}/door/team`, { token: ht });
    assert(r.status === 200 && r.body.standing.length === 1 && r.body.standing[0].userId === m1.id, "standing list", r.body);
    assert(r.body.event.length === 1 && r.body.event[0].userId === m2.id, "event list", r.body);
    assert(!/email|@test\.local/i.test(r.raw), "list never contains an email");
    r = await call("GET", `/api/events/${evB}/door/team`, { token: ht });
    assert(r.body.standing.length === 1 && r.body.event.length === 0, "event members are per event, standing is per host", r.body);

    console.log("\nmine");
    r = await call("GET", "/api/events/door/mine", { token: tok(m1.id) });
    const ids = (r.body.events ?? []).map((e: any) => e.id);
    assert(r.status === 200 && ids.includes(evA) && ids.includes(evB), "standing member sees the host's published events", r.body);
    assert(!ids.includes(evEnded) && !ids.includes(evDraft) && !ids.includes(evOther), "no ended, draft or other host events", ids);
    const row = r.body.events.find((e: any) => e.id === evA);
    assert(row?.role === "standing" && row.title && row.slug && row.startsAt && row.endsAt && row.timezone, "event row shape", row);
    r = await call("GET", "/api/events/door/mine", { token: tok(m2.id) });
    assert((r.body.events ?? []).length === 1 && r.body.events[0].id === evA && r.body.events[0].role === "event", "event member sees only that event", r.body);
    r = await call("GET", "/api/events/door/mine", { token: tok(stranger.id) });
    assert(r.status === 200 && r.body.events.length === 0, "stranger sees none", r.body);
    r = await call("GET", "/api/events/door/mine", { token: ht });
    assert(!(r.body.events ?? []).some((e: any) => e.id === evA) || r.body.events.find((e: any) => e.id === evA).role === "host", "host sees own events as host", r.body);

    console.log("\nremove");
    r = await call("DELETE", `/api/events/${evA}/door/team/${m2.id}?scope=event`, { token: ht });
    assert(r.status === 200 && r.body.removed === true, "remove event member", r);
    r = await call("DELETE", `/api/events/${evA}/door/team/${m2.id}?scope=event`, { token: ht });
    assert(r.status === 404 && r.body.error.code === "NOT_ON_TEAM", "remove again is 404 NOT_ON_TEAM", r);
    r = await call("DELETE", `/api/events/${evA}/door/team/${m1.id}?scope=event`, { token: ht });
    assert(r.status === 404 && r.body.error.code === "NOT_ON_TEAM", "scope must match the row", r);
    r = await call("DELETE", `/api/events/${evA}/door/team/${m1.id}`, { token: ht });
    assert(r.status === 400, "missing scope is 400", r);
    r = await call("GET", "/api/events/door/mine", { token: tok(m2.id) });
    assert(r.body.events.length === 0, "nothing in /door/mine after removal", r.body);
    r = await add(evA, m2.username, "event");
    assert(r.status === 201, "re-add after remove works", r);
    const hist = await q(`SELECT count(*)::int AS n FROM event_door_members WHERE event_id = $1 AND member_user_id = $2`, [evA, m2.id]);
    assert(hist[0].n === 2, "removal keeps history (soft remove)", hist);
    r = await call("DELETE", `/api/events/${evA}/door/team/${m1.id}?scope=standing`, { token: ht });
    assert(r.status === 200, "remove standing member", r);
    r = await call("GET", "/api/events/door/mine", { token: tok(m1.id) });
    assert(r.body.events.length === 0, "removed standing member sees nothing", r.body);

    console.log("\npush (in-process router, recording fakes)");
    pushes.length = 0;
    const lt = (id: string) => tok(id);
    r = await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(host.id), body: { username: m3.username, scope: "event" } });
    await sleep(300);
    assert(r.status === 201 && pushes.length === 1, "one push per add", { status: r.status, n: pushes.length });
    assert(pushes[0]?.userId === m3.id && pushes[0].title === "You're on the door team" && pushes[0].body === `You can now scan tickets for ${P} Alpha.`, "event scope copy", pushes[0]);
    pushes.length = 0;
    r = await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(host.id), body: { username: m1.username, scope: "standing" } });
    await sleep(300);
    assert(pushes.length === 1 && pushes[0].body === "You can now scan tickets for Hosty's events.", "standing scope copy uses the host name", pushes[0]);
    assert(!/[–—]| - /.test(pushes[0].title + pushes[0].body), "no dashes in copy");
    pushes.length = 0;
    await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(host.id), body: { username: m1.username, scope: "standing" } });
    await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(host.id), body: { username: host.username, scope: "standing" } });
    await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(stranger.id), body: { username: m3.username, scope: "event" } });
    await sleep(200);
    assert(pushes.length === 0, "no push on duplicate, self or non-host", pushes);
    setNoticeDepsForTest({
      sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
      sendPush: async () => { throw new Error("expo down"); },
    });
    await q(`UPDATE event_door_members SET removed_at = now() WHERE event_id = $1 AND member_user_id = $2`, [evA, m3.id]);
    r = await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(host.id), body: { username: m3.username, scope: "event" } });
    assert(r.status === 201, "a failing push doesn't fail the add", r);
  } finally {
    setNoticeDepsForTest(null);
    srv.close();
    await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM event_door_team WHERE host_user_id IN ($1,$2)`, [host.id, other.id]);
    await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
