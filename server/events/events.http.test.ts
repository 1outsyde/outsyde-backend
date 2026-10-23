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
 * Geocoding tests need the booted server to stub the geocoder (separate process). Boot it with
 *   EVENT_GEOCODE_STUB=40.7,-73.6 EVENT_GEOCODE_STUB_LOG=/some/file   (ignored when NODE_ENV=production)
 * and run this test with the same EVENT_GEOCODE_STUB_LOG (and EVENT_GEOCODE_STUB set to anything). The stub returns the
 * fixed coords for every address except city "Nowhere" (returns null), and appends one line per call to the log file.
 *
 * Mutation checks:
 *  - drop `.strict()` on createSchema → "host ids in the body are refused" fails.
 *  - drop the approval_status check → "pending business can't host" fails.
 *  - drop the price_cents > 0 NOT EXISTS in publish → "paid tickets refused at publish" fails.
 *  - drop `host_user_id = ${userId}` in the publish UPDATE → "stranger can't publish a ready event" fails.
 *  - drop the draft check in GET /slug → "stranger can't see a draft" fails.
 *  - drop `host_user_id = ${userId}` in the cancel UPDATE → "someone else can't cancel my event" fails.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

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
  // users.name is the public display name; first and last names are real names (server/personName.ts).
  await q(`UPDATE users SET name = 'Jay Vibes', first_name = 'Jane', last_name = 'Doe' WHERE id = $1`, [host]);
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
    const photogEvent = r.body.event; eventIds.push(photogEvent.id);
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
    // The stranger has accepted the agreement too, so only the host check can stop them.
    const agO = await call("GET", "/api/events/host-agreement", { token: tok(other) });
    await call("POST", "/api/events/host-agreement/accept", { token: tok(other), body: { version: agO.body?.agreement?.version } });
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(other) });
    const [stillDraft] = await q(`SELECT status FROM events WHERE id = $1`, [ev.id]);
    assert(r.status === 404 && stillDraft.status === "draft", "stranger can't publish a ready event", { r, stillDraft });
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    const [notYet] = await q(`SELECT status FROM events WHERE id = $1`, [ev.id]);
    assert(r.status === 409 && r.body.error.code === "HOST_AGREEMENT_REQUIRED" && notYet.status === "draft", "ready event needs the Event Host Agreement accepted", { r, notYet });
    const ag = await call("GET", "/api/events/host-agreement", { token: tok(host) });
    r = await call("POST", "/api/events/host-agreement/accept", { token: tok(host), body: { version: ag.body?.agreement?.version } });
    assert(r.status === 200 && r.body.agreement.accepted === true, "host accepts the agreement", r);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 200 && r.body.event.status === "published" && r.body.event.publishedAt, "free event publishes", r);
    r = await call("POST", `/api/events/${ev.id}/publish`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "NOT_A_DRAFT", "publishing twice refused", r);

    console.log("Public page");
    r = await call("GET", `/api/events/slug/${ev.slug}`);
    const pub = r.body?.event;
    assert(r.status === 200 && pub.addressHidden === true && pub.addressLine1 === null && pub.venueName === null && pub.latitude === null && pub.city === "Freeport", "stranger sees area only", pub);
    assert(pub.host.name === "Jay Vibes" && pub.host.kind === "user" && !("email" in pub.host), "person host shown by display name", pub?.host);
    assert(!JSON.stringify(r.body).includes("Doe") && !JSON.stringify(r.body).includes("Jane"), "real first and last name never in the payload");
    assert(pub.host.followId === host, "person host: followId is their user id", pub.host);
    const names = r.body.ticketTypes.map((t: any) => `${t.name}:${t.salesStatus}`);
    assert(JSON.stringify(names) === JSON.stringify(["Free RSVP:on_sale", "Second wave:locked", "After comps:locked"]), "hidden + archived types left out; tiers behind free and behind hidden comps locked", names);
    assert(!JSON.stringify(r.body).includes("Secret comps") && !JSON.stringify(r.body).includes("1 Main St"), "nothing hidden leaks in the payload");
    r = await call("GET", `/api/events/slug/${ev.slug.toUpperCase()}`);
    assert(r.status === 200, "slug lookup ignores letter case", r.status);

    console.log("Host follow id");
    r = await call("GET", `/api/events/slug/${bizEvent.slug}`, { token: tok(owner) });
    assert(r.status === 200 && r.body.event.host.followId === biz.id && r.body.event.host.kind === "business", "business host: followId is the business id", r.body?.event?.host);
    assert(!JSON.stringify(r.body.event.host).includes(owner), "business host: owner's user id not in host", r.body?.event?.host);
    r = await call("GET", `/api/events/slug/${photogEvent.slug}`, { token: tok(shooter) });
    assert(r.status === 200 && r.body.event.host.followId === photog.id && r.body.event.host.kind === "photographer", "photographer host: followId is the photographer id", r.body?.event?.host);
    assert(!JSON.stringify(r.body.event.host).includes(shooter), "photographer host: user id not in host", r.body?.event?.host);
    // The id the page hands to Follow really follows the owner (POST /api/follows resolves business and photographer ids).
    for (const [fid, ownerId, label] of [[biz.id, owner, "business"], [photog.id, shooter, "photographer"]] as const) {
      r = await call("POST", "/api/follows", { token: tok(host), body: { targetUserId: fid } });
      const [f] = await q(`SELECT 1 FROM follows WHERE follower_user_id = $1 AND target_user_id = $2`, [host, ownerId]);
      assert(r.status === 201 && !!f, `following the ${label} followId follows its owner`, r);
    }

    console.log("Fee preview and visibility");
    assert(pub.visibility === "public", "public event page says visibility public", pub.visibility);
    {
      const fp = (await call("POST", "/api/events", { token: tok(host), body: { ...base(), title: "Fee Preview Night", visibility: "unlisted" } })).body.event;
      eventIds.push(fp.id);
      const [paid20] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, sort_order) VALUES ($1, 'General', 2000, 50, 0) RETURNING id`, [fp.id]);
      await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, sort_order) VALUES ($1, 'Free RSVP', 0, 50, 1)`, [fp.id]);
      await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, hidden, sort_order) VALUES ($1, 'Secret VIP', 5000, 5, true, 2)`, [fp.id]);
      // Paid events can't be published until payouts ship; open this one directly.
      await q(`UPDATE events SET status = 'published', published_at = now() WHERE id = $1`, [fp.id]);
      r = await call("GET", `/api/events/slug/${fp.slug}`);
      const gen = r.body?.ticketTypes?.find((t: any) => t.name === "General");
      const fre = r.body?.ticketTypes?.find((t: any) => t.name === "Free RSVP");
      assert(r.status === 200 && r.body.event.visibility === "unlisted", "unlisted event says visibility unlisted", r.body?.event);
      assert(gen && gen.serviceFeeCents === 259 && gen.buyerTotalCents === 2259, "$20 type previews fee 259 and total 2259", gen);
      assert(fre && fre.serviceFeeCents === null && fre.buyerTotalCents === null, "free type has null fee and total", fre);
      assert(r.body.ticketTypes.length === 2 && !JSON.stringify(r.body).includes("Secret VIP"), "hidden type still absent", r.body.ticketTypes);
      const badKey = (o: unknown): boolean => !!o && typeof o === "object" && Object.entries(o as object).some(([k, v]) => /rate|percent/i.test(k) || badKey(v));
      assert(!badKey(r.body), "no key mentions a rate or percent", r.body);

      // Preview equals what checkout charges for one ticket (Stripe stub, local only).
      if (STUB_PORT) {
        const piStore: Record<string, any> = {};
        const stub = http.createServer((req, res) => {
          let raw = ""; req.on("data", (c) => (raw += c));
          req.on("end", () => {
            const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
            const form = new URLSearchParams(raw);
            if (req.method === "POST" && req.url === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
            const custM = req.url?.match(/^\/v1\/customers\/([^/?]+)/);
            if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
            if (req.method === "POST" && req.url === "/v1/payment_intents") {
              const id = `pi_ev_${Date.now()}`;
              piStore[id] = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: 0, status: "requires_payment_method", client_secret: `${id}_secret`, metadata: {} };
              return send(200, piStore[id]);
            }
            const cancelM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)\/cancel/);
            if (req.method === "POST" && cancelM) return send(200, { id: cancelM[1], object: "payment_intent", status: "canceled" });
            send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
          });
        });
        await new Promise<void>((x) => stub.listen(STUB_PORT, "127.0.0.1", () => x()));
        try {
          const co = await call("POST", `/api/events/${fp.id}/checkout`, { token: tok(other), body: { ticketTypeId: paid20.id, quantity: 1, idempotencyKey: `${P}-preview` } });
          assert(co.status === 201 && co.body.serviceFeeCents === gen.serviceFeeCents && co.body.totalCents === gen.buyerTotalCents, "preview matches checkout", { co, gen });
        } finally { await new Promise<void>((x) => stub.close(() => x())); }
      } else {
        console.log("  (skipped: preview matches checkout, set EV_TEST_STRIPE_PORT)");
      }
      await q(`UPDATE events SET status = 'draft' WHERE id = $1`, [fp.id]);
      r = await call("GET", `/api/events/slug/${fp.slug}`);
      assert(r.status === 404, "draft still 404 for a stranger", r);
      await q(`UPDATE events SET status = 'paused' WHERE id = $1`, [fp.id]);
      r = await call("GET", `/api/events/slug/${fp.slug}`);
      assert(r.status === 404, "paused still 404 for a stranger", r);
    }

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
    // Cancelling with guests is allowed since Phase 2 PR 4 (tested in ticketRefunds.http.test.ts); this event stays live for the checks below.
    r = await call("POST", `/api/events/${ev.id}/cancel`, { token: tok(owner), body: {} });
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "someone else can't cancel my event", r);
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

    console.log("Day-of address reveal");
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), addressVisibility: "bogus" } });
    assert(r.status === 400 && r.body.error.code === "INVALID_EVENT", "bogus addressVisibility refused", r);
    // Hold a valid ticket on a (seeded as published) event so a holder can read the page.
    const seedHolder = async (eventId: string, holder: string, code: string) => {
      await q(`UPDATE events SET status = 'published', published_at = now() WHERE id = $1`, [eventId]);
      const [tt] = await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity) VALUES ($1, 'Free', 0, 10) RETURNING id`, [eventId]);
      const [o] = await q(`INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count) VALUES ($1, $2, 'completed', 1) RETURNING id`, [eventId, holder]);
      const [it] = await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at) VALUES ($1, $2, $3, $4, 1, 0, 'issued', now()) RETURNING id`, [o.id, eventId, tt.id, holder]);
      await q(`INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, price_cents) VALUES ($1, $2, $3, $4, $5, 1, $6, 0)`, [o.id, it.id, eventId, tt.id, holder, code]);
      await q(`UPDATE ticket_types SET reserved_count = 1 WHERE id = $1`, [tt.id]);
      await q(`UPDATE events SET reserved_count = 1 WHERE id = $1`, [eventId]);
    };
    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), addressVisibility: "ticket_holders_day_of" } });
    assert(r.status === 201 && r.body.event.addressVisibility === "ticket_holders_day_of", "create accepts ticket_holders_day_of", r);
    const dayOfFar = r.body.event; eventIds.push(dayOfFar.id);
    r = await call("GET", `/api/events/${dayOfFar.id}/manage`, { token: tok(host) });
    assert(r.status === 200 && r.body.event.addressVisibility === "ticket_holders_day_of", "manage shows the day-of value", r.body?.event);
    await seedHolder(dayOfFar.id, guest, `${P}dayfar`);
    r = await call("GET", `/api/events/slug/${dayOfFar.slug}`, { token: tok(guest) });
    assert(r.status === 200 && r.body.event.viewerHasTicket === true && r.body.event.addressHidden === true && r.body.event.addressLine1 === null && r.body.event.venueName === null,
      "holder of a day-of event starting in 3 days gets area only", r.body?.event);
    await q(`UPDATE events SET starts_at = now() + interval '3 days', ends_at = now() + interval '3 days 5 hours' WHERE id = $1`, [dayOfFar.id]);
    r = await call("GET", `/api/events/slug/${dayOfFar.slug}`, { token: tok(guest) });
    assert(r.body.event.addressHidden === true && r.body.event.addressLine1 === null, "still hidden at 3 days out");
    {
      const { addressRevealAt } = await import("./eventRules");
      assert(r.body.event.addressRevealAt === addressRevealAt(new Date(r.body.event.startsAt), r.body.event.timezone).toISOString(), "day-of slug route reports addressRevealAt", r.body?.event);
      const plain = await call("POST", "/api/events", { token: tok(host), body: base() });
      eventIds.push(plain.body.event.id);
      const pub = await call("GET", `/api/events/slug/${plain.body.event.slug}`, { token: tok(host) });
      assert(pub.status === 200 && pub.body.event.addressRevealAt === null && "addressRevealAt" in pub.body.event, "non day-of event: addressRevealAt is null", pub);
    }
    r = await call("GET", `/api/events/slug/${dayOfFar.slug}`, { token: tok(host) });
    assert(r.body.event.addressLine1 === "1 Main St" && r.body.event.viewerIsHost === true, "host sees the street on a day-of event", r.body?.event);

    r = await call("POST", "/api/events", { token: tok(host), body: { ...base(), startsAt: inDays(0, 2), endsAt: inDays(0, 7), addressVisibility: "ticket_holders_day_of" } });
    assert(r.status === 201, "day-of event starting in 2 hours created", r);
    const dayOfNear = r.body.event; eventIds.push(dayOfNear.id);
    await seedHolder(dayOfNear.id, guest, `${P}daynear`);
    r = await call("GET", `/api/events/slug/${dayOfNear.slug}`, { token: tok(guest) });
    assert(r.status === 200 && r.body.event.addressLine1 === "1 Main St" && r.body.event.venueName === "The Loft" && !r.body.event.addressHidden,
      "holder sees the street once the reveal has passed", r.body?.event);
    r = await call("GET", `/api/events/slug/${dayOfNear.slug}`, { token: tok(other) });
    assert(r.body.event.addressHidden === true && r.body.event.addressLine1 === null, "non-holder still sees area only after the reveal", r.body?.event);

    console.log("Event geocoding");
    const stubLog = process.env.EVENT_GEOCODE_STUB_LOG;
    const geocodeReady = !!process.env.EVENT_GEOCODE_STUB && !!stubLog;
    if (!geocodeReady) console.log("  ⏭  geocode tests skipped: boot the server with ALLOW_TEST_SEAMS=1 EVENT_GEOCODE_STUB=40.7,-73.6 EVENT_GEOCODE_STUB_LOG=<file> and pass EVENT_GEOCODE_STUB(_LOG) to the test");
    if (geocodeReady) {
    const fs = await import("fs");
    const stubCalls = () => { try { return fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean); } catch { return [] as string[]; } };
    const waitFor = async (fn: () => Promise<boolean> | boolean) => { for (let i = 0; i < 40; i++) { if (await fn()) return true; await new Promise((x) => setTimeout(x, 100)); } return false; };
    const latOf = async (id: string) => (await q(`SELECT latitude, longitude FROM events WHERE id = $1`, [id]))[0];
    const noCoords = () => { const { latitude, longitude, ...rest } = base(); return rest; };

    const callsBefore = stubCalls().length;
    r = await call("POST", "/api/events", { token: tok(host), body: base() });
    const withCoords = r.body.event; eventIds.push(withCoords.id);
    await new Promise((x) => setTimeout(x, 600));
    assert(r.status === 201 && stubCalls().length === callsBefore && Number((await latOf(withCoords.id)).latitude) === 40.65, "create with lat/lng does not call the geocoder", { n: stubCalls().length - callsBefore });

    r = await call("POST", "/api/events", { token: tok(host), body: noCoords() });
    const geo = r.body.event; eventIds.push(geo.id);
    assert(r.status === 201, "create without lat/lng succeeds", r);
    const filled = await waitFor(async () => (await latOf(geo.id)).latitude != null);
    const gc = await latOf(geo.id);
    assert(filled && Number(gc.latitude) === 40.7 && Number(gc.longitude) === -73.6, "stubbed geocoder fills lat/lng after create", gc);

    r = await call("PATCH", `/api/events/${geo.id}`, { token: tok(host), body: { addressLine1: "99 Other Ave" } });
    assert(r.status === 200 && r.body.event.latitude === null && r.body.event.longitude === null, "PATCH of the street clears lat/lng in the response", r.body?.event);
    const refilled = await waitFor(async () => (await latOf(geo.id)).latitude != null);
    assert(refilled && stubCalls().some((l) => l.includes("99 Other Ave")), "PATCH of the street re-geocodes", stubCalls());

    r = await call("PATCH", `/api/events/${geo.id}`, { token: tok(host), body: { title: "Renamed" } });
    await new Promise((x) => setTimeout(x, 400));
    assert(r.status === 200 && Number((await latOf(geo.id)).latitude) === 40.7, "PATCH of an unrelated field keeps lat/lng", r.body?.event);

    r = await call("PATCH", `/api/events/${geo.id}`, { token: tok(host), body: { city: "Elsewhere", latitude: 10, longitude: 20 } });
    await new Promise((x) => setTimeout(x, 400));
    const given = await latOf(geo.id);
    assert(r.status === 200 && Number(given.latitude) === 10 && Number(given.longitude) === 20, "PATCH that sends lat/lng keeps them", given);

    r = await call("POST", "/api/events", { token: tok(host), body: { ...noCoords(), city: "Nowhere" } });
    const nul = r.body.event; eventIds.push(nul.id);
    await waitFor(() => stubCalls().some((l) => l.includes("Nowhere")));
    await new Promise((x) => setTimeout(x, 400));
    const nc = await latOf(nul.id);
    r = await call("GET", `/api/events/${nul.id}/manage`, { token: tok(host) });
    assert(nc.latitude == null && r.status === 200 && r.body.event.title === "Rooftop Party!", "geocoder returning null leaves the event saved", { nc, status: r.status });

    r = await call("POST", "/api/events", { token: tok(host), body: { ...noCoords(), city: undefined, state: undefined } });
    eventIds.push(r.body.event.id);
    const callsNow = stubCalls().length;
    await new Promise((x) => setTimeout(x, 400));
    assert(r.status === 201 && stubCalls().length === callsNow && stubCalls().every((l) => !l.includes("Rooftop")), "no city/state means no geocode call");

    console.log("Stale geocode result can't land");
    process.env.ALLOW_TEST_SEAMS = "1";
    const gmod = await import("./eventGeocode");
    let seen = 0;
    gmod.setGeocoderForTest(async () => { seen++; return { latitude: 1.5, longitude: 2.5 }; });
    r = await call("POST", "/api/events", { token: tok(host), body: { ...noCoords(), city: "Nowhere" } });
    const stale = r.body.event; eventIds.push(stale.id);
    await waitFor(() => stubCalls().some((l) => l.includes("Nowhere")));
    await q(`UPDATE events SET latitude = NULL, longitude = NULL WHERE id = $1`, [stale.id]);
    // A result for the OLD address arrives after the row moved on: it must not be written.
    gmod.geocodeEventInBackground(stale.id, { addressLine1: "1 Main St", city: "Old City", state: "NY", postalCode: "11520" });
    await waitFor(() => seen > 0);
    await new Promise((x) => setTimeout(x, 500));
    assert(seen > 0 && (await latOf(stale.id)).latitude == null, "stale geocode result for an old address is dropped", await latOf(stale.id));
    gmod.geocodeEventInBackground(stale.id, { addressLine1: "1 Main St", city: "Nowhere", state: "NY", postalCode: "11520" });
    const landed = await waitFor(async () => (await latOf(stale.id)).latitude != null);
    assert(landed && Number((await latOf(stale.id)).latitude) === 1.5, "a result for the current address still lands", await latOf(stale.id));
    gmod.setGeocoderForTest(null);
    }
  } finally {
    // Every event a test user hosts (also ones a mutated server let through).
    eventIds.push(...(await q(`SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`])).map((x) => x.id));
    if (eventIds.length) {
      await q(`DELETE FROM ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))`, [eventIds]);
      await q(`DELETE FROM tickets WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [eventIds]);
      await q(`DELETE FROM events WHERE id = ANY($1)`, [eventIds]);
    }
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM follows WHERE follower_user_id IN (SELECT id FROM users WHERE email LIKE $1) OR target_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM photographers WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM businesses WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM host_agreement_acceptances WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
