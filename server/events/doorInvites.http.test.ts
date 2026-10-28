/**
 * p4-scanner Task 4: the invitee's door team routes (migration 075).
 *
 *   GET  /api/events/door/invites                     my open invites
 *   GET  /api/events/door/invites/:inviteId           one invite: invited | accepted | declined | gone
 *   POST /api/events/door/invites/:inviteId/accept    -> can scan; host gets one push
 *   POST /api/events/door/invites/:inviteId/decline   -> host sees "Said no", no notice
 *   POST /api/events/door/invites/:inviteId/leave     an accepted member leaves
 *
 * SCRATCH ONLY: localhost backend (EV_TEST_BASE_URL) + Postgres (EV_TEST_PG_URL), DATABASE_URL via the neon shim
 * for the in-process router (push fakes). Skips (exit 0) when EV_TEST_BASE_URL is unset.
 *
 * Mutation checks:
 *  - drop `accepted_at IS NULL AND declined_at IS NULL` from the accept UPDATE → "double accept: exactly one 200" fails.
 *  - drop the member check in the lookup → "someone else's invite is 404" fails.
 *  - drop the ends_at check for event invites → "accept after the event ended is 409" fails.
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

  const P = `di${Date.now().toString(36)}`;
  const mkUser = async (s: string, o: { first?: string | null; name?: string } = {}) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, o.name ?? `Person ${s}`, o.first === undefined ? `First${s}` : o.first, username],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host", { name: "Hosty", first: "Realfirst" });
  const ana = await mkUser("ana", { first: "Ana" });
  const bo = await mkUser("bo", { first: null });
  const cy = await mkUser("cy");
  const stranger = await mkUser("str");
  const mkEvent = async (startsH: number, endsH: number, title: string, status = "published") => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, now() + ($6 || ' hours')::interval, 'America/New_York') RETURNING id`,
    [host.id, `${P}-${Math.random().toString(36).slice(2, 8)}`, title, status, String(startsH), String(endsH)],
  ))[0].id as string;
  const evA = await mkEvent(-1, 2, `${P} Alpha`);
  const evB = await mkEvent(24, 28, `${P} Beta`);
  const evC = await mkEvent(48, 52, `${P} Gamma`);
  const evDraft = await mkEvent(30, 34, `${P} Draft`, "draft");
  const eventIds = [evA, evB, evC, evDraft];
  const ht = tok(host.id);
  const invite = async (ev: string, username: string, scope: "standing" | "event") => {
    const r = await call("POST", `/api/events/${ev}/door/team`, { token: ht, body: { username, scope } });
    if (r.status !== 201) throw new Error(`invite failed: ${r.raw}`);
    return String(r.body.member.inviteId);
  };
  const mine = (u: string) => call("GET", "/api/events/door/mine", { token: tok(u) });
  const scans = async (u: string, ev: string) => (await call("GET", `/api/events/${ev}/door/guests`, { token: tok(u) })).status === 200;

  // In-process router for the host's accept push.
  const express = (await import("express")).default;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  const pushes: any[] = [];
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p) => { pushes.push(p); return true; }, createActivity: async () => {}, sendDoorInvite: async () => {},
  });
  const { default: doorRouter } = await import("./doorRouter");
  const app = express();
  app.use(express.json());
  app.use("/api/events", doorRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const LOCAL = `http://127.0.0.1:${(srv.address() as any).port}`;

  try {
    console.log("\nlist");
    const anaStanding = await invite(evA, ana.username, "standing");
    const anaEvent = await invite(evB, ana.username, "event");
    let r = await call("GET", "/api/events/door/invites", { token: tok(ana.id) });
    assert(r.status === 200 && r.body.success && r.body.invites.length === 2, "two open invites", r.body);
    const st = r.body.invites.find((i: any) => i.id === anaStanding);
    const ev = r.body.invites.find((i: any) => i.id === anaEvent);
    assert(st?.scope === "standing" && st.role === "door" && st.status === "invited" && !!st.invitedAt && st.host?.name === "Hosty" && st.event === null, "standing invite shape", st);
    assert(Array.isArray(st?.upcoming) && st.upcoming.map((e: any) => e.id).join() === [evA, evB, evC].join(), "standing invite lists the host's published, not ended events by start (no draft)", st?.upcoming);
    assert(st?.upcoming.every((e: any) => e.title && e.startsAt && e.timezone), "upcoming rows have title, start and zone", st?.upcoming);
    assert(ev?.scope === "event" && ev.event?.id === evB && ev.event.title === `${P} Beta` && !!ev.event.startsAt && !!ev.event.endsAt && ev.event.timezone === "America/New_York" && ev.upcoming.length === 0, "event invite shape", ev);
    assert(!/@test\.local|realfirst|email/i.test(r.raw), "no emails and never the host's real first name", null);
    r = await call("GET", "/api/events/door/invites", { token: tok(stranger.id) });
    assert(r.status === 200 && r.body.invites.length === 0, "a stranger has none", r.body);
    r = await call("GET", "/api/events/door/invites");
    assert(r.status === 401, "signed out is 401", r.status);

    console.log("\nget one");
    r = await call("GET", `/api/events/door/invites/${anaEvent}`, { token: tok(ana.id) });
    assert(r.status === 200 && r.body.invite.id === anaEvent && r.body.invite.status === "invited", "get my invite", r.body);
    r = await call("GET", `/api/events/door/invites/${anaEvent}`, { token: tok(stranger.id) });
    assert(r.status === 404 && r.body.error.code === "INVITE_NOT_FOUND", "someone else's invite is 404", r.body);
    r = await call("GET", `/api/events/door/invites/${anaEvent}`, { token: ht });
    assert(r.status === 404, "even the host can't open the invitee's invite view", r.body);
    r = await call("GET", `/api/events/door/invites/00000000-0000-0000-0000-000000000000`, { token: tok(ana.id) });
    assert(r.status === 404 && r.body.error.code === "INVITE_NOT_FOUND", "unknown id is 404", r.body);
    r = await call("GET", `/api/events/door/invites/${"x".repeat(40)}`, { token: tok(ana.id) });
    assert(r.status === 404, "overlong id is 404", r.status);

    console.log("\naccept");
    assert(!(await scans(ana.id, evA)), "before accepting: can't scan");
    pushes.length = 0;
    r = await callAt(LOCAL, "POST", `/api/events/door/invites/${anaStanding}/accept`, { token: tok(ana.id) });
    await sleep(300);
    assert(r.status === 200 && r.body.invite.status === "accepted", "accept", r.body);
    assert(await scans(ana.id, evA), "after accepting: can scan the host's events");
    r = await mine(ana.id);
    assert(r.body.events.some((e: any) => e.id === evA && e.role === "standing"), "/door/mine lists the host's event", r.body);
    assert(pushes.length === 1 && pushes[0].userId === host.id && pushes[0].title === "Ana joined your door team" && pushes[0].body === "They can scan tickets for all your events.", "host gets one push on accept", pushes);
    assert(pushes[0]?.data?.type === "door_team_accepted" && pushes[0].data.eventId === null, "standing accept push data", pushes[0]?.data);
    r = await call("POST", `/api/events/door/invites/${anaStanding}/accept`, { token: tok(ana.id) });
    assert(r.status === 409 && r.body.error.code === "INVITE_CLOSED" && r.body.error.message === "This invite is no longer open.", "accept again is 409 INVITE_CLOSED", r.body);
    r = await call("GET", "/api/events/door/invites", { token: tok(ana.id) });
    assert(r.body.invites.length === 1 && r.body.invites[0].id === anaEvent, "accepted invites leave the open list", r.body);
    pushes.length = 0;
    r = await callAt(LOCAL, "POST", `/api/events/door/invites/${anaEvent}/accept`, { token: tok(ana.id) });
    await sleep(300);
    assert(r.status === 200 && pushes[0]?.body === `They can scan tickets for ${P} Beta.` && pushes[0].data.eventId === evB, "event accept push copy and event id", pushes);
    r = await call("POST", `/api/events/door/invites/${anaEvent}/accept`, { token: tok(stranger.id) });
    assert(r.status === 404, "a stranger can't accept someone's invite", r.body);

    console.log("\ndouble accept (parallel)");
    const boEvent = await invite(evA, bo.username, "event");
    pushes.length = 0;
    const both = await Promise.all([1, 2].map(() => callAt(LOCAL, "POST", `/api/events/door/invites/${boEvent}/accept`, { token: tok(bo.id) })));
    await sleep(300);
    const codes = both.map((x) => x.status).sort();
    assert(codes.join() === "200,409", "double accept: exactly one 200", codes);
    assert(pushes.length === 1 && pushes[0].title === `@${bo.username} joined your door team`, "one host push, named by @username without a first name", pushes);

    console.log("\ndecline");
    const cyEvent = await invite(evA, cy.username, "event");
    pushes.length = 0;
    r = await callAt(LOCAL, "POST", `/api/events/door/invites/${cyEvent}/decline`, { token: tok(cy.id) });
    await sleep(200);
    assert(r.status === 200 && r.body.invite.status === "declined" && pushes.length === 0, "decline: no host notice", { r: r.body, pushes });
    assert(!(await scans(cy.id, evA)), "declined: can't scan");
    r = await call("POST", `/api/events/door/invites/${cyEvent}/accept`, { token: tok(cy.id) });
    assert(r.status === 409 && r.body.error.code === "INVITE_CLOSED", "accept after decline is 409", r.body);
    r = await call("GET", `/api/events/${evA}/door/team`, { token: ht });
    assert(r.body.event.find((m: any) => m.userId === cy.id)?.status === "declined", "host sees Said no", r.body);
    await invite(evA, cy.username, "event");
    r = await call("POST", `/api/events/door/invites/${cyEvent}/accept`, { token: tok(cy.id) });
    assert(r.status === 200, "invite again, then accept the same invite id", r.body);

    console.log("\ncancelled and ended invites");
    const stEvent = await invite(evC, stranger.username, "event");
    r = await call("DELETE", `/api/events/${evC}/door/team/${stranger.id}?scope=event`, { token: ht });
    assert(r.status === 200, "host cancels the invite", r);
    r = await call("GET", `/api/events/door/invites/${stEvent}`, { token: tok(stranger.id) });
    assert(r.status === 200 && r.body.invite.status === "gone", "a cancelled invite shows as gone", r.body);
    r = await call("POST", `/api/events/door/invites/${stEvent}/accept`, { token: tok(stranger.id) });
    assert(r.status === 409 && r.body.error.code === "INVITE_CLOSED", "accept after the host cancelled is 409", r.body);
    assert(!(await scans(stranger.id, evC)), "no access after a cancelled invite");
    const evSoon = await mkEvent(0, 0.001, `${P} Short`);
    eventIds.push(evSoon);
    const soon = await invite(evSoon, stranger.username, "event");
    await sleep(4000);
    r = await call("GET", "/api/events/door/invites", { token: tok(stranger.id) });
    assert(!r.body.invites.some((i: any) => i.id === soon), "an ended event's invite leaves the open list", r.body);
    r = await call("GET", `/api/events/door/invites/${soon}`, { token: tok(stranger.id) });
    assert(r.body.invite?.status === "gone", "an ended event's invite is gone", r.body);
    r = await call("POST", `/api/events/door/invites/${soon}/accept`, { token: tok(stranger.id) });
    assert(r.status === 409, "accept after the event ended is 409", r.body);
    await q(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [evC]);
    const cyC = await (async () => { await q(`UPDATE events SET status = 'published' WHERE id = $1`, [evC]); const id = await invite(evC, cy.username, "event"); await q(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [evC]); return id; })();
    r = await call("POST", `/api/events/door/invites/${cyC}/accept`, { token: tok(cy.id) });
    assert(r.status === 409, "accept for a cancelled event is 409", r.body);
    await q(`UPDATE events SET status = 'published' WHERE id = $1`, [evC]);

    console.log("\nleave");
    r = await call("POST", `/api/events/door/invites/${anaStanding}/leave`, { token: tok(ana.id) });
    assert(r.status === 200 && r.body.invite.status === "gone", "leave", r.body);
    assert(!(await scans(ana.id, evA)), "after leaving: no access on the next call");
    const [left] = await q(`SELECT removed_by_user_id FROM event_door_team WHERE id = $1`, [anaStanding]);
    assert(left.removed_by_user_id === ana.id, "leave records the member", left);
    r = await call("POST", `/api/events/door/invites/${anaStanding}/leave`, { token: tok(ana.id) });
    assert(r.status === 409 && r.body.error.code === "NOT_ON_TEAM", "leave twice is 409 NOT_ON_TEAM", r.body);
    const cy2 = await invite(evB, cy.username, "standing");
    r = await call("POST", `/api/events/door/invites/${cy2}/leave`, { token: tok(cy.id) });
    assert(r.status === 409 && r.body.error.code === "NOT_ON_TEAM", "a pending invite can't be left (decline it)", r.body);
    r = await call("POST", `/api/events/door/invites/${cy2}/leave`, { token: tok(stranger.id) });
    assert(r.status === 404, "a stranger can't leave for someone", r.body);

    console.log("\nroute table");
    const paths: [string, string, number[]][] = [
      ["GET", "/api/events/me/tickets", [200]], ["GET", "/api/events/mine", [200]], ["GET", "/api/events/payouts/status", [200]],
      ["GET", `/api/events/slug/nope-${P}`, [404]], ["GET", `/api/events/${evA}/orders`, [200]], ["GET", "/api/events/door/mine", [200]],
      ["GET", `/api/events/${evA}/door/team`, [200]], ["GET", `/api/events/${evA}/manage`, [200]],
    ];
    for (const [m, p, ok] of paths) {
      r = await call(m, p, { token: ht });
      assert(ok.includes(r.status), `${m} ${p} still answers (${r.status})`, r.raw.slice(0, 200));
    }
  } finally {
    setNoticeDepsForTest(null);
    srv.close();
    await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM event_door_team WHERE host_user_id = $1`, [host.id]);
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1) OR triggered_by_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
