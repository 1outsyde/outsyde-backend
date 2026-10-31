/**
 * p4-team step 6: the reminder job for everyone at the event (canvas screen 58, Legend decision 11, calls 34 to 40).
 *   - Ticket holders: + 7 days before and "Doors just opened" (day before and 2 hours stay as they were).
 *   - The host and co-hosts: 7 days, day before, 2 hours, doors open.
 *   - Team: each role worded for them, counted from their own time (shift, call time, load in); two roles = the one
 *     that starts first; only people on the team before each reminder's moment; also in Activity.
 *   - Doors open at most 30 minutes late. Moving the event start resets everything; changing one person's times
 *     resets theirs and sends them one "moved" push.
 * Events start 30 days out and the job gets an explicit `now`, so a running server's own job never sees them.
 * Run: EV_TEST_PG_URL=<local> DATABASE_URL=<local> NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/events/teamReminders.http.test.ts
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
const DASH = /[–—]| - /;
const H = 3600e3, MIN = 60e3, DAY = 24 * H;

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

  const notices = await import("./ticketNotices");
  const pushes: any[] = [];
  const activity: any[] = [];
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async (p: any) => { pushes.push(p); return true; },
    createActivity: async (p: any) => { activity.push(p); },
    sendDoorInvite: async () => {}, sendOwedReminder: async () => {}, sendTeamSetupReminder: async () => {},
  } as any);
  const { runEventReminderJob } = await import("./eventReminders");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/events", (await import("./doorRouter")).default);
  app.use("/api/events", (await import("./eventsRouter")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `tr${Date.now().toString(36)}`;
  const allEvents: string[] = [];
  const allUsers: string[] = [];
  const user = async (s: string) => {
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}`.slice(0, 24)],
    ))[0].id as string;
    allUsers.push(id);
    return { id };
  };
  // Starts 30 days out at a whole hour (so clock times are easy to read), in New York.
  const event = async (host: { id: string }, slug: string, daysOut = 30) => {
    const e = (await q(
      `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at, venue_name, city, state)
       VALUES ($1, $2, $3, 'published', date_trunc('hour', now()) + make_interval(days => $4::int), date_trunc('hour', now()) + make_interval(days => $4::int) + interval '6 hours',
         'America/New_York', now() - interval '1 day', 'The Loft', 'Freeport', 'NY')
       RETURNING id, title, starts_at`,
      [host.id, `${P}-${slug}`, `${P} ${slug}`, daysOut],
    ))[0] as { id: string; title: string; starts_at: Date };
    allEvents.push(e.id);
    return { ...e, start: new Date(e.starts_at), at: (ms: number) => new Date(new Date(e.starts_at).getTime() + ms) };
  };
  const ticket = async (eventId: string, holder: { id: string }) => {
    const typeId = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 0, 100, 1, 5) RETURNING id`, [eventId]))[0].id;
    const oid = (await q(`INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents, total_cents, completed_at)
      VALUES ($1, $2, 'completed', 1, 0, 0, 0, 0, 0, 0, now()) RETURNING id`, [eventId, holder.id]))[0].id;
    const iid = (await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
      VALUES ($1, $2, $3, $4, 1, 0, 'issued', now() + interval '1 day') RETURNING id`, [oid, eventId, typeId, holder.id]))[0].id;
    await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
      VALUES ($1, $2, $3, $4, $5, 1, $6, 'valid', 0, 0, 0, 0, 0)`, [oid, iid, eventId, typeId, holder.id, `${P}${Math.random().toString(36).slice(2, 12)}`]);
  };
  const member = async (eventId: string, host: { id: string }, u: { id: string }, role: string, o: { acceptedAgo?: string; pending?: boolean } = {}) =>
    q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, cohost_level, invited_at, accepted_at)
       VALUES ($1::varchar, $2, $3, $4, $5, now() - interval '20 days', ${o.pending ? "NULL" : o.acceptedAgo === "late" ? "(SELECT starts_at - interval '3 days' FROM events WHERE id = $1::varchar)" : `now() - interval '${o.acceptedAgo ?? "10 days"}'`})`,
      [eventId, u.id, host.id, role, role === "cohost" ? "team" : null]);
  const times = (eventId: string, u: { id: string }, role: string, host: { id: string }, f: { startsAt?: number; endsAt?: number; callAt?: number; loadInAt?: number; place?: string }) =>
    q(`INSERT INTO event_team_schedules (event_id, member_user_id, role, starts_at, ends_at, call_at, load_in_at, place_note, updated_by_user_id)
       SELECT id, $2, $3,
         CASE WHEN $4::float IS NULL THEN NULL ELSE starts_at + make_interval(secs => $4::float / 1000) END,
         CASE WHEN $5::float IS NULL THEN NULL ELSE starts_at + make_interval(secs => $5::float / 1000) END,
         CASE WHEN $6::float IS NULL THEN NULL ELSE starts_at + make_interval(secs => $6::float / 1000) END,
         CASE WHEN $7::float IS NULL THEN NULL ELSE starts_at + make_interval(secs => $7::float / 1000) END,
         $8, $9 FROM events WHERE id = $1`,
      [eventId, u.id, role, f.startsAt ?? null, f.endsAt ?? null, f.callAt ?? null, f.loadInAt ?? null, f.place ?? null, host.id]);
  const to = (u: { id: string }) => pushes.filter((p) => p.userId === u.id);
  const run = async (now: Date) => { pushes.length = 0; activity.length = 0; await runEventReminderJob(now); };

  try {
    const host = await user("host");
    const e = await event(host, "night");
    const guest = await user("guest"); await ticket(e.id, guest);
    const adm = await user("adm"), sec = await user("sec"), dj = await user("dj"), pro = await user("pro"), media = await user("media"), co = await user("co");
    const late = await user("late"), pend = await user("pend"), both = await user("both");
    await member(e.id, host, adm, "door"); await times(e.id, adm, "door", host, { startsAt: -H, endsAt: 5 * H });
    await member(e.id, host, sec, "security"); await times(e.id, sec, "security", host, { callAt: -H, place: "Side entrance on Main St" });
    await member(e.id, host, dj, "entertainment"); await times(e.id, dj, "entertainment", host, { startsAt: 2 * H, endsAt: 4 * H, loadInAt: H });
    await member(e.id, host, pro, "host");
    await member(e.id, host, media, "media");
    await member(e.id, host, co, "cohost");
    await member(e.id, host, late, "security", { acceptedAgo: "late" }); // joined 3 days before the event
    await member(e.id, host, pend, "security", { pending: true });
    // Two roles: Admissions at -3 h and Security call time at -1 h: the Admissions reminders go (it starts first).
    await member(e.id, host, both, "door"); await times(e.id, both, "door", host, { startsAt: -3 * H });
    await member(e.id, host, both, "security"); await times(e.id, both, "security", host, { callAt: -H });
    const link = (await q(`INSERT INTO event_promoter_links (event_id, promoter_user_id, code) VALUES ($1, $2, $3) RETURNING id`, [e.id, pro.id, Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("")]))[0].id;
    void link;

    console.log("\n7 days before");
    await run(e.at(-7 * DAY + MIN));
    assert(to(guest).length === 1 && to(guest)[0].title === `${e.title} is one week away` && to(guest)[0].data?.kind === "week", "ticket holder: one week away", to(guest));
    assert(to(host).length === 1 && to(host)[0].title === `${e.title} is one week away` && to(host)[0].data?.kind === "host_week" && /going/.test(to(host)[0].body), "host", to(host));
    assert(to(co).length === 1 && to(co)[0].title === `${e.title} is one week away`, "co-host gets the host's", to(co));
    assert(to(pro).length === 1 && /sold through your link/.test(to(pro)[0].body), "promoter: link sales", to(pro));
    assert(to(media).length === 1 && to(media)[0].title === `Media at ${e.title} next ${new Date(e.start).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" })}`, "media: generic", to(media));
    // Team anchors are earlier than the start, so their week window opened before this time too.
    assert(to(sec).length === 1 && to(sec)[0].title.startsWith("Security at") && to(sec)[0].data?.type === "event_reminder" && to(sec)[0].data?.kind === "team_week",
      "security: their own wording", to(sec));
    assert(to(adm).length === 1 && to(adm)[0].title.startsWith("Admissions at"), "admissions", to(adm));
    assert(to(both).length === 1 && to(both)[0].title.startsWith("Admissions at"), "two roles: the one that starts first", to(both));
    assert(to(late).length === 0, "joined after the moment: nothing (call 36)", to(late));
    assert(to(pend).length === 0, "pending invite: nothing", to(pend));
    assert(activity.some((a) => a.userId === sec.id && a.type === "event_reminder") && !activity.some((a) => a.userId === guest.id || a.userId === host.id),
      "team reminders in Activity; guests and the host push only (call 39)", activity.map((a) => a.userId));
    assert(pushes.every((p) => !DASH.test(p.title) && !DASH.test(p.body)), "no dashes", pushes);
    await run(e.at(-7 * DAY + 2 * MIN));
    assert(pushes.length === 0, "a second run sends nothing", pushes);

    console.log("\nthe day before, each from their own time");
    await run(e.at(-DAY - H + MIN)); // security call -1 h: its day before window just opened; start's not yet
    assert(to(sec).length === 1 && to(sec)[0].title.endsWith(`Security at ${e.title}`) && to(sec)[0].data?.kind === "team_day_before" && to(sec)[0].body.includes("Side entrance on Main St"),
      "security: from their call time, with where to go", to(sec));
    assert(to(guest).length === 0 && to(host).length === 0, "the event's own day before isn't due yet", pushes.map((p) => p.userId));
    await run(e.at(-DAY + MIN));
    assert(to(guest).length === 1 && to(guest)[0].data?.kind === "day_before", "ticket holder: day before (as before)", to(guest));
    assert(to(host).length === 1 && to(host)[0].data?.kind === "host_day_before", "host: day before (as before)", to(host));
    assert(to(co).length === 1 && to(co)[0].title.startsWith("Your event is"), "co-host too", to(co));
    assert(to(sec).length === 0, "security not twice", to(sec));

    console.log("\n2 hours before");
    await run(e.at(-3 * H + MIN)); // security call -1 h: 2 hours before it
    assert(to(sec).length === 1 && to(sec)[0].title === "Call time in 2 hours" && to(sec)[0].body.includes("The Loft"), "security: call time in 2 hours, venue named", to(sec));
    await run(e.at(-2 * H + MIN));
    assert(to(host).length === 1 && to(host)[0].title === `${e.title} starts in 2 hours` && /Your team of \d+ has the call times/.test(to(host)[0].body), "host: team call times", to(host));
    assert(to(guest).length === 1 && to(guest)[0].data?.kind === "soon", "ticket holder: 2 hours (as before)", to(guest));
    await run(e.at(-H + MIN)); // DJ load in at +1 h: its 2 hours
    assert(to(dj).length === 1 && to(dj)[0].title === "Load in is in 2 hours", "DJ: from load in", to(dj));

    console.log("\ndoors open");
    await run(e.at(MIN));
    const doorsTitles = new Set(pushes.map((p) => p.title));
    assert(to(guest)[0]?.title === `Doors just opened at ${e.title}` && to(host)[0]?.title === "Doors just opened" && to(adm)[0]?.body.includes("scanner") && to(dj)[0]?.body.startsWith("Your set starts at"),
      "everyone, worded for them", pushes.map((p) => [p.userId === guest.id ? "guest" : p.userId === host.id ? "host" : "?", p.title, p.body]));
    assert(doorsTitles.size >= 2, "different wording per person");
    const e2 = await event(host, "late");
    const g2 = await user("g2"); await ticket(e2.id, g2);
    await run(e2.at(31 * MIN));
    assert(to(g2).length === 0, "more than 30 minutes late: skipped (call 37)", to(g2));

    console.log("\ntimes that change (call 38)");
    const e3 = await event(host, "moves");
    const s3 = await user("s3");
    await member(e3.id, host, s3, "security"); await times(e3.id, s3, "security", host, { callAt: -H });
    await run(e3.at(-DAY - H + MIN));
    assert(to(s3).length === 1 && to(s3)[0].data?.kind === "team_day_before", "day before sent", to(s3));
    pushes.length = 0; activity.length = 0;
    const newCall = new Date(e3.start.getTime() - 2 * H).toISOString();
    let r = await call("PUT", `/api/events/${e3.id}/door/team/${s3.id}/schedule?role=security`, { token: tok(host.id), body: { callAt: newCall } });
    assert(r.status === 200, "host moves the call time", r.body);
    await new Promise((res) => setTimeout(res, 500)); // the push goes out right after the reply
    const moved = to(s3)[0];
    assert(!!moved && /^Call time moved to \d{1,2}:\d{2} [AP]M$/.test(moved.title) && moved.body.includes(e3.title) && moved.data?.type === "team_time_changed" && !DASH.test(moved.body),
      "one push: Call time moved to ...", to(s3));
    assert((await q(`SELECT count(*)::int AS n FROM event_team_reminders WHERE event_id = $1 AND member_user_id = $2`, [e3.id, s3.id]))[0].n === 0, "their reminders reset");
    await run(e3.at(-DAY - 2 * H + MIN));
    assert(to(s3).length === 1 && to(s3)[0].data?.kind === "team_day_before", "the day before goes again for the new time", to(s3));
    pushes.length = 0;
    r = await call("PUT", `/api/events/${e3.id}/door/team/${s3.id}/schedule?role=security`, { token: tok(host.id), body: { callAt: newCall, placeNote: "Back door" } });
    await new Promise((res) => setTimeout(res, 500));
    assert(r.status === 200 && to(s3).length === 0, "only the place changed: no moved push", to(s3));
    const s4 = await user("s4"); await member(e3.id, host, s4, "security");
    r = await call("PUT", `/api/events/${e3.id}/door/team/${s4.id}/schedule?role=security`, { token: tok(host.id), body: { callAt: newCall } });
    await new Promise((res) => setTimeout(res, 500));
    assert(r.status === 200 && to(s4).length === 0, "a time set for the first time: no moved push", to(s4));
    // The event start moves: everything resets (ticket holders, host, team).
    const g3 = await user("g3"); await ticket(e3.id, g3);
    await run(e3.at(-7 * DAY + MIN));
    assert(to(g3).length === 1, "guest week sent");
    await q(`UPDATE tickets SET reminder_week_at = now() WHERE event_id = $1`, [e3.id]);
    const newStart = new Date(e3.start.getTime() + DAY).toISOString();
    const newEnd = new Date(e3.start.getTime() + DAY + 6 * H).toISOString();
    r = await call("PATCH", `/api/events/${e3.id}`, { token: tok(host.id), body: { startsAt: newStart, endsAt: newEnd } });
    assert(r.status === 200, "host moves the event", r.body);
    const stamps = (await q(`SELECT reminder_week_at, reminder_start_at FROM tickets WHERE event_id = $1`, [e3.id]))[0];
    const ev3 = (await q(`SELECT host_reminder_week_at, host_reminder_soon_at, host_reminder_start_at FROM events WHERE id = $1`, [e3.id]))[0];
    const team3 = (await q(`SELECT count(*)::int AS n FROM event_team_reminders WHERE event_id = $1`, [e3.id]))[0].n;
    assert(stamps.reminder_week_at === null && ev3.host_reminder_week_at === null && team3 === 0, "every reminder resets", { stamps, ev3, team3 });
  } catch (err) {
    failed++;
    console.error("  ❌ crashed:", err);
  } finally {
    try {
      const ev = allEvents, us = allUsers;
      await q(`DELETE FROM event_team_reminders WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM event_promoter_links WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM event_team_schedules WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ev]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [ev]);
      await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [us]).catch(() => {});
      await q(`DELETE FROM users WHERE id = ANY($1)`, [us]).catch((err) => console.error("cleanup users:", err.message));
    } catch (err) {
      console.error("cleanup failed:", (err as Error).message);
    }
    await db.end();
    srv.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
