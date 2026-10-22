/**
 * Events door check-in Task 3: check-in (by code and by ticket id), undo and the team guest list.
 *
 * Run with: .superpowers/sdd/2026-10-22-events-list-day-of-address/env/run-suite.sh server/events/doorCheckin.http.test.ts
 * SCRATCH ONLY. Local scratch Postgres with migrations through 067, backend on localhost (EV_TEST_BASE_URL),
 * EV_TEST_PG_URL, DATABASE_URL via the neon shim preload (for the in-process rate limit check). Localhost only.
 * Skips (exit 0) when EV_TEST_BASE_URL is unset.
 *
 * The 121st call check runs against an in-process app that mounts the same router with the DEFAULT limit
 * (this process has no ALLOW_TEST_SEAMS), so it proves the real 120 per minute and not a test override.
 *
 * Mutation checks:
 *  - drop `checked_in_at IS NULL` from the check-in UPDATE → "double scan checks in once" fails (two 200s).
 *  - drop the access check on WRONG_EVENT → "code from inaccessible event looks unknown" fails.
 *  - drop `o.status = 'completed'` from the UPDATE → "pending order ticket is not checkable" fails.
 *  - drop the window predicate from the UPDATE (or change 6 hours) → the four "window edge" checks fail.
 *  - drop the host check on undo → "team member cannot undo" fails.
 *  - key the limiter by IP instead of user id → "rate limit is per user" fails.
 *  - sort guests by something other than first name → "guests ordered by first name" fails.
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

  const P = `ck${Date.now().toString(36)}`;
  const mkUser = async (s: string, o: { first?: string | null } = {}) => {
    const username = `${P}${s}`.slice(0, 24);
    const first = o.first === undefined ? `First${s}` : o.first;
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s} Last`, first, username],
    ))[0].id as string;
    return { id, username, first };
  };
  const host = await mkUser("host", { first: "Hosty" });
  const other = await mkUser("other");
  const standing = await mkUser("stand", { first: "Stella" });
  const member = await mkUser("mem", { first: "Mario" });
  const stranger = await mkUser("str");
  const noFirst = await mkUser("nof", { first: null });
  const rl1 = await mkUser("rl1");
  const rl2 = await mkUser("rl2");
  const g: Array<{ id: string; username: string; first: string | null }> = [];
  for (const [i, n] of ["Zed", "Amy", "Bo", "Cy", "Di", "Ed", "Flo", "Gus", "Hal", "Ivy", "Jo", "Kai"].entries()) g.push(await mkUser(`g${i}`, { first: n }));

  /** Seconds relative to now (positive = future). */
  const mkEvent = async (hostId: string, startsS: number, endsS: number, title: string, status = "published") => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval, now() + ($6 || ' seconds')::interval, 'America/New_York') RETURNING id`,
    [hostId, `${P}-${Math.random().toString(36).slice(2, 8)}`, title, status, String(startsS), String(endsS)],
  ))[0].id as string;
  const mkType = async (eventId: string, name: string, priceCents = 0) => (await q(
    `INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, $2, $3, 100) RETURNING id`, [eventId, name, priceCents],
  ))[0].id as string;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const makeCode = () => Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  const mkTicket = async (eventId: string, typeId: string, holderId: string, o: { orderStatus?: string; status?: string; priceCents?: number } = {}) => {
    const price = o.priceCents ?? 0;
    const platform = price > 0 ? Math.round(price / 10) : 0;
    const orderId = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, platform_fee_cents, host_net_cents, total_cents, completed_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $4, now()) RETURNING id`,
      [eventId, holderId, o.orderStatus ?? "completed", price, platform, price - platform],
    ))[0].id as string;
    const itemId = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, $5, 'issued', now()) RETURNING id`, [orderId, eventId, typeId, holderId, price],
    ))[0].id as string;
    const code = makeCode();
    const id = (await q(
      `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents, platform_fee_cents, host_net_cents)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10) RETURNING id`,
      [orderId, itemId, eventId, typeId, holderId, code, o.status ?? "valid", price, platform, price - platform],
    ))[0].id as string;
    return { id, code, orderId };
  };
  const row = async (id: string) => (await q(`SELECT * FROM tickets WHERE id = $1`, [id]))[0];

  // Events: A is open now (started 1h ago, ends in 2h). B is the host's later event. Other is someone else's.
  const evA = await mkEvent(host.id, -3600, 7200, `${P} Alpha`);
  const evB = await mkEvent(host.id, 86400, 90000, `${P} Beta`);
  const evOther = await mkEvent(other.id, -3600, 7200, `${P} Other`);
  const tA = await mkType(evA, "General");
  const tVip = await mkType(evA, "VIP", 5000);
  const tB = await mkType(evB, "Beta General");
  const tOther = await mkType(evOther, "Other General");
  await q(`INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id) VALUES ($1, $2, $1)`, [host.id, standing.id]);
  await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id) VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)`, [evA, member.id, host.id, rl1.id, rl2.id]);
  const scan = (ev: string, user: string, code: string) => call("POST", `/api/events/${ev}/door/check-in`, { token: tok(user), body: { code } });
  const scanId = (ev: string, user: string, ticketId: string) => call("POST", `/api/events/${ev}/door/check-in-ticket`, { token: tok(user), body: { ticketId } });
  const undo = (ev: string, user: string, ticketId: string) => call("POST", `/api/events/${ev}/door/undo`, { token: tok(user), body: { ticketId } });
  const guests = (ev: string, user: string) => call("GET", `/api/events/${ev}/door/guests`, { token: tok(user) });

  // In-process app for the real 120 per minute limit
  const express = (await import("express")).default;
  const { default: doorRouter } = await import("./doorRouter");
  const app = express();
  app.use(express.json());
  app.use("/api/events", doorRouter);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const LOCAL = `http://127.0.0.1:${(srv.address() as any).port}`;

  try {
    console.log("\ncheck in by code");
    const t1 = await mkTicket(evA, tA, g[0].id);
    let r = await scan(evA, host.id, t1.code);
    assert(r.status === 200 && r.body.success && r.body.result === "checked_in", "valid code checks in", r);
    assert(r.body.ticket?.ticketId === t1.id && r.body.ticket.firstName === "Zed" && r.body.ticket.username === g[0].username
      && r.body.ticket.ticketTypeName === "General" && !!r.body.ticket.checkedInAt && r.body.ticket.checkedInBy === "Hosty", "ticket shape and scanner first name", r.body);
    let t = await row(t1.id);
    assert(t.checked_in_at !== null && t.checked_in_by_user_id === host.id, "row records time and scanner", t);
    r = await scan(evA, host.id, t1.code);
    assert(r.status === 409 && r.body.error.code === "ALREADY_CHECKED_IN" && r.body.ticket?.checkedInBy === "Hosty" && !!r.body.ticket?.checkedInAt, "second scan is ALREADY_CHECKED_IN with time and scanner", r);
    const t2 = await mkTicket(evA, tA, g[1].id);
    r = await scan(evA, host.id, `  ${t2.code.toLowerCase()}  `);
    assert(r.status === 200 && r.body.result === "checked_in", "lowercase code with spaces around it is accepted", r);
    r = await scan(evA, host.id, "SHORT");
    assert(r.status === 400 && r.body.error.code === "INVALID_CODE", "short code is 400 INVALID_CODE", r);
    r = await scan(evA, host.id, "ABCDEFGHJKLMNPQ!");
    assert(r.status === 400 && r.body.error.code === "INVALID_CODE", "bad characters are 400 INVALID_CODE", r);
    r = await call("POST", `/api/events/${evA}/door/check-in`, { token: tok(host.id), body: { code: makeCode(), extra: 1 } });
    assert(r.status === 400, "extra body keys are 400 (strict)", r);
    r = await call("POST", `/api/events/${evA}/door/check-in`, { body: { code: makeCode() } });
    assert(r.status === 401, "no token is 401", r);
    const unknown = await scan(evA, host.id, makeCode());
    assert(unknown.status === 404 && unknown.body.error.code === "NOT_FOUND", "unknown code is 404 NOT_FOUND", unknown);

    console.log("\nwho may scan");
    const t3 = await mkTicket(evA, tA, g[2].id);
    r = await scan(evA, standing.id, t3.code);
    assert(r.status === 200 && r.body.ticket.checkedInBy === "Stella", "standing member can check in", r);
    const t4 = await mkTicket(evA, tA, g[3].id);
    r = await scan(evA, member.id, t4.code);
    assert(r.status === 200 && r.body.ticket.checkedInBy === "Mario", "event member can check in", r);
    const t5 = await mkTicket(evA, tA, g[4].id);
    r = await scan(evA, stranger.id, t5.code);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger gets 404 EVENT_NOT_FOUND", r);
    assert((await row(t5.id)).checked_in_at === null, "stranger did not check anything in");
    r = await scanId(evA, stranger.id, t5.id);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger gets 404 on check-in-ticket", r);
    const t6 = await mkTicket(evA, tA, g[5].id);
    r = await scan(evA, noFirst.id, t6.code);
    assert(r.status === 404, "user without a role stays out (noFirst is a stranger here)", r);
    await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id) VALUES ($1, $2, $3)`, [evA, noFirst.id, host.id]);
    r = await scan(evA, noFirst.id, t6.code);
    assert(r.status === 200 && r.body.ticket.checkedInBy === noFirst.username, "checkedInBy falls back to username without a first name", r);

    console.log("\ndouble scan");
    const td = await mkTicket(evA, tA, g[6].id);
    const [a, b] = await Promise.all([scan(evA, host.id, td.code), scan(evA, standing.id, td.code)]);
    const statuses = [a.status, b.status].sort();
    assert(statuses[0] === 200 && statuses[1] === 409, "double scan checks in once (one 200, one 409)", [a, b]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    assert(loser.body.error.code === "ALREADY_CHECKED_IN" && loser.body.ticket.checkedInBy === winner.body.ticket.checkedInBy, "the loser sees who checked in first", [a.body, b.body]);

    console.log("\nnot valid");
    const tRef = await mkTicket(evA, tA, g[7].id, { status: "refunded" });
    r = await scan(evA, host.id, tRef.code);
    assert(r.status === 409 && r.body.error.code === "NOT_VALID", "refunded ticket is NOT_VALID", r);
    const tCan = await mkTicket(evA, tA, g[7].id, { status: "cancelled" });
    r = await scan(evA, host.id, tCan.code);
    assert(r.status === 409 && r.body.error.code === "NOT_VALID", "cancelled ticket is NOT_VALID", r);
    const tPend = await mkTicket(evA, tA, g[7].id, { orderStatus: "pending" });
    r = await scan(evA, host.id, tPend.code);
    assert(r.status === 409 && r.body.error.code === "NOT_PAID" && r.body.error.message === "This ticket isn't paid for yet.", "pending order ticket is NOT_PAID with its own message", r);
    r = await scanId(evA, host.id, tPend.id);
    assert(r.status === 409 && r.body.error.code === "NOT_PAID", "pending order ticket by id is NOT_PAID too", r);
    assert((await row(tPend.id)).checked_in_at === null, "pending order ticket stays unscanned");
    const tRefn = await mkTicket(evA, tVip, g[7].id, { priceCents: 5000 });
    await q(`UPDATE ticket_orders SET status = 'refunding', refund_reason = 'host', refund_amount_cents = 5000 WHERE id = $1`, [tRefn.orderId]);
    r = await scan(evA, host.id, tRefn.code);
    assert(r.status === 409 && r.body.error.code === "NOT_VALID", "refunding order ticket is NOT_VALID", r);

    console.log("\nwrong event and inaccessible codes");
    const tBeta = await mkTicket(evB, tB, g[8].id);
    r = await scan(evA, host.id, tBeta.code);
    assert(r.status === 409 && r.body.error.code === "WRONG_EVENT" && r.body.otherEvent?.id === evB && r.body.otherEvent?.title === `${P} Beta`, "code of another event I can scan is WRONG_EVENT with its title", r);
    assert((await row(tBeta.id)).checked_in_at === null, "wrong event code was not checked in");
    r = await scanId(evA, host.id, tBeta.id);
    assert(r.status === 409 && r.body.error.code === "WRONG_EVENT", "check-in-ticket for another event is WRONG_EVENT too", r);
    const tOtherT = await mkTicket(evOther, tOther, g[9].id);
    r = await scan(evA, host.id, tOtherT.code);
    assert(r.status === unknown.status && r.raw === unknown.raw, "code from inaccessible event looks unknown (same status and body)", { got: r.raw, want: unknown.raw });
    r = await scanId(evA, host.id, tOtherT.id);
    const unknownId = await scanId(evA, host.id, "00000000-0000-0000-0000-000000000000");
    assert(r.status === 404 && r.raw === unknownId.raw, "ticket id from inaccessible event looks unknown", { got: r.raw, want: unknownId.raw });
    assert((await row(tOtherT.id)).checked_in_at === null, "inaccessible event ticket untouched");
    r = await scan(evOther, host.id, tOtherT.code);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "host scanning at someone else's event is EVENT_NOT_FOUND", r);
    // A standing member of host can scan host's other event code from event A; event-only member cannot see Beta
    const tBeta2 = await mkTicket(evB, tB, g[8].id);
    r = await scan(evA, member.id, tBeta2.code);
    assert(r.status === 404 && r.body.error.code === "NOT_FOUND" && r.raw === unknown.raw, "event-only member: Beta code looks unknown", r);
    r = await scan(evA, standing.id, tBeta2.code);
    assert(r.status === 409 && r.body.error.code === "WRONG_EVENT", "standing member: Beta code is WRONG_EVENT", r);

    console.log("\nwindow edges (the same rule in the UPDATE and in isWithinScanWindow)");
    const evSoon = await mkEvent(host.id, 6 * 3600 - 60, 6 * 3600 + 3600, `${P} Soon`);
    const evFar = await mkEvent(host.id, 6 * 3600 + 120, 6 * 3600 + 7200, `${P} Far`);
    const evJustEnded = await mkEvent(host.id, -7200, -60, `${P} JustEnded`);
    const evEnding = await mkEvent(host.id, -7200, 120, `${P} Ending`);
    for (const e of [evSoon, evFar, evJustEnded, evEnding]) await mkType(e, "General");
    const tt = async (e: string) => (await q(`SELECT id FROM ticket_types WHERE event_id = $1`, [e]))[0].id as string;
    const kSoon = await mkTicket(evSoon, await tt(evSoon), g[0].id);
    r = await scan(evSoon, host.id, kSoon.code);
    assert(r.status === 200, "just inside 6 hours before start: open", r);
    const kFar = await mkTicket(evFar, await tt(evFar), g[0].id);
    r = await scan(evFar, host.id, kFar.code);
    assert(r.status === 409 && r.body.error.code === "CHECKIN_CLOSED", "just outside 6 hours before start: CHECKIN_CLOSED", r);
    assert((await row(kFar.id)).checked_in_at === null, "closed window left the ticket unscanned");
    const kEnd = await mkTicket(evJustEnded, await tt(evJustEnded), g[0].id);
    r = await scan(evJustEnded, host.id, kEnd.code);
    assert(r.status === 409 && r.body.error.code === "CHECKIN_CLOSED", "just after the end: CHECKIN_CLOSED", r);
    const kEnding = await mkTicket(evEnding, await tt(evEnding), g[0].id);
    r = await scan(evEnding, host.id, kEnding.code);
    assert(r.status === 200, "just before the end: open", r);
    const { isWithinScanWindow } = await import("./doorAccess");
    const mid = Date.now();
    const edge = { status: "published", starts_at: new Date(mid + 6 * 3600 * 1000), ends_at: new Date(mid + 9 * 3600 * 1000) };
    assert(isWithinScanWindow(edge, new Date(mid)) && !isWithinScanWindow(edge, new Date(mid - 1)), "isWithinScanWindow: exactly 6 hours before is the first open instant");
    assert(isWithinScanWindow({ ...edge, ends_at: new Date(mid) }, new Date(mid)) && !isWithinScanWindow({ ...edge, ends_at: new Date(mid) }, new Date(mid + 1)), "isWithinScanWindow: the end instant is the last open one");
    for (const st of ["draft", "paused", "cancelled"]) {
      const e = await mkEvent(host.id, -3600, 7200, `${P} ${st}`, st);
      const ty = await mkType(e, "General");
      const k = await mkTicket(e, ty, g[0].id);
      r = await scan(e, host.id, k.code);
      assert(r.status === 409 && r.body.error.code === "CHECKIN_CLOSED", `${st} event is CHECKIN_CLOSED`, r);
      assert((await row(k.id)).checked_in_at === null, `${st} event ticket stays unscanned`);
    }
    const kEv = await mkTicket(evJustEnded, await tt(evJustEnded), g[1].id);
    await q(`INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id) VALUES ($1, $2, $3)`, [evJustEnded, member.id, host.id]);
    r = await scan(evJustEnded, member.id, kEv.code);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "event member after the end loses access (404)", r);

    console.log("\ncheck in by ticket id");
    const ti = await mkTicket(evA, tA, g[10].id);
    r = await scanId(evA, standing.id, ti.id);
    assert(r.status === 200 && r.body.result === "checked_in" && r.body.ticket.ticketId === ti.id && r.body.ticket.checkedInBy === "Stella", "guest list tap checks in", r);
    r = await scanId(evA, host.id, ti.id);
    assert(r.status === 409 && r.body.error.code === "ALREADY_CHECKED_IN", "tap twice is ALREADY_CHECKED_IN", r);
    r = await call("POST", `/api/events/${evA}/door/check-in-ticket`, { token: tok(host.id), body: { ticketId: "x".repeat(40) } });
    assert(r.status === 400, "oversized ticketId is 400", r);
    const tiRef = await mkTicket(evA, tA, g[10].id, { status: "refunded" });
    r = await scanId(evA, host.id, tiRef.id);
    assert(r.status === 409 && r.body.error.code === "NOT_VALID", "refunded ticket by id is NOT_VALID", r);

    console.log("\nundo");
    r = await undo(evA, standing.id, t1.id);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "team member cannot undo (404)", r);
    assert((await row(t1.id)).checked_in_at !== null, "team undo changed nothing");
    r = await undo(evA, stranger.id, t1.id);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger cannot undo (404)", r);
    r = await undo(evA, host.id, t1.id);
    assert(r.status === 200 && r.body.success && r.body.ticket.ticketId === t1.id && r.body.ticket.checkedInAt === null && r.body.ticket.checkedInBy === null, "host undo clears the check in", r);
    t = await row(t1.id);
    assert(t.checked_in_at === null && t.checked_in_by_user_id === null, "both columns are NULL after undo", t);
    r = await undo(evA, host.id, t1.id);
    assert(r.status === 409 && r.body.error.code === "NOT_CHECKED_IN", "undo again is NOT_CHECKED_IN", r);
    r = await undo(evA, host.id, tOtherT.id);
    assert(r.status === 404, "undo of a ticket from another event is 404", r);
    r = await scan(evA, host.id, t1.code);
    assert(r.status === 200, "after undo the code checks in again", r);
    // refunded after check in: scan says not valid, undo still works
    const tRc = await mkTicket(evA, tVip, g[11].id, { priceCents: 5000 });
    r = await scan(evA, host.id, tRc.code);
    assert(r.status === 200, "paid ticket checks in", r);
    r = await call("POST", `/api/events/${evA}/orders/${tRc.orderId}/refund`, { token: tok(host.id) });
    assert(r.status === 200 && r.body.success, "host refund of a checked-in order still works", r);
    assert((await row(tRc.id)).status === "refunded", "ticket is refunded after the host refund");
    r = await scan(evA, host.id, tRc.code);
    assert(r.status === 409 && r.body.error.code === "NOT_VALID", "refunded and checked in: scan says NOT_VALID", r);
    r = await undo(evA, host.id, tRc.id);
    assert(r.status === 200 && r.body.ticket.checkedInAt === null, "undo works on a refunded ticket", r);

    console.log("\nundo then buyer cancel works again (free RSVP)");
    const evR = await mkEvent(host.id, 3 * 3600, 6 * 3600, `${P} Rsvp`);
    const tR = await mkType(evR, "Free RSVP");
    const buyer = g[3];
    const rs = await call("POST", `/api/events/${evR}/rsvp`, { token: tok(buyer.id), body: { ticketTypeId: tR } });
    assert(rs.status === 201 || rs.status === 200, "RSVP created", rs);
    const rt = (await q(`SELECT id, code, order_id FROM tickets WHERE event_id = $1`, [evR]))[0];
    r = await scan(evR, host.id, rt.code);
    assert(r.status === 200, "RSVP ticket checks in inside the 6 hour window", r);
    r = await call("POST", `/api/events/orders/${rt.order_id}/cancel`, { token: tok(buyer.id) });
    assert(r.status === 409 && r.body.error.code === "CHECKED_IN", "buyer cancel blocked while checked in", r);
    r = await undo(evR, host.id, rt.id);
    assert(r.status === 200, "host undoes the check in", r);
    r = await call("POST", `/api/events/orders/${rt.order_id}/cancel`, { token: tok(buyer.id) });
    assert(r.status === 200 && r.body.success, "buyer cancel works again after undo", r);

    console.log("\nguest list");
    const evG = await mkEvent(host.id, -3600, 7200, `${P} Guests`);
    const tg = await mkType(evG, "Front Row", 0);
    const gv = [g[1], g[0], g[2]]; // Amy, Zed, Bo
    const gt: any[] = [];
    for (const u of gv) gt.push(await mkTicket(evG, tg, u.id));
    await mkTicket(evG, tg, g[4].id, { status: "refunded" });
    await mkTicket(evG, tg, g[4].id, { status: "cancelled" });
    await mkTicket(evG, tg, g[4].id, { orderStatus: "pending" });
    await scan(evG, host.id, gt[1].code); // Zed
    r = await guests(evG, standing.id);
    assert(r.status === 200 && r.body.success && r.body.total === 3 && r.body.checkedIn === 1, "counts: 3 valid, 1 checked in (refunded, cancelled, pending excluded)", r.body);
    assert(JSON.stringify(r.body.guests.map((x: any) => x.firstName)) === JSON.stringify(["Amy", "Bo", "Zed"]), "guests ordered by first name", r.body.guests);
    const zed = r.body.guests.find((x: any) => x.firstName === "Zed");
    assert(zed.checkedInBy === "Hosty" && !!zed.checkedInAt && zed.ticketTypeName === "Front Row" && zed.username === g[0].username && zed.ticketId === gt[1].id, "guest row fields", zed);
    assert(JSON.stringify(Object.keys(zed).sort()) === JSON.stringify(["checkedInAt", "checkedInBy", "firstName", "ticketId", "ticketTypeName", "username"]), "guest row has exactly the allowed keys", Object.keys(zed));
    assert(!/Cents/.test(r.raw) && !/"email/i.test(r.raw) && !/@test\.local/.test(r.raw) && !/address|street|venue/i.test(r.raw), "no key ending Cents, no email, no address keys", r.raw.slice(0, 300));
    assert(!gt.some((x) => r.raw.includes(x.code)), "guest list never contains the ticket codes");
    r = await guests(evG, member.id);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "event member of a different event cannot read this list", r);
    r = await guests(evG, stranger.id);
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "stranger cannot read the list", r);
    r = await guests(evG, host.id);
    assert(r.status === 200 && r.body.total === 3, "host can read the list", r);
    await undo(evG, host.id, gt[1].id);
    r = await guests(evG, host.id);
    assert(r.body.checkedIn === 0 && r.body.guests.every((x: any) => x.checkedInAt === null && x.checkedInBy === null), "count drops after undo", r.body);

    console.log("\nrate limit");
    let last: any = null;
    let ok = 0;
    for (let i = 0; i < 120; i++) {
      last = await callAt(LOCAL, "GET", `/api/events/${evA}/door/guests`, { token: tok(rl1.id) });
      if (last.status === 200) ok++;
    }
    assert(ok === 120, "120 calls in a minute all pass", { ok, last: last.status });
    r = await callAt(LOCAL, "GET", `/api/events/${evA}/door/guests`, { token: tok(rl1.id) });
    assert(r.status === 429, "121st call in a minute is 429", r);
    assert(r.body?.success === false && r.body?.error?.code === "RATE_LIMITED" && typeof r.body?.error?.message === "string", "429 body is the RATE_LIMITED shape", r.body);
    r = await callAt(LOCAL, "GET", `/api/events/${evA}/door/guests`, { token: tok(rl2.id) });
    assert(r.status === 200, "rate limit is per user (another user is not limited)", r);
    r = await callAt(LOCAL, "POST", `/api/events/${evA}/door/check-in`, { token: tok(rl1.id), body: { code: makeCode() } });
    assert(r.status === 429, "check-in shares the same per-user budget", r);
    r = await callAt(LOCAL, "POST", `/api/events/${evA}/door/undo`, { token: tok(rl1.id), body: { ticketId: t1.id } });
    assert(r.status === 429, "undo shares the same per-user budget", r);
  } finally {
    srv.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
