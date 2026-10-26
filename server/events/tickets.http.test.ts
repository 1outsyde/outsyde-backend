/**
 * Events & Ticketing Phase 1 PR 2: ticket types, free RSVP + cancel, my tickets. HTTP integration tests.
 *
 * Run with: npx tsx server/events/tickets.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres that has
 * migrations/056_events_tickets.sql applied.
 *   EV_TEST_BASE_URL   e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - drop the guard (the CASE ... GUARD_NOT_OPEN) in the claim → "claim after start rolls back" fails
 *    (the ticket type keeps a spot nobody holds).
 *  - drop `e.status = 'published'` in the claim's ev CTE → "draft event can't be claimed" fails.
 *  - drop the unlock EXISTS in the claim → "second wave locked while free remains" fails.
 *  - drop the NOT EXISTS (unlock-after sold) in the cancel → "spot stays closed once the next tier sold" fails.
 *  - drop `max_count = EXCLUDED.max_count` in the claim → "lowered limit applies to the next claim" fails.
 *  - drop `buyer_user_id = ${userId}` in the cancel → "someone else can't cancel my RSVP" fails.
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

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
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
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `tk${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [`${P}-${s}@test.local`, `Guest ${s} Lastname`, `Guest${s}`, `${P}${s}`.slice(0, 20)],
  ))[0].id as string;
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });
  // Publishing needs the current Event Host Agreement accepted (hostAgreement.ts): hosts accept it the way the app does.
  const acceptAgreement = async (id: string) => {
    const g = await call("GET", "/api/events/host-agreement", { token: tok(id) });
    const a = await call("POST", "/api/events/host-agreement/accept", { token: tok(id), body: { version: g.body?.agreement?.version } });
    if (a.status !== 200) throw new Error("agreement accept failed " + JSON.stringify(a));
  };
  const host = await mkUser("host");
  const other = await mkUser("other");
  // Every host needs payouts set up to publish (2026-10-26); this suite tests other rules, so its hosts have it.
  await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [host, `acct_${P}_host`]);
  const guests: string[] = [];
  for (let i = 0; i < 45; i++) guests.push(await mkUser(`g${i}`));
  const [g0, g1, g2] = guests;
  await acceptAgreement(host);

  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  const newEvent = async (over: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/events", { token: tok(host), body: {
      title: "Block Party", startsAt: inDays(7), endsAt: inDays(7, 6), timezone: "America/New_York", city: "Freeport", state: "NY", ...over,
    } });
    if (r.status !== 201) throw new Error(`event create failed ${JSON.stringify(r)}`);
    return r.body.event;
  };
  const addType = (eventId: string, body: Record<string, unknown>, token = tok(host)) => call("POST", `/api/events/${eventId}/ticket-types`, { token, body });
  const rsvp = (eventId: string, user: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
    call("POST", `/api/events/${eventId}/rsvp`, { token: tok(user), body, headers });
  const counts = async (typeId: string, eventId: string) => {
    const [t] = await q(`SELECT reserved_count FROM ticket_types WHERE id = $1`, [typeId]);
    const [e] = await q(`SELECT reserved_count FROM events WHERE id = $1`, [eventId]);
    const [k] = await q(`SELECT count(*)::int AS n FROM tickets WHERE ticket_type_id = $1 AND status = 'valid'`, [typeId]);
    return { type: Number(t.reserved_count), event: Number(e.reserved_count), validTickets: k.n };
  };

  try {
    console.log("Ticket types");
    const ev = await newEvent({ capacity: 100 });
    let r = await addType(ev.id, { name: "Free RSVP", priceCents: 0, quantity: 10 }, tok(other));
    assert(r.status === 404, "stranger can't add a ticket type", r);
    r = await addType(ev.id, { name: "Free RSVP", priceCents: 0, quantity: 10 });
    assert(r.status === 201 && r.body.ticketType.maxPerOrder === 1 && r.body.ticketType.perAccountLimit === 1, "free type defaults to 1 per order and 1 per account", r);
    const free = r.body.ticketType;
    r = await addType(ev.id, { name: "Group", priceCents: 0, quantity: 10, maxPerOrder: 4, perAccountLimit: 2 });
    assert(r.status === 400 && r.body.error.code === "INVALID_ORDER_LIMITS", "most per order can't exceed the per-person limit", r);
    r = await call("PATCH", `/api/events/${ev.id}/ticket-types/${free.id}`, { token: tok(host), body: { maxPerOrder: 3 } });
    assert(r.status === 400 && r.body.error.code === "INVALID_ORDER_LIMITS", "edit can't push most per order above the limit", r);
    r = await addType(ev.id, { name: "Cheap", priceCents: 50, quantity: 10 });
    assert(r.status === 400, "50 cent ticket refused ($1 lowest)", r);
    r = await addType(ev.id, { name: "VIP", priceCents: 5000, quantity: 10 });
    assert(r.status === 201, "paid type can be drafted before publish", r);
    const vip = r.body.ticketType;
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "PAID_TICKETS_NOT_AVAILABLE", "publish still refuses paid types", r);
    r = await call("DELETE", `/api/events/${ev.id}/ticket-types/${vip.id}`, { token: tok(host) });
    assert(r.status === 200 && r.body.removed === "deleted", "unused type is deleted", r);
    const other1 = await newEvent();
    const [otherType] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'X', 0, 5) RETURNING id`, [other1.id]);
    r = await addType(ev.id, { name: "Bad", priceCents: 0, quantity: 5, unlockAfterTicketTypeId: otherType.id });
    assert(r.status === 400 && r.body.error.code === "INVALID_UNLOCK", "can't open after another event's ticket", r);
    r = await addType(ev.id, { name: "Second wave", priceCents: 0, quantity: 5, unlockAfterTicketTypeId: free.id, sortOrder: 1 });
    assert(r.status === 201 && r.body.ticketType.unlockAfterTicketTypeId === free.id, "second wave opens after free", r);
    const wave = r.body.ticketType;
    r = await call("PATCH", `/api/events/${ev.id}/ticket-types/${free.id}`, { token: tok(host), body: { unlockAfterTicketTypeId: wave.id } });
    assert(r.status === 400 && r.body.error.code === "INVALID_UNLOCK", "two types can't wait on each other", r);
    r = await call("PATCH", `/api/events/${ev.id}/ticket-types/${free.id}`, { token: tok(host), body: { minPerOrder: 3, maxPerOrder: 2 } });
    assert(r.status === 400 && r.body.error.code === "INVALID_ORDER_LIMITS", "min above max refused", r);

    r = await rsvp(ev.id, g0, { ticketTypeId: free.id });
    assert(r.status === 404, "draft event can't be claimed", r);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 200, "event publishes", r);
    r = await addType(ev.id, { name: "VIP", priceCents: 5000, quantity: 10 });
    assert(r.status === 409 && r.body.error.code === "PAID_TICKETS_NOT_AVAILABLE", "paid type refused on a published event", r);
    const [hiddenType] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, hidden) VALUES ($1, 'Comps', 0, 5, true) RETURNING id`, [ev.id]);

    console.log("RSVP");
    r = await call("POST", `/api/events/${ev.id}/rsvp`, { body: { ticketTypeId: free.id } });
    assert(r.status === 401, "signed out can't RSVP", r);
    r = await rsvp(ev.id, g0, { ticketTypeId: wave.id });
    assert(r.status === 409 && r.body.error.code === "NOT_OPEN_YET", "second wave locked while free remains", r);
    r = await rsvp(ev.id, g0, { ticketTypeId: hiddenType.id });
    assert(r.status === 404 && r.body.error.code === "TICKET_TYPE_NOT_FOUND", "hidden type can't be claimed", r);
    r = await rsvp(ev.id, g0, { ticketTypeId: free.id, quantity: 2 });
    assert(r.status === 400 && r.body.error.code === "INVALID_QUANTITY", "more than the most per order refused", r);
    r = await rsvp(ev.id, g0, { ticketTypeId: free.id });
    assert(r.status === 201 && r.body.order.tickets.length === 1 && /^[A-HJ-NP-Z2-9]{16}$/.test(r.body.order.tickets[0].code), "guest RSVPs and gets a ticket code", r);
    const g0Order = r.body.order;
    r = await rsvp(ev.id, g0, { ticketTypeId: free.id });
    assert(r.status === 409 && r.body.error.code === "LIMIT_REACHED", "second RSVP on a 1-per-account type refused", r);
    r = await call("GET", "/api/events/me/tickets", { token: tok(g0) });
    assert(r.status === 200 && r.body.tickets.length === 1 && r.body.tickets[0].event.slug === ev.slug && r.body.tickets[0].code === g0Order.tickets[0].code, "my tickets lists it", r);
    assert(typeof r.body.tickets[0].qrUrl === "string" && /\/api\/events\/qr\/[A-Za-z0-9_~-]+\.png$/.test(r.body.tickets[0].qrUrl) && !r.body.tickets[0].qrUrl.includes(g0Order.tickets[0].code), "my tickets adds a signed qrUrl without the code", r.body.tickets[0].qrUrl);
    assert(r.body.tickets.every((x: any) => x.status === "valid" ? typeof x.qrUrl === "string" : x.qrUrl === null), "qrUrl is a string for valid tickets and null otherwise (list returns valid tickets only today)", r.body.tickets.map((x: any) => [x.status, x.qrUrl]));
    assert(JSON.stringify(Object.keys(r.body.tickets[0]).sort()) === JSON.stringify(["checkedInAt", "code", "event", "id", "orderId", "qrUrl", "status", "ticketTypeName"]), "my tickets: old keys unchanged, qrUrl added", Object.keys(r.body.tickets[0]));
    r = await call("GET", `/api/events/slug/${ev.slug}`, { token: tok(g0) });
    assert(r.body.event.viewerHasTicket === true, "event page knows I have a ticket", r.body?.event);

    const key = `${P}-idem-key`;
    r = await rsvp(ev.id, g1, { ticketTypeId: free.id, idempotencyKey: key });
    const r2 = await rsvp(ev.id, g1, { ticketTypeId: free.id, idempotencyKey: key });
    assert(r.status === 201 && r2.status === 200 && r2.body.repeated === true && r2.body.order.id === r.body.order.id, "same key twice returns the same RSVP", { r, r2 });
    const r3 = await rsvp(ev.id, g2, { ticketTypeId: free.id }, { "Idempotency-Key": `${P}-header-key` });
    const r4 = await rsvp(ev.id, g2, { ticketTypeId: free.id }, { "Idempotency-Key": `${P}-header-key` });
    assert(r3.status === 201 && r4.body?.order?.id === r3.body.order.id, "Idempotency-Key header works too", { r3, r4 });
    const r5 = await rsvp(ev.id, g1, { ticketTypeId: wave.id, idempotencyKey: key });
    assert(r5.status === 409 && r5.body.error.code === "IDEMPOTENCY_KEY_REUSED", "same key for a different ticket refused", r5);

    console.log("Everyone at once");
    let c = await counts(free.id, ev.id);
    assert(c.type === 3 && c.event === 3 && c.validTickets === 3, "3 spots taken so far", c);
    const rush = await Promise.all(guests.slice(3, 43).map((g) => rsvp(ev.id, g, { ticketTypeId: free.id })));
    const ok = rush.filter((x) => x.status === 201).length;
    const soldOut = rush.filter((x) => x.status === 409 && x.body?.error?.code === "SOLD_OUT").length;
    assert(ok === 7 && soldOut === 33, "40 people at once on 7 spots: exactly 7 get in, 33 told sold out", { ok, soldOut, others: rush.filter((x) => x.status !== 201 && x.body?.error?.code !== "SOLD_OUT").map((x) => x.body) .slice(0, 3) });
    c = await counts(free.id, ev.id);
    assert(c.type === 10 && c.event === 10 && c.validTickets === 10, "counters and tickets agree: 10", c);
    const [orphans] = await q(`SELECT count(*)::int AS n FROM ticket_orders o WHERE o.event_id = $1 AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id)`, [ev.id]);
    assert(orphans.n === 0, "no order without tickets", orphans);

    r = await rsvp(ev.id, guests[43], { ticketTypeId: wave.id });
    assert(r.status === 201, "second wave opens once free sells out", r);

    console.log("Cancel");
    r = await call("POST", `/api/events/orders/${g0Order.id}/cancel`, { token: tok(other) });
    assert(r.status === 404, "someone else can't cancel my RSVP", r);
    r = await call("POST", `/api/events/orders/${g0Order.id}/cancel`, { token: tok(g0) });
    assert(r.status === 200 && r.body.spotReopened === false && r.body.order.status === "cancelled", "cancel works; spot stays closed once the next tier sold", r);
    c = await counts(free.id, ev.id);
    assert(c.type === 10 && c.event === 10 && c.validTickets === 9, "free stays sold out; event capacity freed (10 = 9 free + 1 wave)", c);
    r = await call("POST", `/api/events/orders/${g0Order.id}/cancel`, { token: tok(g0) });
    assert(r.status === 409 && r.body.error.code === "ALREADY_CANCELLED", "cancel twice refused", r);
    r = await call("GET", "/api/events/me/tickets", { token: tok(g0) });
    assert(r.body.tickets.length === 0, "cancelled ticket leaves my tickets", r.body);

    console.log("My tickets shows the address once the holder can see it");
    {
      const mkAddrEvent = async (visibility: string) => {
        const e = await newEvent({ addressVisibility: visibility });
        await q(`UPDATE events SET venue_name = 'The Loft', address_line1 = '9 Hidden Way', address_line2 = 'Suite 2', postal_code = '11520' WHERE id = $1`, [e.id]);
        const t = (await addType(e.id, { name: "Free", priceCents: 0, quantity: 5 })).body.ticketType;
        await call("POST", `/api/events/${e.id}/publish`, { token: tok(host) });
        return { e, t };
      };
      const mineFor = async (user: string, slug: string) => (await call("GET", "/api/events/me/tickets", { token: tok(user) })).body.tickets.find((x: any) => x.event.slug === slug);
      const far = await mkAddrEvent("ticket_holders_day_of");
      await rsvp(far.e.id, guests[44], { ticketTypeId: far.t.id });
      let mine = await mineFor(guests[44], far.e.slug);
      const { addressRevealAt } = await import("./eventRules");
      const expectIso = addressRevealAt(new Date(mine.event.startsAt), "America/New_York").toISOString();
      assert(mine.event.addressHidden === true && mine.event.addressLine1 === null && mine.event.addressLine2 === null && mine.event.venueName === null && mine.event.postalCode === null,
        "day-of before the reveal: street fields null, addressHidden true", mine.event);
      assert(mine.event.addressRevealAt === expectIso && mine.event.city === "Freeport" && mine.event.state === "NY", "day-of before the reveal: addressRevealAt set, city and state kept", mine.event);
      assert(mine.code && mine.orderId && mine.ticketTypeName === "Free" && mine.event.timezone === "America/New_York" && "coverImageUrl" in mine.event, "existing fields are all still there", mine);
      await q(`UPDATE events SET starts_at = now() + interval '2 hours', ends_at = now() + interval '7 hours' WHERE id = $1`, [far.e.id]);
      mine = await mineFor(guests[44], far.e.slug);
      assert(mine.event.addressHidden === false && mine.event.addressLine1 === "9 Hidden Way" && mine.event.addressLine2 === "Suite 2" && mine.event.venueName === "The Loft" && mine.event.postalCode === "11520",
        "day-of after the reveal: the street is there", mine.event);
      assert(typeof mine.event.addressRevealAt === "string", "day-of after the reveal: addressRevealAt still reported", mine.event);
      const th = await mkAddrEvent("ticket_holders");
      await rsvp(th.e.id, guests[1], { ticketTypeId: th.t.id });
      mine = await mineFor(guests[1], th.e.slug);
      assert(mine.event.addressHidden === false && mine.event.addressLine1 === "9 Hidden Way" && mine.event.venueName === "The Loft" && mine.event.addressRevealAt === null,
        "ticket_holders event: street present, addressRevealAt null", mine.event);
    }

    const ev2 = await newEvent();
    r = await addType(ev2.id, { name: "Free", priceCents: 0, quantity: 2 });
    const t2 = r.body.ticketType;
    await call("POST", `/api/events/${ev2.id}/publish`, { token: tok(host) });
    r = await rsvp(ev2.id, g0, { ticketTypeId: t2.id });
    const o2 = r.body.order;
    r = await call("POST", `/api/events/orders/${o2.id}/cancel`, { token: tok(g0) });
    assert(r.status === 200 && r.body.spotReopened === true, "spot reopens when no later tier has sold", r);
    c = await counts(t2.id, ev2.id);
    assert(c.type === 0 && c.event === 0, "counters back to 0", c);
    r = await rsvp(ev2.id, g0, { ticketTypeId: t2.id });
    assert(r.status === 201, "same guest can RSVP again after cancelling", r);
    await q(`UPDATE tickets SET checked_in_at = now() WHERE order_id = $1`, [r.body.order.id]);
    const checkedOrder = r.body.order.id;
    r = await call("POST", `/api/events/orders/${checkedOrder}/cancel`, { token: tok(g0) });
    assert(r.status === 409 && r.body.error.code === "CHECKED_IN", "checked-in RSVP can't be cancelled", r);

    console.log("Edits with tickets taken");
    r = await call("PATCH", `/api/events/${ev.id}/ticket-types/${free.id}`, { token: tok(host), body: { quantity: 5 } });
    assert(r.status === 409 && r.body.error.code === "QUANTITY_BELOW_TAKEN", "quantity below taken refused", r);
    r = await call("PATCH", `/api/events/${ev.id}/ticket-types/${free.id}`, { token: tok(host), body: { priceCents: 1000 } });
    assert(r.status === 409 && r.body.error.code === "PRICE_LOCKED", "price locked once tickets are taken", r);
    r = await call("PATCH", `/api/events/${ev.id}/ticket-types/${free.id}`, { token: tok(host), body: { quantity: 12, name: "Early RSVP" } });
    assert(r.status === 200 && r.body.ticketType.quantity === 12 && r.body.ticketType.name === "Early RSVP", "quantity raised and renamed", r);
    r = await call("DELETE", `/api/events/${ev.id}/ticket-types/${free.id}`, { token: tok(host) });
    assert(r.status === 200 && r.body.removed === "archived", "used type is archived, not deleted", r);
    const [stillValid] = await q(`SELECT count(*)::int AS n FROM tickets WHERE ticket_type_id = $1 AND status = 'valid'`, [free.id]);
    assert(stillValid.n === 9, "tickets on an archived type stay valid", stillValid);
    r = await rsvp(ev.id, guests[44], { ticketTypeId: free.id });
    assert(r.status === 404, "archived type can't be claimed", r);

    console.log("Limits and capacity");
    const ev3 = await newEvent({ capacity: 2 });
    r = await addType(ev3.id, { name: "Free", priceCents: 0, quantity: 10, maxPerOrder: 3, perAccountLimit: 3 });
    const t3 = r.body.ticketType;
    await call("POST", `/api/events/${ev3.id}/publish`, { token: tok(host) });
    r = await rsvp(ev3.id, g1, { ticketTypeId: t3.id, quantity: 3 });
    assert(r.status === 409 && r.body.error.code === "EVENT_FULL", "3 tickets on a 2-capacity event refused", r);
    r = await rsvp(ev3.id, g1, { ticketTypeId: t3.id, quantity: 2 });
    assert(r.status === 201 && r.body.order.tickets.length === 2, "2 tickets in one RSVP", r);
    r = await rsvp(ev3.id, g2, { ticketTypeId: t3.id });
    assert(r.status === 409 && r.body.error.code === "EVENT_FULL", "event full", r);
    await call("PATCH", `/api/events/${ev3.id}`, { token: tok(host), body: { capacity: 10 } });
    r = await call("PATCH", `/api/events/${ev3.id}/ticket-types/${t3.id}`, { token: tok(host), body: { perAccountLimit: 2, maxPerOrder: 2 } });
    assert(r.status === 200, "host lowers the per-account limit to 2", r);
    r = await rsvp(ev3.id, g1, { ticketTypeId: t3.id });
    assert(r.status === 409 && r.body.error.code === "LIMIT_REACHED", "lowered limit applies to the next claim", r);

    const ev4 = await newEvent();
    r = await addType(ev4.id, { name: "Later", priceCents: 0, quantity: 5, salesStartAt: inDays(2) });
    const t4 = r.body.ticketType;
    await call("POST", `/api/events/${ev4.id}/publish`, { token: tok(host) });
    r = await rsvp(ev4.id, g1, { ticketTypeId: t4.id });
    assert(r.status === 409 && r.body.error.code === "SALES_NOT_STARTED", "sales not started", r);

    console.log("Rollback when the event closes mid-claim");
    const ev5 = await newEvent();
    r = await addType(ev5.id, { name: "Free", priceCents: 0, quantity: 5 });
    const t5 = r.body.ticketType;
    await call("POST", `/api/events/${ev5.id}/publish`, { token: tok(host) });
    await q(`UPDATE events SET starts_at = now() - interval '1 hour', ends_at = now() + interval '2 hours' WHERE id = $1`, [ev5.id]);
    r = await rsvp(ev5.id, g1, { ticketTypeId: t5.id });
    c = await counts(t5.id, ev5.id);
    const [o5] = await q(`SELECT count(*)::int AS n FROM ticket_orders WHERE event_id = $1`, [ev5.id]);
    const [a5] = await q(`SELECT count(*)::int AS n FROM ticket_account_counts WHERE ticket_type_id = $1`, [t5.id]);
    assert(r.status === 409 && r.body.error.code === "EVENT_STARTED", "claim after start refused", r);
    assert(c.type === 0 && c.event === 0 && o5.n === 0 && a5.n === 0, "claim after start rolls back (nothing kept)", { c, o5, a5 });

    // Phase 2 PR 4: cancelling with guests cancels every free RSVP (paid refunds: ticketRefunds.http.test.ts).
    r = await call("POST", `/api/events/${ev.id}/cancel`, { token: tok(host), body: {} });
    const [validLeft] = await q(`SELECT count(*)::int AS n FROM tickets WHERE event_id = $1 AND status = 'valid'`, [ev.id]);
    const [openOrders] = await q(`SELECT count(*)::int AS n FROM ticket_orders WHERE event_id = $1 AND status = 'completed'`, [ev.id]);
    assert(r.status === 200 && r.body.guests.freeCancelled > 0 && validLeft.n === 0 && openOrders.n === 0, "host cancels an event with guests: every RSVP and ticket cancelled", { r: r.body?.guests, validLeft, openOrders });
  } finally {
    const ids = (await q(`SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`])).map((x) => x.id);
    if (ids.length) {
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))`, [ids]);
      await q(`UPDATE ticket_types SET unlock_after_ticket_type_id = NULL WHERE event_id = ANY($1)`, [ids]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ids]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [ids]);
    }
    await q(`DELETE FROM host_agreement_acceptances WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM user_payout_accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
