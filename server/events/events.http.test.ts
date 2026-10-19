/**
 * Events & Ticketing Phase 1 PR 1: HTTP integration tests for /api/events.
 *
 * Run with: npx tsx server/events/events.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres that has
 * migrations/056_events_tickets.sql applied.
 *   EV_TEST_BASE_URL   e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - drop `.strict()` on createSchema → "host ids in the body are refused" fails.
 *  - drop the approval_status check → "pending business can't host" fails.
 *  - drop the price_cents > 0 NOT EXISTS in publish → "paid tickets refused at publish" fails.
 *  - drop `host_user_id = ${userId}` in the publish UPDATE → "stranger can't publish a ready event" fails.
 *  - drop the draft check in GET /slug → "stranger can't see a draft" fails.
 *  - drop `reserved_count = 0` in cancel → "cancel with guests refused" fails.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `ev${Date.now().toString(36)}`;
  const mkUser = async (s: string, extra = "") => (await q(
    `INSERT INTO users (id, email, name, username${extra ? ", " + extra.split("=")[0] : ""}) VALUES (gen_random_uuid(), $1, $2, $3${extra ? ", " + extra.split("=")[1] : ""}) RETURNING id`,
    [`${P}-${s}@test.local`, `Person ${s}`, `${P}${s}`.slice(0, 20)],
  ))[0].id as string;
  const host = await mkUser("host");
  await q(`UPDATE users SET name = 'Jane Doe', first_name = 'Jane' WHERE id = $1`, [host]);
  const other = await mkUser("other");
  const guest = await mkUser("guest");
  const owner = await mkUser("owner");
  const pendingOwner = await mkUser("pend");
  const shooter = await mkUser("shoot", "is_photographer=true");
  const banned = await mkUser("ban", "is_active=false");
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  const [biz] = await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, logo_image) VALUES (gen_random_uuid(), $1, $2, 'Events', 'approved', 'https://img.test/logo.png') RETURNING id`, [owner, `${P} Lounge`]);
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES (gen_random_uuid(), $1, $2, 'Events', 'pending')`, [pendingOwner, `${P} Pending`]);
  // Owner with an older pending business and a newer approved one: the approved one hosts.
  const twoBizOwner = await mkUser("two");
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'Events', 'pending', now() - interval '30 days')`, [twoBizOwner, `${P} Old`]);
  const [approvedSecond] = await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status) VALUES (gen_random_uuid(), $1, $2, 'Events', 'approved') RETURNING id`, [twoBizOwner, `${P} New`]);
  const [photog] = await q(`INSERT INTO photographers (id, user_id, display_name, hourly_rate) VALUES (gen_random_uuid(), $1, $2, 100) RETURNING id`, [shooter, `${P} Shots`]);

  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  const base = () => ({
    title: "Rooftop Party!", description: "Bring friends", startsAt: inDays(10), endsAt: inDays(10, 5), timezone: "America/New_York",
    venueName: "The Loft", addressLine1: "1 Main St", city: "Freeport", state: "NY", postalCode: "11520", latitude: 40.65, longitude: -73.58,
    capacity: 100,
  });
  const eventIds: string[] = [];

  try {
    console.log("Create");
    let r = await call("POST", "/api/events", { body: base() });
    assert(r.status === 401, "signed out can't create", r);

    r = await call("POST", "/api/events", { token: tok(host), body: base() });
    assert(r.status === 201 && r.body.event.status === "draft", "consumer creates a draft", r);
    const ev = r.body.event; eventIds.push(ev.id);
    assert(/^rooftop-party-[a-z2-9]{6}$/.test(ev.slug), "slug from title + random tail", ev.slug);
    assert(ev.hostType === "user" && ev.addressVisibility === "ticket_holders" && ev.refundPolicy === "no_refunds", "defaults: user host, address hidden, no refunds", ev);

    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), hostBusinessId: biz.id } });
    assert(r.status === 400, "host ids in the body are refused", r);
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), hostAs: "business" } });
    assert(r.status === 403 && r.body.error.code === "NOT_A_BUSINESS_OWNER", "non-owner can't host as a business", r);
    r = await call("POST", "/api/events", { token: tok(pendingOwner), body: { ...base(), hostAs: "business" } });
    assert(r.status === 403 && r.body.error.code === "BUSINESS_NOT_APPROVED", "pending business can't host", r);
    r = await call("POST", "/api/events", { token: tok(owner), body: { ...base(), hostAs: "business" } });
    assert(r.status === 201 && r.body.event.hostBusinessId === biz.id, "approved owner hosts as their business", r);
    const bizEvent = r.body.event; eventIds.push(bizEvent.id);
    r = await call("POST", "/api/events", { token: tok(twoBizOwner), body: { ...base(), hostAs: "business" } });
    assert(r.status === 201 && r.body.event.hostBusinessId === approvedSecond.id, "owner with a pending + an approved business hosts as the approved one", r);
    r = await call("POST", "/api/events", { token: tok(shooter), body: { ...base(), hostAs: "photographer" } });
    assert(r.status === 201 && r.body.event.hostPhotographerId === photog.id, "photographer hosts as their profile", r);
    eventIds.push(r.body.event.id);
    r = await call("POST", "/api/events", { token: tok(banned), body: base() });
    assert(r.status === 403 && r.body.error.code === "ACCOUNT_INACTIVE", "banned account can't host", r);

    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), endsAt: inDays(9) } });
    assert(r.status === 400 && r.body.error.code === "INVALID_EVENT_TIMES", "end before start refused", r);
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), startsAt: inDays(-1), endsAt: inDays(1) } });
    assert(r.status === 400 && r.body.error.code === "INVALID_EVENT_TIMES", "start in the past refused", r);
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), timezone: "Mars/Base" } });
    assert(r.status === 400, "unknown time zone refused", r);
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), refundPolicy: "until_cutoff" } });
    assert(r.status === 400 && r.body.error.code === "INVALID_REFUND_POLICY", "refund cutoff required", r);
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), coverImageUrl: "javascript:alert(1)" } });
    assert(r.status === 400, "non-http cover link refused", r);
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), title: "   " } });
    assert(r.status === 400, "blank title refused", r);

    console.log("Strangers and drafts");
    r = await call("GET", `/api/events/${ev.id}/manage`, { token: tok(other) });
    assert(r.status === 404, "stranger can't open manage", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(other), body: { title: "Hacked" } });
    assert(r.status === 404, "stranger can't edit", r);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(other) });
    assert(r.status === 404, "stranger can't publish", r);
    r = await call("POST", `/api/events/${ev.id}/cancel`, { token: tok(other), body: {} });
    assert(r.status === 404, "stranger can't cancel", r);
    r = await call("GET", `/api/events/slug/${ev.slug}`);
    assert(r.status === 404, "stranger can't see a draft", r);
    r = await call("GET", `/api/events/slug/${ev.slug}`, { token: tok(host) });
    assert(r.status === 200 && r.body.event.viewerIsHost === true && r.body.event.addressLine1 === "1 Main St", "host previews own draft with address", r);
    r = await call("GET", "/api/events/mine", { token: tok(host) });
    assert(r.status === 200 && r.body.events.length === 1 && r.body.events[0].id === ev.id, "my events lists only mine", r);

    console.log("Publish");
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "NO_TICKET_TYPES", "publish needs a ticket type", r);
    const [paidType] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, unlock_after_ticket_type_id) VALUES ($1, 'General', 2000, 50, NULL) RETURNING id`, [ev.id]);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "PAID_TICKETS_NOT_AVAILABLE", "paid tickets refused at publish", r);
    await q(`UPDATE ticket_types SET status = 'archived' WHERE id = $1`, [paidType.id]);
    const [onlyHidden] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, hidden) VALUES ($1, 'Hidden only', 0, 5, true) RETURNING id`, [ev.id]);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "NO_VISIBLE_TICKET_TYPES", "publish needs a visible ticket type", r);
    await q(`UPDATE ticket_types SET status = 'archived' WHERE id = $1`, [onlyHidden.id]);
    const [freeType] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, per_account_limit, sort_order) VALUES ($1, 'Free RSVP', 0, 10, 1, 0) RETURNING id`, [ev.id]);
    const [comps] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, hidden, sort_order) VALUES ($1, 'Secret comps', 0, 5, true, 1) RETURNING id`, [ev.id]);
    await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, unlock_after_ticket_type_id, sort_order) VALUES ($1, 'After comps', 0, 5, $2, 3)`, [ev.id, comps.id]);
    await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, unlock_after_ticket_type_id, sort_order) VALUES ($1, 'Second wave', 0, 20, $2, 2)`, [ev.id, freeType.id]);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(other) });
    const [stillDraft] = await q(`SELECT status FROM events WHERE id = $1`, [ev.id]);
    assert(r.status === 404 && stillDraft.status === "draft", "stranger can't publish a ready event", { r, stillDraft });
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 200 && r.body.event.status === "published" && r.body.event.publishedAt, "free event publishes", r);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "NOT_A_DRAFT", "publishing twice refused", r);

    console.log("Public page");
    r = await call("GET", `/api/events/slug/${ev.slug}`);
    const pub = r.body?.event;
    assert(r.status === 200 && pub.addressHidden === true && pub.addressLine1 === null && pub.venueName === null && pub.latitude === null && pub.city === "Freeport", "stranger sees area only", pub);
    assert(pub.host.name === "Jane" && pub.host.kind === "user" && !("email" in pub.host), "person host shown by first name only", pub?.host);
    assert(!JSON.stringify(r.body).includes("Doe"), "last name never in the payload");
    const names = r.body.ticketTypes.map((t: any) => `${t.name}:${t.salesStatus}`);
    assert(JSON.stringify(names) === JSON.stringify(["Free RSVP:on_sale", "Second wave:locked", "After comps:locked"]), "hidden + archived types left out; tiers behind free and behind hidden comps locked", names);
    assert(!JSON.stringify(r.body).includes("Secret comps") && !JSON.stringify(r.body).includes("1 Main St"), "nothing hidden leaks in the payload");
    r = await call("GET", `/api/events/slug/${ev.slug.toUpperCase()}`);
    assert(r.status === 200, "slug lookup ignores letter case", r.status);

    // A guest with a valid ticket sees the address.
    const [order] = await q(`INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count) VALUES ($1, $2, 'completed', 1) RETURNING id`, [ev.id, guest]);
    const [item] = await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at) VALUES ($1, $2, $3, $4, 1, 0, 'issued', now()) RETURNING id`, [order.id, ev.id, freeType.id, guest]);
    await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, price_cents) VALUES ($1, $2, $3, $4, $5, 1, $6, 0)`, [order.id, item.id, ev.id, freeType.id, guest, `${P}code`]);
    await q(`UPDATE ticket_types SET reserved_count = 1 WHERE id = $1`, [freeType.id]);
    await q(`UPDATE events SET reserved_count = 1 WHERE id = $1`, [ev.id]);
    r = await call("GET", `/api/events/slug/${ev.slug}`, { token: tok(guest) });
    assert(r.status === 200 && r.body.event.viewerHasTicket === true && r.body.event.addressLine1 === "1 Main St", "ticket holder sees the address", r.body?.event);
    r = await call("GET", `/api/events/slug/${ev.slug}`, { token: tok(other) });
    assert(r.body.event.addressHidden === true, "signed-in stranger still sees area only");
    const free = r.body.ticketTypes.find((t: any) => t.name === "Free RSVP");
    assert(free.remaining === 9, "remaining counts taken spots", free);

    console.log("Editing a published event");
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { refundPolicy: "until_cutoff", refundCutoffHours: 48 } });
    assert(r.status === 200 && r.body.event.refundPolicy === "until_cutoff" && r.body.event.refundCutoffHours === 48, "no refunds -> refunds allowed after publish", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { refundCutoffHours: 72 } });
    assert(r.status === 409 && r.body.error.code === "REFUND_POLICY_LOCKED", "stricter cutoff refused after publish", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { refundPolicy: "no_refunds" } });
    assert(r.status === 409 && r.body.error.code === "REFUND_POLICY_LOCKED", "back to no refunds refused after publish", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { refundCutoffHours: 24 } });
    assert(r.status === 200 && r.body.event.refundCutoffHours === 24, "more flexible cutoff allowed", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { capacity: 1 } });
    assert(r.status === 200, "capacity equal to taken allowed", r);
    r = await call("GET", `/api/events/slug/${ev.slug}`);
    assert(r.body.event.soldOut === true && r.body.ticketTypes.every((t: any) => t.salesStatus === "sold_out"), "full event shows sold out", r.body);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { capacity: null } });
    assert(r.status === 200 && r.body.event.capacity === null, "capacity can be removed", r);
    await q(`UPDATE events SET capacity = 5, reserved_count = 3 WHERE id = $1`, [ev.id]);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { capacity: 2 } });
    assert(r.status === 409 && r.body.error.code === "CAPACITY_BELOW_TAKEN", "capacity below taken refused", r);
    await q(`UPDATE events SET capacity = 100, reserved_count = 1 WHERE id = $1`, [ev.id]);
    const [{ starts_at: realStart }] = await q(`SELECT starts_at FROM events WHERE id = $1`, [ev.id]);
    await q(`UPDATE events SET starts_at = now() - interval '1 hour', ends_at = now() + interval '3 hours' WHERE id = $1`, [ev.id]);
    const [{ starts_at: liveStart }] = await q(`SELECT starts_at FROM events WHERE id = $1`, [ev.id]);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { startsAt: new Date(liveStart).toISOString(), endsAt: new Date(Date.now() + 5 * 3600000).toISOString() } });
    assert(r.status === 200, "live event: resending the same start while changing the end is fine", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { startsAt: new Date(Date.now() - 7200000).toISOString() } });
    assert(r.status === 400 && r.body.error.code === "INVALID_EVENT_TIMES", "moving the start into the past refused", r);
    await q(`UPDATE events SET starts_at = $2, ends_at = $2::timestamptz + interval '5 hours' WHERE id = $1`, [ev.id, realStart]);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { hostAs: "business" } });
    assert(r.status === 400, "host can't be switched by edit", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: {} });
    assert(r.status === 400 && r.body.error.code === "NOTHING_TO_UPDATE", "empty edit refused", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { title: "Rooftop Party Two", city: "" } });
    assert(r.status === 200 && r.body.event.title === "Rooftop Party Two" && r.body.event.city === null && r.body.event.slug === ev.slug, "edit title keeps the link; blank city clears", r.body?.event);

    console.log("Cancel");
    r = await call("POST", `/api/events/${ev.id}/cancel`, { token: tok(host), body: {} });
    assert(r.status === 409 && r.body.error.code === "EVENT_HAS_GUESTS", "cancel with guests refused (Phase 2)", r);
    r = await call("POST", `/api/events/${bizEvent.id}/cancel`, { token: tok(owner), body: { reason: "Rain" } });
    assert(r.status === 200 && r.body.event.status === "cancelled", "draft with no guests cancels", r);
    r = await call("PATCH", `/api/events/${bizEvent.id}`, { token: tok(owner), body: { title: "Back" } });
    assert(r.status === 409 && r.body.error.code === "EVENT_CANCELLED", "cancelled event can't be edited", r);
    r = await call("POST", `/api/events/${bizEvent.id}/cancel`, { token: tok(owner), body: {} });
    assert(r.status === 409 && r.body.error.code === "ALREADY_CANCELLED", "cancel twice refused", r);
    r = await call("GET", `/api/events/slug/${bizEvent.slug}`);
    assert(r.status === 200 && r.body.event.status === "cancelled" && r.body.event.host.name === `${P} Lounge`, "cancelled event still has a page, shown as the business", r.body?.event);

    await q(`UPDATE users SET is_active = false WHERE id = $1`, [host]);
    r = await call("GET", `/api/events/slug/${ev.slug}`);
    assert(r.status === 404, "banned host's event hidden from the public", r);
    await q(`UPDATE users SET is_active = true WHERE id = $1`, [host]);
    r = await call("GET", `/api/events/slug/${ev.slug}`);
    assert(r.status === 200, "page back once the host is active again", r.status);

    await q(`UPDATE events SET status = 'paused' WHERE id = $1`, [ev.id]);
    r = await call("GET", `/api/events/slug/${ev.slug}`);
    assert(r.status === 404, "paused event hidden from the public", r);
    r = await call("PATCH", `/api/events/${ev.id}`, { token: tok(host), body: { title: "Sneaky" } });
    assert(r.status === 409 && r.body.error.code === "EVENT_PAUSED", "host can't edit a paused event", r);
  } finally {
    // Every event a test user hosts (also ones a mutated server let through).
    eventIds.push(...(await q(`SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`])).map((x) => x.id));
    if (eventIds.length) {
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    }
    await q(`DELETE FROM photographers WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
