/**
 * p4-team step 1: event team roles on invites, and the scanner only for Admissions (door).
 *
 * SCRATCH ONLY. Local scratch Postgres with migrations through 082 (EV_TEST_PG_URL, localhost only) and DATABASE_URL
 * via the neon shim preload. Runs the door router in this process (no backend server needed). Skips when
 * EV_TEST_PG_URL is unset.
 *
 * Mutation checks:
 *  - drop `role = 'door'` from either branch of loadEventForDoor → "security member gets no guest list" fails.
 *  - drop `role = 'door'` from /door/mine → "security events not in door/mine" fails.
 *  - insert 'door' instead of the parsed role → "security invite stored as security" fails.
 *  - drop role from the duplicate check (or keep the 067 index) → "same person, second role" fails.
 *  - drop the role filter on DELETE → "removing the door spot keeps the security spot" fails.
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
  const activities: any[] = [];
  const emails: any[] = [];
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async (p: any) => { activities.push(p); },
    sendDoorInvite: async (p: any) => { emails.push(p); },
  } as any);
  const clear = () => { pushes.length = 0; activities.length = 0; emails.length = 0; };
  const { default: doorRouter } = await import("./doorRouter");
  const app = express();
  app.use(express.json());
  app.use("/api/events", doorRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `tr${Date.now().toString(36)}`;
  const mkUser = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host");
  const door = await mkUser("door");
  const sec = await mkUser("sec");
  const promo = await mkUser("promo");
  const both = await mkUser("both");
  const standSec = await mkUser("ssec");
  const ev = (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, 'published', now() - interval '1 hour', now() + interval '3 hours', 'America/New_York') RETURNING id`,
    [host.id, `${P}-ev`, `${P} Night`],
  ))[0].id as string;
  const ht = tok(host.id);
  const invite = (username: string, scope: string, role?: unknown) =>
    call("POST", `/api/events/${ev}/door/team`, { token: ht, body: role === undefined ? { username, scope } : { username, scope, role } });
  const acceptAllFor = (m: string) => Promise.all([
    q(`UPDATE event_door_members SET accepted_at = now() WHERE member_user_id = $1 AND removed_at IS NULL`, [m]),
    q(`UPDATE event_door_team SET accepted_at = now() WHERE member_user_id = $1 AND removed_at IS NULL`, [m]),
  ]);
  const guests = (m: string) => call("GET", `/api/events/${ev}/door/guests`, { token: tok(m) });
  const mine = async (m: string) => ((await call("GET", "/api/events/door/mine", { token: tok(m) })).body?.events ?? []).map((e: any) => e.id);
  const scanUnknown = (m: string) => call("POST", `/api/events/${ev}/door/check-in`, { token: tok(m), body: { code: "ZZZZZZZZZZZZZZZZ" } });

  try {
    console.log("\ninvite with a role");
    clear();
    let r = await invite(sec.username, "event", "security");
    assert(r.status === 201 && r.body?.member?.role === "security", "security invite answers 201 with role", r.body);
    assert((await q(`SELECT role FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [ev, sec.id]))[0]?.role === "security", "security invite stored as security");
    await sleep(200);
    assert(pushes[0]?.title?.endsWith("invited you to their Security team"), "security invite push says Security", pushes[0]);
    assert(emails[0]?.role === "security", "security invite email gets the role", emails[0]);
    r = await invite(promo.username, "event", "host");
    assert(r.status === 201 && r.body?.member?.role === "host", "host / promoter invite", r.body);
    r = await invite(door.username, "event");
    assert(r.status === 201 && r.body?.member?.role === "door", "no role (old clients): door", r.body);
    r = await invite(standSec.username, "standing", "security");
    assert(r.status === 201 && r.body?.member?.role === "security", "standing security invite", r.body);
    r = await invite(promo.username, "event", "admin");
    assert(r.status === 400 && r.body?.error?.code === "INVALID_REQUEST", "unknown role refused", r.body);

    console.log("\none person, several roles");
    clear();
    r = await invite(both.username, "event", "door");
    assert(r.status === 201, "both: door", r.body);
    r = await invite(both.username, "event", "host");
    assert(r.status === 201 && r.body?.member?.role === "host", "same person, second role at the same event", r.body);
    await sleep(300);
    const bothPushes = pushes.filter((p) => p.title && activities.length >= 0 && p.userId === both.id);
    assert(bothPushes.length === 2 && bothPushes[1].title.endsWith("host and promote with them"), "second role gets its own push (quiet window is per role)", bothPushes);
    assert(emails.filter((e) => e.toEmail.startsWith(`${P}-both`)).length === 2, "second role gets its own email (daily email is per role)", emails.map((e) => e.role));
    r = await invite(both.username, "event", "host");
    assert(r.status === 409 && r.body?.error?.code === "ALREADY_INVITED", "same person, same role again: ALREADY_INVITED", r.body);

    await Promise.all([door, sec, promo, both, standSec].map((u) => acceptAllFor(u.id)));

    console.log("\naccess by role");
    assert((await guests(door.id)).status === 200, "Admissions (door) gets the guest list");
    assert((await guests(sec.id)).status === 404, "security member gets no guest list");
    assert((await guests(promo.id)).status === 404, "host / promoter gets no guest list");
    assert((await guests(standSec.id)).status === 404, "standing security gets no guest list");
    assert((await guests(both.id)).status === 200, "door plus host: guest list through the door role");
    assert((await guests(host.id)).status === 200, "event owner keeps full access");
    r = await scanUnknown(sec.id);
    assert(r.status === 404 && r.body?.error?.code === "EVENT_NOT_FOUND", "security can't scan", r.body);
    r = await scanUnknown(door.id);
    assert(r.status === 404 && r.body?.error?.code === "NOT_FOUND", "door can scan (unknown code is NOT_FOUND, not EVENT_NOT_FOUND)", r.body);
    assert((await mine(door.id)).includes(ev), "door event in door/mine");
    assert(!(await mine(sec.id)).includes(ev), "security events not in door/mine");
    assert(!(await mine(promo.id)).includes(ev), "host / promoter events not in door/mine");
    assert(!(await mine(standSec.id)).includes(ev), "standing security not in door/mine");

    console.log("\nteam list");
    r = await call("GET", `/api/events/${ev}/door/team`, { token: ht });
    const evRoles = (r.body?.event ?? []).map((m: any) => m.role);
    assert(r.status === 200 && evRoles.length > 0 && evRoles.every((x: string) => x === "door"), "default list is door only (old clients)", r.body);
    assert(!(r.body?.standing ?? []).some((m: any) => m.userId === standSec.id), "standing security not in the default list", r.body?.standing);
    r = await call("GET", `/api/events/${ev}/door/team?roles=all`, { token: ht });
    const pairs = (r.body?.event ?? []).map((m: any) => `${m.userId}:${m.role}`);
    assert(pairs.includes(`${sec.id}:security`) && pairs.includes(`${promo.id}:host`) && pairs.includes(`${both.id}:door`) && pairs.includes(`${both.id}:host`), "roles=all lists every role with its role", pairs);
    assert((r.body?.standing ?? []).some((m: any) => m.userId === standSec.id && m.role === "security"), "roles=all includes standing security", r.body?.standing);

    console.log("\nremove");
    r = await call("DELETE", `/api/events/${ev}/door/team/${both.id}?scope=event`, { token: ht });
    assert(r.status === 200, "remove without a role", r.body);
    const left = await q(`SELECT role FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [ev, both.id]);
    assert(left.length === 1 && left[0].role === "host", "removing the door spot keeps the host spot", left);
    r = await call("DELETE", `/api/events/${ev}/door/team/${both.id}?scope=event&role=host`, { token: ht });
    assert(r.status === 200, "remove the host spot", r.body);
    assert((await q(`SELECT 1 FROM event_door_members WHERE event_id = $1 AND member_user_id = $2 AND removed_at IS NULL`, [ev, both.id])).length === 0, "now off the team");
    r = await call("DELETE", `/api/events/${ev}/door/team/${sec.id}?scope=event&role=bogus`, { token: ht });
    assert(r.status === 400, "unknown role on remove refused", r.body);

    console.log("\naccepting tells the host the role");
    const late = await mkUser("late");
    r = await invite(late.username, "event", "security");
    const inviteId = r.body?.member?.inviteId;
    clear();
    r = await call("POST", `/api/events/door/invites/${inviteId}/accept`, { token: tok(late.id) });
    await sleep(200);
    assert(r.status === 200 && r.body?.invite?.role === "security", "accept answers with the role", r.body);
    assert(pushes.some((p) => p.userId === host.id && p.title.endsWith("joined your Security team")), "host push says Security", pushes);
  } finally {
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
