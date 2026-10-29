/**
 * p4-team step 2: new sections (Entertainment, Media, Co-host, Other with a name), what each role gets on the host's
 * team list, per event times for every role, and a member's own view of their roles at an event.
 *
 * SCRATCH ONLY. Local scratch Postgres with migrations through 083 (EV_TEST_PG_URL, localhost only) and DATABASE_URL
 * via the neon shim preload. Runs the door router in this process. Skips when EV_TEST_PG_URL is unset.
 *
 * Mutation checks:
 *  - drop 'entertainment' from TEAM_ROLES (or from the 083 check) → "entertainment invite" fails.
 *  - skip parseRoleLabel on add → "other needs a name" / "other stored with its name" fail.
 *  - drop roleInfo from memberJson → "team list says what each person gets" fails.
 *  - drop the active row check on PUT schedule → "times only for someone on the team" fails.
 *  - drop the host check on PUT schedule → "a member can't set times" fails.
 *  - drop `accepted_at IS NOT NULL` from team/me → "pending invite: no team view yet" fails.
 *  - drop the ends > starts check → "end before start refused" fails.
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
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000).toISOString();

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
  const emails: any[] = [];
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async () => {},
    sendDoorInvite: async (p: any) => { emails.push(p); },
  } as any);
  const { default: doorRouter } = await import("./doorRouter");
  const app = express();
  app.use(express.json());
  app.use("/api/events", doorRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `ts${Date.now().toString(36)}`;
  const mkUser = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host");
  const dj = await mkUser("dj");
  const cam = await mkUser("cam");
  const co = await mkUser("co");
  const coat = await mkUser("coat");
  const sec = await mkUser("sec");
  const promo = await mkUser("promo");
  const stranger = await mkUser("str");
  const starts = new Date(Date.now() + 3 * 24 * 3600_000);
  const ev = (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, 'published', $4, $5, 'America/New_York') RETURNING id`,
    [host.id, `${P}-ev`, `${P} Night`, starts.toISOString(), at(starts, 300)],
  ))[0].id as string;
  const ht = tok(host.id);
  const invite = (body: Record<string, unknown>) => call("POST", `/api/events/${ev}/door/team`, { token: ht, body });
  const putTimes = (userId: string, role: string, body: unknown, token = ht) =>
    call("PUT", `/api/events/${ev}/door/team/${userId}/schedule?role=${role}`, { token, body });
  const myTeam = (u: string) => call("GET", `/api/events/${ev}/team/me`, { token: tok(u) });

  try {
    console.log("\nnew sections");
    let r = await invite({ username: dj.username, scope: "event", role: "entertainment" });
    assert(r.status === 201 && r.body?.member?.role === "entertainment", "entertainment invite", r.body);
    assert(r.body?.member?.roleInfo?.name === "Entertainment", "answer names the section", r.body?.member);
    r = await invite({ username: cam.username, scope: "event", role: "media" });
    assert(r.status === 201 && r.body?.member?.role === "media", "media invite", r.body);
    r = await invite({ username: co.username, scope: "event", role: "cohost" });
    assert(r.status === 201 && r.body?.member?.role === "cohost", "co-host invite", r.body);
    await sleep(200);
    assert(pushes.some((p) => p.userId === co.id && p.title.endsWith("invited you to co-host with them") && p.data?.type === "team_invite"), "co-host push, team_invite type", pushes.map((p) => p.title));
    r = await invite({ username: coat.username, scope: "event", role: "other" });
    assert(r.status === 400 && r.body?.error?.code === "INVALID_REQUEST" && /roleLabel/.test(r.body?.error?.message), "other needs a name", r.body);
    r = await invite({ username: coat.username, scope: "event", role: "other", roleLabel: "<b>x</b>" });
    assert(r.status === 400, "other name with markup refused", r.body);
    r = await invite({ username: sec.username, scope: "event", role: "security", roleLabel: "Bouncer" });
    assert(r.status === 400 && /only for the Other role/.test(r.body?.error?.message), "a name only for Other", r.body);
    r = await invite({ username: coat.username, scope: "event", role: "other", roleLabel: "  Coat  check " });
    assert(r.status === 201 && r.body?.member?.role === "other" && r.body?.member?.roleLabel === "Coat check", "other stored with its name", r.body);
    assert((await q(`SELECT role_label FROM event_door_members WHERE event_id = $1 AND member_user_id = $2`, [ev, coat.id]))[0]?.role_label === "Coat check", "name saved in role_label");
    await sleep(200);
    assert(emails.some((e) => e.role === "other" && e.roleLabel === "Coat check"), "other email gets its name", emails.map((e) => [e.role, e.roleLabel]));
    r = await invite({ username: sec.username, scope: "event", role: "security" });
    assert(r.status === 201, "security invite", r.body);
    r = await invite({ username: promo.username, scope: "standing", role: "host" });
    assert(r.status === 201, "standing promoter invite", r.body);

    console.log("\ntimes for every role (all optional)");
    const t = { startsAt: at(starts, 0), endsAt: at(starts, 240), callAt: at(starts, -60), loadInAt: at(starts, -90), placeNote: "Side door on 5th", hostNote: "Black shirt please" };
    r = await putTimes(dj.id, "entertainment", t);
    assert(r.status === 200 && r.body?.schedule?.placeNote === "Side door on 5th" && r.body?.schedule?.startsAt === t.startsAt, "host sets a DJ's set time, load in and notes", r.body);
    r = await putTimes(dj.id, "entertainment", { ...t, hostNote: null });
    assert(r.status === 200 && r.body?.schedule?.hostNote === null && r.body?.schedule?.loadInAt === t.loadInAt, "saving again replaces (a null clears)", r.body);
    r = await putTimes(promo.id, "host", { callAt: at(starts, -30) });
    assert(r.status === 200 && r.body?.schedule?.callAt === at(starts, -30) && r.body?.schedule?.startsAt === null, "a standing promoter can get a time too (optional)", r.body);
    r = await putTimes(sec.id, "security", {});
    assert(r.status === 200 && r.body?.schedule?.callAt === null, "empty times allowed", r.body);
    r = await putTimes(dj.id, "entertainment", { startsAt: at(starts, 60), endsAt: at(starts, 30) });
    assert(r.status === 400 && r.body?.error?.code === "INVALID_REQUEST", "end before start refused", r.body);
    r = await putTimes(dj.id, "entertainment", { startsAt: at(starts, -3 * 24 * 60) });
    assert(r.status === 400 && r.body?.error?.code === "TIME_OUT_OF_RANGE", "a time days away from the event refused", r.body);
    r = await putTimes(dj.id, "entertainment", { placeNote: "x".repeat(301) });
    assert(r.status === 400, "place note over 300 characters refused", r.body);
    r = await putTimes(dj.id, "entertainment", { bogus: 1 });
    assert(r.status === 400, "unknown field refused", r.body);
    r = await putTimes(stranger.id, "security", t);
    assert(r.status === 404 && r.body?.error?.code === "NOT_ON_TEAM", "times only for someone on the team", r.body);
    r = await putTimes(dj.id, "media", t);
    assert(r.status === 404 && r.body?.error?.code === "NOT_ON_TEAM", "times only for a role they have", r.body);
    r = await putTimes(dj.id, "bogus", t);
    assert(r.status === 400, "unknown role refused", r.body);
    r = await putTimes(dj.id, "entertainment", t, tok(dj.id));
    assert(r.status === 404 && r.body?.error?.code === "EVENT_NOT_FOUND", "a member can't set times", r.body);

    console.log("\nhost's team list says what each person gets");
    r = await call("GET", `/api/events/${ev}/door/team?roles=all`, { token: ht });
    const find = (u: string, role: string) => [...(r.body?.event ?? []), ...(r.body?.standing ?? [])].find((m: any) => m.userId === u && m.role === role);
    assert(find(co.id, "cohost")?.roleInfo?.description === "Sees everything you see for the event, including sales, the guest list and the team.", "co-host: sees everything the host sees", find(co.id, "cohost"));
    assert(find(coat.id, "other")?.roleInfo?.name === "Coat check" && find(coat.id, "other")?.roleLabel === "Coat check", "other shows its name", find(coat.id, "other"));
    assert(find(dj.id, "entertainment")?.schedule?.placeNote === "Side door on 5th", "times on the list", find(dj.id, "entertainment"));
    assert(find(promo.id, "host")?.schedule?.callAt === at(starts, -30), "standing member's times for this event", find(promo.id, "host"));
    assert(find(cam.id, "media")?.schedule === null, "no times yet: null", find(cam.id, "media"));
    r = await call("GET", `/api/events/${ev}/door/team`, { token: ht });
    assert((r.body?.event ?? []).every((m: any) => m.role === "door"), "default list still door only (old clients)", r.body);

    console.log("\na member's own view");
    r = await myTeam(dj.id);
    assert(r.status === 404 && r.body?.error?.code === "EVENT_NOT_FOUND", "pending invite: no team view yet", r.body);
    await q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = $1`, [ev]);
    await q(`UPDATE event_door_team SET accepted_at = now() WHERE host_user_id = $1`, [host.id]);
    r = await myTeam(dj.id);
    const djRole = r.body?.roles?.[0];
    assert(r.status === 200 && r.body?.event?.id === ev && r.body?.roles?.length === 1 && djRole?.role === "entertainment", "accepted DJ sees their role", r.body);
    assert(djRole?.roleInfo?.name === "Entertainment" && djRole?.schedule?.loadInAt === t.loadInAt && djRole?.schedule?.placeNote === "Side door on 5th", "with their times and notes", djRole);
    assert(typeof r.body?.host?.name === "string", "names the host", r.body?.host);
    r = await myTeam(promo.id);
    assert(r.status === 200 && r.body?.roles?.[0]?.scope === "standing" && r.body?.roles?.[0]?.schedule?.callAt === at(starts, -30), "standing promoter sees this event's time", r.body);
    r = await myTeam(cam.id);
    assert(r.status === 200 && r.body?.roles?.[0]?.schedule === null, "no times set yet: schedule null", r.body);
    r = await myTeam(stranger.id);
    assert(r.status === 404, "not on the team: 404", r.body);
    r = await myTeam(host.id);
    assert(r.status === 404, "the host has no team view (they have the host screens)", r.body);
    assert(!JSON.stringify(r.body ?? {}).includes("@test.local"), "no emails in the answer", null);
    await call("DELETE", `/api/events/${ev}/door/team/${dj.id}?scope=event&role=entertainment`, { token: ht });
    r = await myTeam(dj.id);
    assert(r.status === 404, "removed: no team view", r.body);

    console.log("\nremove and validation messages name every role");
    r = await call("DELETE", `/api/events/${ev}/door/team/${co.id}?scope=event&role=cohost`, { token: ht });
    assert(r.status === 200, "remove a co-host", r.body);
    r = await call("DELETE", `/api/events/${ev}/door/team/${co.id}?scope=event&role=nope`, { token: ht });
    assert(r.status === 400 && /cohost/.test(r.body?.error?.message), "role message lists every role", r.body);
    r = await call("DELETE", `/api/events/${ev}/door/team/${co.id}?scope=event&role=cohost`, { token: ht });
    assert(r.status === 404 && r.body?.error?.message === "That person isn't on your Event team.", "says Event team", r.body);

    console.log("\nemail render for Other escapes the name");
    const { renderDoorTeamInvite } = await import("../emailService");
    const mail = renderDoorTeamInvite({ toEmail: "x@test.local", firstName: null, hostName: "Club & Co", scope: "standing", eventTitle: null, whenText: null, doorUrl: "https://goutsyde.test/events/door", role: "other", roleLabel: "Bar & Coat" });
    assert(mail.subject === "Club & Co invited you to their Event team for Bar & Coat", "subject is plain text", mail.subject);
    assert(mail.html.includes("Club &amp; Co wants you on their Event team as Bar &amp; Coat for their events."), "body escapes the name", mail.html.slice(0, 3000));
  } finally {
    await q(`DELETE FROM event_team_schedules WHERE event_id = $1`, [ev]).catch(() => {});
    await q(`DELETE FROM event_door_members WHERE event_id = $1`, [ev]);
    await q(`DELETE FROM event_door_team WHERE host_user_id = $1`, [host.id]);
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM events WHERE id = $1`, [ev]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
    srv.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
