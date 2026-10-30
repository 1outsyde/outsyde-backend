/**
 * p4-team step 2b: co-host access. The host picks a level per co-host:
 *   team  sees everything (manage, sales summary with earnings and deductions, orders, guest list, team), scans,
 *         undoes a check in, invites and removes team members for this event, sets their times
 *   edit  all of team, plus event details (not the refund policy) and ticket types
 * Never a co-host: publish, cancel, refunds, payouts, the standing team, other co-hosts.
 * Team changes a co-host makes are saved under the event's host, never under the co-host.
 *
 * SCRATCH ONLY. Local scratch Postgres with migrations through 084 (EV_TEST_PG_URL, localhost only) and DATABASE_URL
 * via the neon shim preload. Runs the event routers in this process. Skips when EV_TEST_PG_URL is unset.
 *
 * Mutation checks:
 *  - loadEventAccess without `accepted_at IS NOT NULL` → "pending co-host: no access" fails.
 *  - summary back on loadEventForHost → "co-host sees the sales summary" fails.
 *  - team list reading the caller's standing team (ctx.userId) → "team list shows the host's standing team" fails.
 *  - drop the standing scope check for co-hosts → "co-host can't change the standing team" fails.
 *  - drop the level check on PATCH → "team level can't edit the event" fails.
 *  - drop the refund policy check → "refund policy stays the host's" fails.
 */
import http from "http";

const PG_URL = process.env.EV_TEST_PG_URL;
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

