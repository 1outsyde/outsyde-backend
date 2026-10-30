/**
 * Events door check-in Task 2: door team management routes. p4-scanner (migration 075): adding someone sends an
 * invite (push, Activity item, email while the daily budget lasts); they can scan only after accepting.
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
 *  - send the email without the 24 hour guard → "no second email within 24 hours" fails.
 *  - drop the email_log ceiling → "over the daily email budget: no email" fails.
 *  - reset accepted rows on invite again → "accepted is 409 ALREADY_ON_TEAM" fails.
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
  const mkUser = async (s: string, o: { active?: boolean; first?: string; name?: string } = {}) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
      [`${P}-${s}@test.local`, o.name ?? `Person ${s} Last`, o.first ?? `First${s}`, username, o.active ?? true],
    ))[0].id as string;
    return { id, username };
  };
  // Display name "Hosty" (users.name); the real first name must not be used in copy.
  const host = await mkUser("host", { name: "Hosty", first: "Realfirst" });
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
  const evCancelled = await mkEvent(host.id, 24, 28, `${P} Cancelled`, "cancelled");
  const eventIds = [evA, evB, evEnded, evDraft, evOther, evCancelled];
  const ht = tok(host.id);
  const add = (ev: string, username: string, scope: string, token = ht) => call("POST", `/api/events/${ev}/door/team`, { token, body: { username, scope } });
  // Accept / decline straight in the DB (the member routes are tested in doorInvites.http.test.ts).
  const acceptStanding = (m: string) => q(`UPDATE event_door_team SET accepted_at = now() WHERE host_user_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [host.id, m]);
  const acceptEvent = (ev: string, m: string) => q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [ev, m]);
  const declineEvent = (ev: string, m: string) => q(`UPDATE event_door_members SET declined_at = now() WHERE event_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [ev, m]);

  // In-process app for push checks
  const express = (await import("express")).default;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  const pushes: any[] = [];
  const activities: any[] = [];
  const emails: any[] = [];
  const recording = {
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async (p: any) => { activities.push(p); },
    sendDoorInvite: async (p: any) => { emails.push(p); },
  };
  setNoticeDepsForTest(recording);
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
    assert(r.body.member?.userId === m1.id && r.body.member.firstName === "Firstm1" && r.body.member.username === m1.username && !!r.body.member.addedAt, "member shape (old keys kept)", r.body);
    assert(r.body.member.status === "invited" && typeof r.body.member.inviteId === "string" && !!r.body.member.invitedAt, "add sends an invite: status invited, inviteId, invitedAt", r.body);
    const [m1row] = await q(`SELECT id, accepted_at, role FROM event_door_team WHERE host_user_id = $1 AND member_user_id = $2`, [host.id, m1.id]);
    assert(m1row.id === r.body.member.inviteId && m1row.accepted_at === null && m1row.role === "door", "row is a pending door invite", m1row);
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
    assert(r.status === 409 && r.body.error.code === "ALREADY_INVITED" && r.body.error.message === "You already invited them for Admissions.", "pending standing invite again is 409 ALREADY_INVITED", r);
    r = await add(evA, m2.username, "event");
    assert(r.status === 409 && r.body.error.code === "ALREADY_INVITED", "pending event invite again is 409 ALREADY_INVITED", r);
    await acceptStanding(m1.id);
    await acceptEvent(evA, m2.id);
    r = await add(evA, m1.username, "standing");
    assert(r.status === 409 && r.body.error.code === "ALREADY_ON_TEAM", "accepted standing member is 409 ALREADY_ON_TEAM", r);
    r = await add(evA, m2.username, "event");
    assert(r.status === 409 && r.body.error.code === "ALREADY_ON_TEAM", "accepted event member is 409 ALREADY_ON_TEAM", r);
    assert((await q(`SELECT accepted_at FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [evA, m2.id]))[0].accepted_at !== null, "a repeat add never resets an accepted row");
    r = await add(evEnded, m3.username, "event");
    assert(r.status === 409 && r.body.error.code === "EVENT_ENDED" && r.body.error.message === "This event is over, so no one can be added to its Event team.", "event scope on an ended event is EVENT_ENDED", r);
    r = await add(evCancelled, m3.username, "event");
    assert(r.status === 409 && r.body.error.code === "EVENT_ENDED", "event scope on a cancelled event is EVENT_ENDED", r);
    assert((await q(`SELECT 1 FROM event_door_members WHERE event_id = ANY($1)`, [[evEnded, evCancelled]])).length === 0, "nothing was inserted for ended or cancelled events");
    r = await add(evEnded, m3.username, "standing");
    assert(r.status === 201, "standing scope is still allowed from an ended event's screen", r);
    await q(`UPDATE event_door_team SET removed_at = now() WHERE host_user_id = $1 AND member_user_id = $2`, [host.id, m3.id]);
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
    assert(r.body.standing[0].status === "accepted" && r.body.event[0].status === "accepted" && !!r.body.event[0].inviteId, "list shows accepted status and inviteId", r.body);
    r = await call("GET", `/api/events/${evB}/door/team`, { token: ht });
    assert(r.body.standing.length === 1 && r.body.event.length === 0, "event members are per event, standing is per host", r.body);

    console.log("\ninvite again after a no");
    r = await add(evB, m3.username, "event");
    assert(r.status === 201 && r.body.member.status === "invited", "invite m3 to Beta", r);
    const firstId = r.body.member.inviteId;
    const firstAt = r.body.member.invitedAt;
    await declineEvent(evB, m3.id);
    r = await call("GET", `/api/events/${evB}/door/team`, { token: ht });
    assert(r.body.event.length === 1 && r.body.event[0].status === "declined", "the host sees a decline (Said no)", r.body);
    await sleep(20);
    r = await add(evB, m3.username, "event");
    assert(r.status === 201 && r.body.member.status === "invited" && r.body.member.inviteId === firstId, "invite again reuses the same row", r);
    assert(new Date(r.body.member.invitedAt).getTime() > new Date(firstAt).getTime(), "invite again moves invitedAt", r.body);
    const [again] = await q(`SELECT declined_at, accepted_at FROM event_door_members WHERE id = $1`, [firstId]);
    assert(again.declined_at === null && again.accepted_at === null, "invite again clears the decline", again);
    r = await call("DELETE", `/api/events/${evB}/door/team/${m3.id}?scope=event`, { token: ht });
    assert(r.status === 200, "cancel a pending invite (same DELETE as remove)", r);
    const [cancelled] = await q(`SELECT removed_at, removed_by_user_id FROM event_door_members WHERE id = $1`, [firstId]);
    assert(!!cancelled.removed_at && cancelled.removed_by_user_id === host.id, "cancel records who removed it", cancelled);

    console.log("\nmine");
    r = await call("GET", "/api/events/door/mine", { token: tok(m1.id) });
    const ids = (r.body.events ?? []).map((e: any) => e.id);
    assert(r.status === 200 && ids.includes(evA) && ids.includes(evB), "standing member sees the host's published events", r.body);
    assert(!ids.includes(evEnded) && !ids.includes(evDraft) && !ids.includes(evOther), "no ended, draft or other host events", ids);
    const row = r.body.events.find((e: any) => e.id === evA);
    assert(row?.role === "standing" && row.title && row.slug && row.startsAt && row.endsAt && row.timezone, "event row shape", row);
    const [m1inv] = await q(`SELECT id FROM event_door_team WHERE host_user_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [host.id, m1.id]);
    assert(row?.inviteId === m1inv.id, "/door/mine gives a member the invite id (for Leave)", row);
    r = await call("GET", "/api/events/door/mine", { token: tok(m2.id) });
    assert((r.body.events ?? []).length === 1 && r.body.events[0].id === evA && r.body.events[0].role === "event", "event member sees only that event", r.body);
    assert(typeof r.body.events[0]?.inviteId === "string", "event member row has its invite id", r.body);
    r = await call("GET", "/api/events/door/mine", { token: tok(stranger.id) });
    assert(r.status === 200 && r.body.events.length === 0, "stranger sees none", r.body);
    r = await call("GET", "/api/events/door/mine", { token: ht });
    const hostA = (r.body.events ?? []).find((e: any) => e.id === evA);
    assert(r.status === 200 && !!hostA && hostA.role === "host", "host sees their own published, not-ended event with role host", r.body);
    assert(hostA?.inviteId === null, "the host's own row has no invite id", hostA);

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
    assert(r.status === 201 && r.body.member.status === "invited", "re-add after remove sends a new invite", r);
    const hist = await q(`SELECT count(*)::int AS n FROM event_door_members WHERE event_id = $1 AND member_user_id = $2`, [evA, m2.id]);
    assert(hist[0].n === 2, "removal keeps history (soft remove)", hist);
    r = await call("DELETE", `/api/events/${evA}/door/team/${m1.id}?scope=standing`, { token: ht });
    assert(r.status === 200, "remove standing member", r);
    assert((await q(`SELECT removed_by_user_id FROM event_door_team WHERE host_user_id = $1 AND member_user_id = $2 ORDER BY created_at DESC LIMIT 1`, [host.id, m1.id]))[0].removed_by_user_id === host.id, "remove records the host");
    r = await call("GET", "/api/events/door/mine", { token: tok(m1.id) });
    assert(r.body.events.length === 0, "removed standing member sees nothing", r.body);

    console.log("\nnotices (in-process router, recording fakes)");
    const clear = () => { pushes.length = 0; activities.length = 0; emails.length = 0; };
    clear();
    const lt = (id: string) => tok(id);
    const ladd = (ev: string, username: string, scope: string, as = host.id) => callAt(LOCAL, "POST", `/api/events/${ev}/door/team`, { token: lt(as), body: { username, scope } });
    r = await ladd(evA, m3.username, "event");
    await sleep(300);
    const inviteId = r.body?.member?.inviteId;
    assert(r.status === 201 && pushes.length === 1 && activities.length === 1 && emails.length === 1, "one push, one Activity item, one email per invite", { status: r.status, p: pushes.length, a: activities.length, e: emails.length });
    assert(pushes[0]?.userId === m3.id && pushes[0].title === "Hosty invited you to their Event team for Admissions" && pushes[0].body === "Tap to accept or decline.", "push copy uses the host's public name", pushes[0]);
    assert(pushes[0]?.data?.type === "door_team_invite" && pushes[0].data.inviteId === inviteId, "push data opens the invite", pushes[0]?.data);
    assert(activities[0]?.userId === m3.id && activities[0].type === "door_team_invite" && activities[0].referenceType === "event_door_invite" && activities[0].referenceId === inviteId, "Activity item points at the invite", activities[0]);
    assert(activities[0]?.title === "Hosty invited you to their Event team for Admissions" && activities[0].message === `Only this event: ${P} Alpha.` && activities[0].metadata?.inviteId === inviteId && activities[0].metadata?.scope === "event", "Activity copy and metadata", activities[0]);
    assert(activities[0]?.triggeredByUserId === host.id, "Activity names the host as the one who acted", activities[0]);
    assert(emails[0]?.toEmail === `${P}-m3@test.local` && emails[0].firstName === "Firstm3" && emails[0].hostName === "Hosty" && emails[0].scope === "event" && emails[0].eventTitle === `${P} Alpha` && emails[0].doorUrl === "https://goutsyde.test/events/door", "email params", emails[0]);
    assert(typeof emails[0]?.whenText === "string" && emails[0].whenText.length > 0, "email has the event time", emails[0]);
    assert(!/[–—]| - /.test(pushes[0].title + pushes[0].body + activities[0].message), "no dashes in copy");
    assert(!/realfirst/i.test(JSON.stringify([pushes, activities, emails])), "the host's real first name is never used");
    clear();
    r = await ladd(evA, m3.username, "event");
    await sleep(200);
    assert(r.status === 409 && pushes.length + activities.length + emails.length === 0, "a repeat invite sends nothing", { status: r.status });
    await declineEvent(evA, m3.id);
    clear();
    r = await ladd(evA, m3.username, "event");
    await sleep(300);
    assert(r.status === 201 && pushes.length === 1 && activities.length === 1, "invite again after a no: push and Activity again", { p: pushes.length, a: activities.length });
    assert(emails.length === 0, "no second email within 24 hours for the same invite", emails);
    clear();
    r = await ladd(evEnded, m3.username, "event");
    await sleep(200);
    assert(r.status === 409 && r.body.error.code === "EVENT_ENDED" && pushes.length === 0, "EVENT_ENDED sends nothing", { status: r.status, pushes });
    clear();
    const m4 = await mkUser("m4");
    r = await ladd(evA, m4.username, "standing");
    await sleep(300);
    assert(r.status === 201 && pushes.length === 1 && pushes[0].title === "Hosty invited you to their Event team for Admissions", "standing invite push", pushes[0]);
    assert(activities[0]?.message === "All of Hosty's events." && activities[0].metadata?.scope === "standing", "standing Activity copy", activities[0]);
    assert(emails[0]?.scope === "standing" && emails[0].eventTitle === null, "standing email has no single event", emails[0]);
    clear();
    await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(host.id), body: { username: host.username, scope: "standing" } });
    await callAt(LOCAL, "POST", `/api/events/${evA}/door/team`, { token: lt(stranger.id), body: { username: m3.username, scope: "event" } });
    await sleep(200);
    assert(pushes.length + activities.length + emails.length === 0, "no notices on self or non-host", pushes);

    console.log("\ninvite email (render)");
    const { renderDoorTeamInvite } = await import("../emailService");
    const evMail = renderDoorTeamInvite({ toEmail: "x@test.local", firstName: "Ana<b>", hostName: "Club & Co", scope: "event", eventTitle: "Late <Night>", whenText: "Saturday, October 31 at 9:00 PM EDT", doorUrl: "https://goutsyde.test/events/door" });
    assert(evMail.subject === "Club & Co invited you to their Event team for Admissions", "email subject", evMail.subject);
    assert(evMail.html.includes("Hi Ana&lt;b&gt;, you&#39;re invited to the Event team") || evMail.html.includes("Hi Ana&lt;b&gt;, you're invited to the Event team"), "greeting escapes the first name", evMail.html.slice(0, 2000));
    assert(evMail.html.includes("Club &amp; Co wants you on Admissions for <strong>Late &lt;Night&gt;</strong> on Saturday, October 31 at 9:00 PM EDT, checking guests in at the door."), "event line escapes host and title", evMail.html.slice(0, 3000));
    assert(!evMail.html.includes("won't see") && !evMail.html.includes("won&#39;t see"), "no \"you won't see\" line (decision 7)", null);
    assert(evMail.html.includes('href="https://goutsyde.test/events/door"') && evMail.html.includes("Accept or decline"), "button opens goutsyde.com/events/door", null);
    assert(evMail.html.includes("Nothing changes unless you accept."), "ignore line", null);
    const stMail = renderDoorTeamInvite({ toEmail: "x@test.local", firstName: null, hostName: "Hosty", scope: "standing", eventTitle: null, whenText: null, doorUrl: "https://goutsyde.test/events/door" });
    assert(stMail.html.includes("Hosty wants you on Admissions for their events, checking guests in at the door."), "standing line", null);
    assert(!/[–—]/.test(evMail.html + stMail.html) && !/%/.test(evMail.subject), "no dashes, no percentages", null);

    console.log("\ndaily email budget");
    const BUDGET_LABEL = `${P}-budget`;
    await q(`INSERT INTO email_log (kind, label, status) SELECT 'ticket', $1, 'sent' FROM generate_series(1, 70)`, [BUDGET_LABEL]);
    const m5 = await mkUser("m5");
    clear();
    r = await ladd(evA, m5.username, "event");
    await sleep(300);
    assert(r.status === 201 && pushes.length === 1 && activities.length === 1, "over the daily email budget: push and Activity still go", { p: pushes.length, a: activities.length });
    assert(emails.length === 0, "over the daily email budget: no email", emails);
    assert((await q(`SELECT invite_emailed_at FROM event_door_members WHERE event_id = $1 AND member_user_id = $2`, [evA, m5.id]))[0].invite_emailed_at === null, "no email claimed when over budget");
    await q(`DELETE FROM email_log WHERE label = $1`, [BUDGET_LABEL]);

    console.log("\nfailures never fail the invite");
    setNoticeDepsForTest({ ...recording, sendPush: async () => { throw new Error("expo down"); }, createActivity: async () => { throw new Error("db down"); }, sendDoorInvite: async () => { throw new Error("resend down"); } });
    await q(`UPDATE event_door_members SET removed_at = now() WHERE event_id = $1 AND member_user_id = $2`, [evA, m3.id]);
    r = await ladd(evA, m3.username, "event");
    assert(r.status === 201, "failing push, Activity and email don't fail the invite", r);
    setNoticeDepsForTest(recording);

    console.log("\ncancel then invite again (review #1: no spam loop)");
    const m6 = await mkUser("m6");
    clear();
    r = await ladd(evA, m6.username, "event");
    await sleep(300);
    assert(r.status === 201 && pushes.length === 1 && emails.length === 1 && activities.length === 1, "first invite: push, email, Activity", { p: pushes.length, e: emails.length, a: activities.length });
    clear();
    r = await callAt(LOCAL, "DELETE", `/api/events/${evA}/door/team/${m6.id}?scope=event`, { token: lt(host.id) });
    assert(r.status === 200, "host cancels the invite", r);
    r = await ladd(evA, m6.username, "event");
    await sleep(300);
    assert(r.status === 201 && emails.length === 0, "cancel then invite again within 24 hours: no second email", emails);
    assert(pushes.length === 0, "cancel then invite again within 10 minutes: no second push", pushes);
    assert(activities.length === 1, "the new invite still gets its own Activity item (the old one points at a cancelled invite)", activities.length);

    console.log("\nper host daily invite email cap (10)");
    const host3 = await mkUser("host3", { name: "Hostthree" });
    const evH3 = await mkEvent(host3.id, 24, 28, `${P} H3`);
    eventIds.push(evH3);
    clear();
    for (let i = 0; i < 11; i++) {
      const u = await mkUser(`cap${i}`);
      r = await ladd(evH3, u.username, "event", host3.id);
      assert(r.status === 201, `cap invite ${i + 1} sent`, r.status);
    }
    await sleep(800);
    assert(emails.length === 10, "only 10 invite emails a day per host", emails.length);
    assert(pushes.length === 11 && activities.length === 11, "push and Activity still go for the 11th", { p: pushes.length, a: activities.length });

    console.log("\nrate limit (30 invites an hour per host)");
    const host2 = await mkUser("host2", { name: "Hosttwo" });
    const evH2 = await mkEvent(host2.id, 24, 28, `${P} H2`);
    eventIds.push(evH2);
    let last = 0;
    for (let i = 0; i < 30; i++) last = (await ladd(evH2, `nobody${i}_${P}`, "event", host2.id)).status;
    assert(last === 404, "30 tries in an hour still answer normally", last);
    r = await ladd(evH2, `nobody31_${P}`, "event", host2.id);
    assert(r.status === 429 && r.body.error.code === "RATE_LIMITED", "the 31st invite in an hour is 429", r);
    r = await callAt(LOCAL, "GET", `/api/events/${evH2}/door/team`, { token: lt(host2.id) });
    assert(r.status === 200, "listing the team isn't rate limited by invites", r);
  } finally {
    setNoticeDepsForTest(null);
    srv.close();
    await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM email_log WHERE label = $1`, [`${P}-budget`]).catch(() => {});
    await q(`DELETE FROM event_door_team WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1) OR triggered_by_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
