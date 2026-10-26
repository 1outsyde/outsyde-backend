/**
 * Events & Ticketing: moving an upcoming event's start clears its reminder stamps (PATCH /api/events/:id), so guests
 * and the host are reminded again for the new date (Events canvas screen 36, review finding 2026-10-26).
 *
 * Run with: npx tsx server/events/eventRescheduleReminders.http.test.ts
 * SCRATCH ONLY. Needs a local server (EV_TEST_BASE_URL, same JWT_SECRET) on local Postgres with migration 074
 * (EV_TEST_PG_URL). Events start 30 days out, so the server's own every-minute reminder job never touches them.
 * Mutation notes:
 *   drop the tickets reset CTE                     -> "start moved: guest stamps cleared" fails
 *   drop `host_reminder_at = NULL`                 -> "start moved: host stamp cleared" fails
 *   reset on every PATCH (drop the startMoved test) -> "title only: stamps kept" fails
 */
import http from "node:http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
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
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const P = `rs${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, username) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, `${P}${s}`.slice(0, 20)],
  ))[0].id as string;
  const host = await mkUser("host");
  const guest = await mkUser("guest");
  const startsAt = new Date(Date.now() + 30 * 86400e3);
  const ev = (await q(
    `INSERT INTO events (host_user_id, slug, title, starts_at, ends_at, timezone, city, state, status, published_at)
     VALUES ($1, $2, 'Reschedule Night', $3, $4, 'America/New_York', 'Freeport', 'NY', 'published', now()) RETURNING id`,
    [host, `${P}-1`, startsAt.toISOString(), new Date(startsAt.getTime() + 4 * 3600e3).toISOString()],
  ))[0];
  const type = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'GA', 0, 10) RETURNING id`, [ev.id]))[0].id;
  const order = (await q(`INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, completed_at) VALUES ($1, $2, 'completed', 2, now()) RETURNING id`, [ev.id, guest]))[0].id;
  const item = (await q(
    `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
     VALUES ($1, $2, $3, $4, 2, 0, 'issued', now()) RETURNING id`, [order, ev.id, type, guest]))[0].id;
  for (const i of [1, 2]) {
    await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, price_cents) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [order, item, ev.id, type, guest, i, `${P}T${i}`.toUpperCase()]);
  }

  const stampAll = () => Promise.all([
    q(`UPDATE tickets SET reminder_day_before_at = now(), reminder_soon_at = now() WHERE event_id = $1`, [ev.id]),
    q(`UPDATE events SET host_reminder_at = now() WHERE id = $1`, [ev.id]),
  ]);
  const read = async () => ({
    tickets: await q(`SELECT reminder_day_before_at AS d, reminder_soon_at AS s FROM tickets WHERE event_id = $1`, [ev.id]),
    host: (await q(`SELECT host_reminder_at AS h FROM events WHERE id = $1`, [ev.id]))[0].h,
  });
  const allSet = (r: any) => r.tickets.length === 2 && r.tickets.every((t: any) => t.d && t.s) && !!r.host;

  try {
    console.log("Edits that don't move the start keep the stamps");
    await stampAll();
    let r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { title: "Reschedule Night 2" } });
    assert(r.status === 200, "title edit ok", r);
    assert(allSet(await read()), "title only: stamps kept");
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { endsAt: new Date(startsAt.getTime() + 5 * 3600e3).toISOString() } });
    assert(r.status === 200, "end edit ok", r);
    assert(allSet(await read()), "end only: stamps kept");
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { startsAt: startsAt.toISOString() } });
    assert(r.status === 200, "same start sent back ok", r);
    assert(allSet(await read()), "same start sent back: stamps kept");

    console.log("Moving the start clears every stamp");
    const later = new Date(startsAt.getTime() + 86400e3);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { startsAt: later.toISOString(), endsAt: new Date(later.getTime() + 4 * 3600e3).toISOString() } });
    assert(r.status === 200, "start moved ok", r);
    const after = await read();
    assert(after.tickets.every((t: any) => !t.d && !t.s), "start moved: guest stamps cleared", after.tickets);
    assert(!after.host, "start moved: host stamp cleared", after.host);
    assert(r.body?.event && !("hostReminderAt" in r.body.event) && !("host_reminder_at" in r.body.event), "response never shows the stamp", Object.keys(r.body?.event ?? {}));

    console.log("A refused edit clears nothing");
    await stampAll();
    const other = await mkUser("other");
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(other), body: { startsAt: new Date(later.getTime() + 86400e3).toISOString() } });
    assert(r.status === 404, "someone else can't edit", r.status);
    assert(allSet(await read()), "refused edit: stamps kept");
  } finally {
    await q(`DELETE FROM tickets WHERE event_id = $1`, [ev.id]);
    await q(`DELETE FROM ticket_order_items WHERE event_id = $1`, [ev.id]);
    await q(`DELETE FROM ticket_orders WHERE event_id = $1`, [ev.id]);
    await q(`DELETE FROM ticket_types WHERE event_id = $1`, [ev.id]);
    await q(`DELETE FROM events WHERE id = $1`, [ev.id]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
