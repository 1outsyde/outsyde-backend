/**
 * p4-team step 3: personal promoter links + sales tracking.
 *
 *   - One link per promoter (role 'host') per event; standing promoters get one per event of their host.
 *   - Checkout and RSVP take an optional `linkCode`; the order records the link it came through.
 *     Unknown, malformed, other event, the buyer's own and a removed promoter's code: the sale still goes
 *     through, it just counts for nobody (Legend 2026-10-30, decisions 1 and 2).
 *   - GET /api/events/:id/team/me adds `promoter` (code, url, rsvps, ticketsSold, salesCents) for promoters,
 *     null for everyone else. Free RSVPs are counted apart from paid tickets (decision 4).
 *   - Counted like the host summary: tickets 'valid' on 'completed' orders, so pending checkouts, refunds and
 *     cancelled RSVPs never count.
 *   - GET /api/events/:id/summary adds `promoters` (per promoter breakdown) for the host and co-hosts (decision 5).
 *   - Links for promoters only (decision 6): Admissions, co-hosts and the host get none.
 *
 * SCRATCH ONLY. Local scratch Postgres with migrations through 085 (EV_TEST_PG_URL, localhost only) and DATABASE_URL
 * via the neon shim preload. Runs the event routers in this process; Stripe goes to a stub in this process
 * (NODE_OPTIONS also needs --import ./.dev/stripe-stub-preload.mjs and STRIPE_STUB_PORT). Skips when EV_TEST_PG_URL
 * is unset.
 *
 * Mutation checks (run 2026-10-30, each caught):
 *  - drop `promoter_user_id <> buyer` from the link lookup → "own link doesn't count" fails.
 *  - drop the active promoter check from the link lookup → "removed promoter: new sales don't count" fails.
 *  - drop `l.event_id = <event>` from the link lookup → "another event's code doesn't count here" fails.
 *  - count every ticket as sold (no price split) → "A: 2 paid tickets" and "refund drops the sale" fail.
 *  - drop the standing team half of ensurePromoterLinks → "standing promoter gets their own link" fails.
 *  - drop the role filter on event members in ensurePromoterLinks → "only promoters are listed" fails.
 *  - counts use `o.status = 'completed'` AND `t.status = 'valid'` (the host summary's rule). Each covers the other
 *    (refunds and cancellations change both; pending orders have no tickets), so dropping one alone still passes
 *    on purpose; dropping both makes "cancelled RSVP drops" and "refund drops the sale" fail.
 *  - the `seen.has(PROMOTER_ROLE)` check in /team/me is backed by the role filter in ensurePromoterLinks, so
 *    loosening it alone still passes on purpose (covered by the mutation above).
 */
import http from "http";