function callAt(base: string, method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL (+ DATABASE_URL via the shim) to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const express = (await import("express")).default;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  const pushes: any[] = [];
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async () => {}, sendDoorInvite: async () => {},
  } as any);
  const app = express();
  app.use(express.json());
  // Same order as server/index.ts.
  app.use("/api/events", (await import("./doorRouter")).default);
  app.use("/api/events", (await import("./eventsRouter")).default);
  app.use("/api/events", (await import("./ticketsRouter")).default);
  app.use("/api/events", (await import("./ticketRefunds")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `co${Date.now().toString(36)}`;
  const mkUser = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host");
  const coT = await mkUser("cot");     // co-host, this event, team level (default)
  const coE = await mkUser("coe");     // co-host, this event, edit level
  const coS = await mkUser("cos");     // standing co-host (all the host's events)
  const pend = await mkUser("pend");   // co-host invite not accepted
  const door = await mkUser("door");
  const stranger = await mkUser("str");
  const sec = await mkUser("sec");
  const sec2 = await mkUser("sec2");
  const mkEvent = async (slug: string, status: string, startOffsetH: number) => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, now() + ($5 || ' hours')::interval + interval '4 hours', 'America/New_York') RETURNING id`,
    [host.id, `${P}-${slug}`, `${P} ${slug}`, status, String(startOffsetH)],
  ))[0].id as string;
  const ev = await mkEvent("live", "published", -1);
  const draft = await mkEvent("draft", "draft", 48);
  const ht = tok(host.id);
  const inviteBy = (token: string, body: Record<string, unknown>, eventId = ev) => call("POST", `/api/events/${eventId}/door/team`, { token, body });
  const accept = async () => {
    await q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = $1 AND accepted_at IS NULL AND declined_at IS NULL AND member_user_id <> $2`, [ev, pend.id]);
    await q(`UPDATE event_door_team SET accepted_at = now() WHERE host_user_id = $1 AND accepted_at IS NULL AND declined_at IS NULL AND member_user_id <> $2`, [host.id, pend.id]);
  };

  try {
    console.log("\ninviting co-hosts with a level");
    let r = await inviteBy(ht, { username: coT.username, scope: "event", role: "cohost" });
    assert(r.status === 201 && r.body?.member?.cohostLevel === "team", "no level sent: team", r.body);
    r = await inviteBy(ht, { username: coE.username, scope: "event", role: "cohost", cohostLevel: "edit" });
    assert(r.status === 201 && r.body?.member?.cohostLevel === "edit", "edit level", r.body);
    r = await inviteBy(ht, { username: coS.username, scope: "standing", role: "cohost", cohostLevel: "edit" });
    assert(r.status === 201, "standing co-host", r.body);
    r = await inviteBy(ht, { username: pend.username, scope: "event", role: "cohost" });
    assert(r.status === 201, "pending co-host", r.body);
    r = await inviteBy(ht, { username: sec.username, scope: "event", role: "security", cohostLevel: "edit" });
    assert(r.status === 400 && /cohostLevel/.test(r.body?.error?.message), "a level only for co-hosts", r.body);
    r = await inviteBy(ht, { username: door.username, scope: "event" });
    assert(r.status === 201 && r.body?.member?.cohostLevel === null, "door invite: no level", r.body);
    await accept();

    console.log("\nwhat a co-host sees");
    const manage = (u: string, id = ev) => call("GET", `/api/events/${id}/manage`, { token: tok(u) });
    r = await manage(coT.id);
    assert(r.status === 200 && r.body?.event?.id === ev && r.body?.access?.as === "cohost" && r.body?.access?.level === "team", "co-host opens the event", r.body?.access);
    r = await manage(host.id);
    assert(r.status === 200 && r.body?.access?.as === "host" && r.body?.access?.level === null, "host: access says host", r.body?.access);
    assert((await manage(pend.id)).status === 404, "pending co-host: no access");
    assert((await manage(door.id)).status === 404, "Admissions: no event management");
    assert((await manage(stranger.id)).status === 404, "stranger: 404");
    r = await manage(coS.id, draft);
    assert(r.status === 200 && r.body?.access?.level === "edit", "standing co-host opens every event of the host, drafts too", r.body?.access);
    r = await call("GET", `/api/events/${ev}/summary`, { token: tok(coT.id) });
    assert(r.status === 200 && "hostEarningsCents" in (r.body?.totals ?? {}) && "deductedCents" in (r.body?.payout ?? {}), "co-host sees the sales summary with earnings and deductions", r.body);
    r = await call("GET", `/api/events/${ev}/orders`, { token: tok(coT.id) });
    assert(r.status === 200 && Array.isArray(r.body?.orders), "co-host sees orders", r.body);
    r = await call("GET", `/api/events/${ev}/door/guests`, { token: tok(coT.id) });
    assert(r.status === 200, "co-host sees the guest list", r.body);
    r = await call("POST", `/api/events/${ev}/door/check-in`, { token: tok(coT.id), body: { code: "ZZZZZZZZZZZZZZZZ" } });
    assert(r.status === 404 && r.body?.error?.code === "NOT_FOUND", "co-host can scan (unknown code is NOT_FOUND)", r.body);
    r = await call("GET", `/api/events/${ev}/door/team?roles=all`, { token: tok(coT.id) });
    assert(r.status === 200 && (r.body?.event ?? []).some((m: any) => m.userId === door.id), "co-host sees the team", r.body);
    assert((r.body?.standing ?? []).some((m: any) => m.userId === coS.id), "team list shows the host's standing team, not the co-host's", r.body?.standing);
    r = await call("GET", "/api/events/cohosting", { token: tok(coT.id) });
    assert(r.status === 200 && r.body?.events?.map((e: any) => e.id).includes(ev) && !r.body.events.map((e: any) => e.id).includes(draft), "events I co-host: this event", r.body);
    assert(r.body?.events?.find((e: any) => e.id === ev)?.cohostLevel === "team", "with my level", r.body?.events);
    r = await call("GET", "/api/events/cohosting", { token: tok(coS.id) });
    const coSIds = (r.body?.events ?? []).map((e: any) => e.id);
    assert(coSIds.includes(ev) && coSIds.includes(draft), "standing co-host: every event of the host", coSIds);
    r = await call("GET", "/api/events/cohosting", { token: tok(pend.id) });
    assert(r.status === 200 && (r.body?.events ?? []).length === 0, "pending: none", r.body);
    r = await call("GET", "/api/events/door/mine", { token: tok(coT.id) });
    assert(!(r.body?.events ?? []).some((e: any) => e.id === ev), "co-host events stay off door/mine (old app scanner list)", r.body);
    const slug = (u: string | null) => call("GET", `/api/events/slug/${P}-draft`, u ? { token: tok(u) } : {});
    r = await slug(coS.id);
    assert(r.status === 200 && r.body?.event?.viewerIsCohost === true && r.body?.event?.viewerIsHost === false, "co-host can preview a draft", r.body);
    assert((await slug(stranger.id)).status === 404, "a stranger can't", null);

    console.log("\nteam changes by a co-host go to the host's team");
    r = await inviteBy(tok(coT.id), { username: sec.username, scope: "event", role: "security" });
    assert(r.status === 201, "co-host invites Security to this event", r.body);
    const row = (await q(`SELECT added_by_user_id FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND role = 'security'`, [ev, sec.id]))[0];
    assert(row?.added_by_user_id === coT.id, "the row says who added them", row);
    await sleep(200);
    assert(pushes.some((p) => p.userId === sec.id && p.title.startsWith("Person host")), "invite names the host", pushes.map((p) => p.title));
    r = await inviteBy(tok(coT.id), { username: sec2.username, scope: "standing", role: "security" });
    assert(r.status === 403 && r.body?.error?.code === "HOST_ONLY", "co-host can't change the standing team", r.body);
    assert((await q(`SELECT 1 FROM event_door_team WHERE member_user_id = $1`, [sec2.id])).length === 0, "nothing saved", null);
    assert((await q(`SELECT 1 FROM event_door_team WHERE host_user_id = $1`, [coT.id])).length === 0, "and never under the co-host", null);
    r = await inviteBy(tok(coT.id), { username: sec2.username, scope: "event", role: "cohost" });
    assert(r.status === 403 && r.body?.error?.code === "HOST_ONLY", "co-host can't add co-hosts", r.body);
    r = await inviteBy(tok(coT.id), { username: host.username, scope: "event", role: "security" });
    assert(r.status === 400 && r.body?.error?.code === "CANNOT_ADD_HOST", "can't invite the host", r.body);
    r = await call("PUT", `/api/events/${ev}/door/team/${sec.id}/schedule?role=security`, { token: tok(coT.id), body: { placeNote: "Front door" } });
    assert(r.status === 200 && r.body?.schedule?.placeNote === "Front door", "co-host sets times", r.body);
    r = await call("PUT", `/api/events/${ev}/door/team/${coE.id}/schedule?role=cohost`, { token: tok(coT.id), body: {} });
    assert(r.status === 403 && r.body?.error?.code === "HOST_ONLY", "but not for another co-host", r.body);
    r = await call("DELETE", `/api/events/${ev}/door/team/${coE.id}?scope=event&role=cohost`, { token: tok(coT.id) });
    assert(r.status === 403 && r.body?.error?.code === "HOST_ONLY", "co-host can't remove a co-host", r.body);
    r = await call("DELETE", `/api/events/${ev}/door/team/${coS.id}?scope=standing&role=cohost`, { token: tok(coT.id) });
    assert(r.status === 403, "or touch the standing team", r.body);
    r = await call("DELETE", `/api/events/${ev}/door/team/${sec.id}?scope=event&role=security`, { token: tok(coT.id) });
    assert(r.status === 200, "co-host removes Security from this event", r.body);

    console.log("\nediting the event depends on the level");
    const patch = (u: string, body: unknown) => call("PATCH", `/api/events/${ev}`, { token: tok(u), body });
    r = await patch(coT.id, { title: "Changed by team" });
    assert(r.status === 403 && r.body?.error?.code === "COHOST_EDIT_OFF", "team level can't edit the event", r.body);
    r = await patch(coE.id, { title: `${P} Edited` });
    assert(r.status === 200 && r.body?.event?.title === `${P} Edited`, "edit level edits details", r.body);
    assert((await q(`SELECT host_user_id FROM events WHERE id = $1`, [ev]))[0].host_user_id === host.id, "the event stays the host's", null);
    r = await patch(coE.id, { refundPolicy: "until_cutoff", refundCutoffHours: 24 });
    assert(r.status === 403 && r.body?.error?.code === "HOST_ONLY", "refund policy stays the host's", r.body);
    const newType = (u: string) => call("POST", `/api/events/${ev}/ticket-types`, { token: tok(u), body: { name: "Guest list", priceCents: 0, quantity: 10 } });
    r = await newType(coT.id);
    assert(r.status === 403 && r.body?.error?.code === "COHOST_EDIT_OFF", "team level can't add ticket types", r.body);
    r = await newType(coE.id);
    assert(r.status === 201 && r.body?.ticketType?.name === "Guest list", "edit level adds a ticket type", r.body);

    console.log("\nmoney stays the host's");
    r = await call("POST", `/api/events/${draft}/publish`, { token: tok(coS.id), body: {} });
    assert(r.status === 404, "co-host can't publish", r.body);
    r = await call("POST", `/api/events/${ev}/cancel`, { token: tok(coE.id), body: {} });
    assert(r.status !== 200 && (await q(`SELECT status FROM events WHERE id = $1`, [ev]))[0].status === "published", "co-host can't cancel", r.body);
    r = await call("POST", `/api/events/${ev}/orders/00000000-0000-0000-0000-000000000000/refund`, { token: tok(coE.id), body: {} });
    assert(r.status === 404 && r.body?.error?.code === "EVENT_NOT_FOUND", "co-host can't refund", r.body);

    console.log("\nthe host changes a level");
    const level = (u: string, member: string, body: unknown) => call("PUT", `/api/events/${ev}/door/team/${member}/cohost-level`, { token: tok(u), body });
    r = await level(coE.id, coT.id, { scope: "event", level: "edit" });
    assert(r.status === 403 && r.body?.error?.code === "HOST_ONLY", "a co-host can't change levels", r.body);
    r = await level(host.id, coT.id, { scope: "event", level: "nope" });
    assert(r.status === 400, "unknown level refused", r.body);
    r = await level(host.id, door.id, { scope: "event", level: "edit" });
    assert(r.status === 404 && r.body?.error?.code === "NOT_ON_TEAM", "only for co-hosts", r.body);
    r = await level(host.id, coT.id, { scope: "event", level: "edit" });
    assert(r.status === 200 && r.body?.cohostLevel === "edit", "host gives edit", r.body);
    r = await patch(coT.id, { title: `${P} Edited again` });
    assert(r.status === 200, "now they can edit", r.body);

    console.log("\nremoving a co-host ends access");
    r = await call("DELETE", `/api/events/${ev}/door/team/${coT.id}?scope=event&role=cohost`, { token: ht });
    assert(r.status === 200, "host removes the co-host", r.body);
    assert((await manage(coT.id)).status === 404, "removed: no access", null);
    assert((await call("GET", `/api/events/${ev}/summary`, { token: tok(coT.id) })).status === 404, "no sales either", null);
    assert(!JSON.stringify((await call("GET", `/api/events/${ev}/door/team?roles=all`, { token: ht })).body ?? {}).includes("@test.local"), "no emails in the team list", null);
  } finally {
    await q(`DELETE FROM event_team_schedules WHERE event_id IN ($1, $2)`, [ev, draft]).catch(() => {});
    await q(`DELETE FROM ticket_types WHERE event_id IN ($1, $2)`, [ev, draft]).catch(() => {});
    await q(`DELETE FROM event_door_members WHERE event_id IN ($1, $2)`, [ev, draft]);
    await q(`DELETE FROM event_door_team WHERE host_user_id = $1`, [host.id]);
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM events WHERE id IN ($1, $2)`, [ev, draft]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
    srv.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