const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.STRIPE_STUB_PORT || "0");
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

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL (+ DATABASE_URL via the shim) to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  if (!STUB_PORT) throw new Error("refusing to run: set STRIPE_STUB_PORT and preload ./.dev/stripe-stub-preload.mjs");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  process.env.FRONTEND_URL = "https://goutsyde.test";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  // ── Stripe stub (same shape as ticketCheckout.http.test.ts): PaymentIntents keep amount + metadata ──
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
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const id = `pi_pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        piStore[id] = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: 0, status: "requires_payment_method",
          client_secret: `${id}_secret`, metadata, customer: form.get("customer") };
        return send(200, piStore[id]);
      }
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)$/);
      if (req.method === "GET" && piM) { const pi = piStore[piM[1]]; return pi ? send(200, pi) : send(404, { error: { message: "No such payment_intent" } }); }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const express = (await import("express")).default;
  const { setNoticeDepsForTest } = await import("./ticketNotices");
  setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async () => true, createActivity: async () => {}, sendDoorInvite: async () => {},
  } as any);
  const { handleTicketPaymentSucceeded } = await import("./ticketCheckout");
  const app = express();
  app.use(express.json());
  // Same order as server/index.ts.
  app.use("/api/events", (await import("./doorRouter")).default);
  app.use("/api/events", (await import("./eventsRouter")).default);
  app.use("/api/events", (await import("./ticketsRouter")).default);
  app.use("/api/events", (await import("./ticketCheckout")).default);
  app.use("/api/events", (await import("./ticketRefunds")).default);
  const srv: http.Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}) => callAt(BASE, m, p, o);

  const P = `pl${Date.now().toString(36)}`;
  const mkUser = async (s: string) => {
    const username = `${P}${s}`.slice(0, 24);
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
      [`${P}-${s}@test.local`, `Person ${s}`, `First${s}`, username],
    ))[0].id as string;
    return { id, username };
  };
  const host = await mkUser("host");
  const pA = await mkUser("pa");       // promoter, this event
  const pS = await mkUser("ps");       // standing promoter (every event of the host)
  const pR = await mkUser("pr");       // promoter, removed part way through
  const door = await mkUser("door");   // Admissions
  const coT = await mkUser("cot");     // co-host, team level
  const stranger = await mkUser("str");
  const buyers: Array<{ id: string; username: string }> = [];
  for (let i = 0; i < 12; i++) buyers.push(await mkUser(`b${i}`));
  const ht = tok(host.id);

  const mkEvent = async (slug: string) => (await q(
    `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
     VALUES ($1, $2, $3, 'published', now() + interval '7 days', now() + interval '7 days 5 hours', 'America/New_York', now())
     RETURNING id, slug`,
    [host.id, `${P}-${slug}`, `${P} ${slug}`],
  ))[0] as { id: string; slug: string };
  const ev = await mkEvent("main");
  const ev2 = await mkEvent("other");
  const mkType = async (eventId: string, name: string, priceCents: number) => (await q(
    `INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, $2, $3, 100, 1, 10) RETURNING id`,
    [eventId, name, priceCents],
  ))[0].id as string;
  const free = await mkType(ev.id, "RSVP", 0);
  const ga = await mkType(ev.id, "GA", 2500);

  const invite = async (u: { username: string }, scope: "event" | "standing", role: string) => {
    const r = await call("POST", `/api/events/${ev.id}/door/team`, { token: ht, body: { username: u.username, scope, role } });
    if (r.status !== 201) throw new Error(`invite failed ${JSON.stringify(r)}`);
  };
  await invite(pA, "event", "host");
  await invite(pS, "standing", "host");
  await invite(pR, "event", "host");
  await invite(door, "event", "door");
  await invite(coT, "event", "cohost");
  await q(`UPDATE event_door_members SET accepted_at = now() WHERE event_id = $1 AND accepted_at IS NULL`, [ev.id]);
  await q(`UPDATE event_door_team SET accepted_at = now() WHERE host_user_id = $1 AND accepted_at IS NULL`, [host.id]);

  const me = (u: { id: string }, eventId = ev.id) => call("GET", `/api/events/${eventId}/team/me`, { token: tok(u.id) });
  const rsvp = (u: { id: string }, body: Record<string, unknown>, eventId = ev.id) =>
    call("POST", `/api/events/${eventId}/rsvp`, { token: tok(u.id), body: { ticketTypeId: free, ...body } });
  const linkOf = async (orderId: string) => (await q(`SELECT promoter_link_id FROM ticket_orders WHERE id = $1`, [orderId]))[0]?.promoter_link_id ?? null;
  const linkIdFor = async (userId: string, eventId = ev.id) =>
    (await q(`SELECT id FROM event_promoter_links WHERE event_id = $1 AND promoter_user_id = $2`, [eventId, userId]))[0]?.id ?? null;
  const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
  /** True only when the order has a link and it is this promoter's (never null === null). */
  const countsFor = async (orderId: string | undefined, u: { id: string }) => {
    if (!orderId) return false;
    const [got, want] = [await linkOf(orderId), await linkIdFor(u.id)];
    return got !== null && got === want;
  };
  const countsForNobody = async (orderId: string | undefined) => !!orderId && (await linkOf(orderId)) === null;

  try {
    console.log("\nlinks");
    let r = await me(pA);
    const codeA = r.body?.promoter?.code;
    assert(r.status === 200 && CODE_RE.test(codeA ?? ""), "promoter gets an 8 character link code", r.body?.promoter);
    assert(r.body?.promoter?.url === `https://goutsyde.test/e/${ev.slug}?ref=${codeA}`, "link opens the event page with the code", r.body?.promoter);
    assert(r.body?.promoter?.rsvps === 0 && r.body?.promoter?.ticketsSold === 0 && r.body?.promoter?.salesCents === 0, "no sales yet", r.body?.promoter);
    r = await me(pA);
    assert(CODE_RE.test(codeA ?? "") && r.body?.promoter?.code === codeA, "same link every time (one per promoter per event)", r.body?.promoter);
    r = await me(pS);
    const codeS = r.body?.promoter?.code;
    assert(r.status === 200 && CODE_RE.test(codeS ?? "") && codeS !== codeA, "standing promoter gets their own link", r.body?.promoter);
    r = await me(pS, ev2.id);
    const codeS2 = r.body?.promoter?.code;
    assert(r.status === 200 && CODE_RE.test(codeS2 ?? "") && codeS2 !== codeS, "standing promoter: a different link for each event", r.body?.promoter);
    r = await me(pR);
    const codeR = r.body?.promoter?.code;
    assert(CODE_RE.test(codeR ?? ""), "second event promoter gets a link", r.body?.promoter);
    r = await me(door);
    assert(r.status === 200 && r.body?.promoter === null, "Admissions: no link", r.body);
    r = await me(coT);
    assert(r.status === 200 && r.body?.promoter === null, "co-host: no link (promoters only for now)", r.body);
    assert((await me(stranger)).status === 404, "stranger: still 404");

    console.log("\nRSVPs through a link");
    const [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11] = buyers;
    r = await rsvp(b0, { linkCode: codeA });
    assert(r.status === 201 && (await countsFor(r.body.order.id, pA)), "RSVP through A's link counts for A", r.body);
    r = await rsvp(b1, { linkCode: (codeA ?? "").toLowerCase(), quantity: 2 });
    assert(r.status === 201 && (await countsFor(r.body.order.id, pA)), "code in lower case still counts", r.body);
    const b1Order = r.body?.order?.id;
    r = await rsvp(b2, { linkCode: "ZZZZZZZZ" });
    assert(r.status === 201 && (await countsForNobody(r.body.order.id)), "unknown code: RSVP goes through, counts for nobody", r.body);
    r = await rsvp(b3, { linkCode: codeS2 });
    assert(CODE_RE.test(codeS2 ?? "") && r.status === 201 && (await countsForNobody(r.body.order.id)), "another event's code doesn't count here", r.body);
    r = await rsvp(pA, { linkCode: codeA });
    assert(CODE_RE.test(codeA ?? "") && r.status === 201 && (await countsForNobody(r.body.order.id)), "own link doesn't count", r.body);
    r = await rsvp(b4, {});
    assert(r.status === 201 && (await countsForNobody(r.body.order.id)), "no code (old app and old website): unchanged", r.body);
    r = await rsvp(b5, { linkCode: "!!" });
    assert(r.status === 201 && (await countsForNobody(r.body.order.id)), "malformed code: RSVP goes through", r.body);
    r = await rsvp(b6, { linkCode: codeS });
    assert(r.status === 201 && (await countsFor(r.body.order.id, pS)), "standing promoter's link counts for them", r.body);
    r = await rsvp(b7, { linkCode: codeA, idempotencyKey: `${P}-key-b7` });
    const b7Order = r.body?.order?.id;
    r = await rsvp(b7, { linkCode: codeS, idempotencyKey: `${P}-key-b7` });
    assert(r.status === 200 && r.body?.repeated === true && r.body?.order?.id === b7Order && (await countsFor(b7Order, pA)),
      "repeated request keeps the first link", r.body);

    console.log("\npaid tickets through a link");
    const checkout = (u: { id: string }, body: Record<string, unknown>) =>
      call("POST", `/api/events/${ev.id}/checkout`, { token: tok(u.id), body: { ticketTypeId: ga, ...body } });
    r = await checkout(b8, { quantity: 2, linkCode: codeA, paymentSheet: true });
    assert(r.status === 201 && (await countsFor(r.body.orderId, pA)), "checkout through A's link (with paymentSheet) records A", r.body);
    const paidOrder = r.body?.orderId;
    const pi = piStore[r.body?.paymentIntentId];
    pi.status = "succeeded"; pi.amount_received = pi.amount;
    await handleTicketPaymentSucceeded(pi);
    assert((await q(`SELECT status FROM ticket_orders WHERE id = $1`, [paidOrder]))[0]?.status === "completed" && (await countsFor(paidOrder, pA)),
      "paying keeps the link", null);
    r = await checkout(b9, { quantity: 1, linkCode: codeA });
    assert(r.status === 201, "second checkout through A's link, left unpaid", r.body);

    console.log("\nwhat a promoter sees");
    r = await me(pA);
    assert(r.body?.promoter?.rsvps === 4, "A: 4 RSVPs (b0, b1 x2, b7)", r.body?.promoter);
    assert(r.body?.promoter?.ticketsSold === 2, "A: 2 paid tickets; pending checkout doesn't count", r.body?.promoter);
    assert(r.body?.promoter?.salesCents === 5000, "A: ticket price total $50", r.body?.promoter);
    r = await me(pS);
    assert(r.body?.promoter?.rsvps === 1 && r.body?.promoter?.ticketsSold === 0 && r.body?.promoter?.salesCents === 0, "S sees only their own numbers", r.body?.promoter);
    assert(!JSON.stringify(r.body).includes(b6.username) && !JSON.stringify(r.body).includes("Firstb6"), "promoter sees no buyer names", r.body);

    console.log("\nrefunds and cancelled RSVPs drop out");
    r = await call("POST", `/api/events/orders/${b1Order}/cancel`, { token: tok(b1.id) });
    assert(r.status === 200, "b1 cancels their RSVP", r.body);
    r = await me(pA);
    assert(r.body?.promoter?.rsvps === 2, "cancelled RSVP drops from A's count", r.body?.promoter);
    r = await call("POST", `/api/events/${ev.id}/orders/${paidOrder}/refund`, { token: ht });
    assert(r.status === 200, "host refunds the paid order", r.body);
    r = await me(pA);
    assert(r.body?.promoter?.ticketsSold === 0 && r.body?.promoter?.salesCents === 0, "refund drops the sale", r.body?.promoter);

    console.log("\nremoved promoter");
    r = await rsvp(b10, { linkCode: codeR });
    assert(r.status === 201 && (await countsFor(r.body.order.id, pR)), "R's link counts while R is on the team", r.body);
    r = await call("DELETE", `/api/events/${ev.id}/door/team/${pR.id}?scope=event&role=host`, { token: ht });
    assert(r.status === 200, "host removes R", r.body);
    r = await rsvp(b11, { linkCode: codeR });
    assert(CODE_RE.test(codeR ?? "") && r.status === 201 && (await countsForNobody(r.body.order.id)), "removed promoter: new sales don't count, the RSVP still goes through", r.body);
    assert((await me(pR)).status === 404, "removed promoter loses their team view");

    console.log("\nhost and co-host breakdown");
    r = await call("GET", `/api/events/${ev.id}/summary`, { token: ht });
    const list: any[] = r.body?.promoters ?? [];
    const row = (u: { username: string }) => list.find((x) => x.username === u.username);
    assert(r.status === 200 && Array.isArray(r.body?.promoters), "host summary has a promoter breakdown", r.body);
    assert(row(pA)?.code === codeA && row(pA)?.rsvps === 2 && row(pA)?.ticketsSold === 0 && row(pA)?.salesCents === 0 && row(pA)?.active === true, "A's row", row(pA));
    assert(row(pS)?.rsvps === 1 && row(pS)?.active === true, "standing promoter's row", row(pS));
    assert(row(pR)?.rsvps === 1 && row(pR)?.active === false, "removed promoter keeps past sales, marked not active", row(pR));
    assert(list.length === 3 && !list.some((x) => x.username === door.username || x.username === coT.username), "only promoters are listed", list);
    assert(list.length > 0 && list.every((x) => Object.keys(x).sort().join(",") === "active,code,firstName,rsvps,salesCents,ticketsSold,userId,username"), "no buyer or money internals in rows", list[0]);
    r = await call("GET", `/api/events/${ev.id}/summary`, { token: tok(coT.id) });
    assert(r.status === 200 && list.length > 0 && (r.body?.promoters ?? []).length === list.length, "co-host sees the same breakdown", r.body?.promoters);
    assert((await call("GET", `/api/events/${ev.id}/summary`, { token: tok(pA.id) })).status === 404, "promoter can't open the host summary");
    r = await call("GET", `/api/events/${ev2.id}/summary`, { token: ht });
    assert(r.status === 200 && (r.body?.promoters ?? []).length === 1 && r.body.promoters[0].username === pS.username, "other event lists only its own promoters", r.body?.promoters);
  } finally {
    const ids = [ev.id, ev2.id];
    const clean = async (t: string, p: unknown[]) => { try { await q(t, p); } catch (err) { console.error(`  cleanup: ${(err as Error).message}`); } };
    await clean(`DELETE FROM tickets WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_order_items WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_orders WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_account_counts WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id = ANY($1))`, [ids]);
    await clean(`DELETE FROM event_promoter_links WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM ticket_types WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_team_schedules WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_door_members WHERE event_id = ANY($1)`, [ids]);
    await clean(`DELETE FROM event_door_team WHERE host_user_id = $1`, [host.id]);
    await clean(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]);
    await clean(`DELETE FROM events WHERE id = ANY($1)`, [ids]);
    await clean(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    srv.close();
    stub.close();
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
