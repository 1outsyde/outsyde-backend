/**
 * Events & Ticketing Phase 2 PR 3: paid ticket checkout, webhook settle/cancel, every-minute job.
 *
 * Run with: npx tsx server/events/ticketCheckout.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (migration 056)
 * with the Stripe stub preload, and this process must reach the same DB:
 *   EV_TEST_BASE_URL     e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL       the SAME scratch database     (localhost only; seeds + cleans up)
 *   EV_TEST_STRIPE_PORT  port for the Stripe stub started here (server booted with STRIPE_STUB_PORT=<same>)
 *   JWT_SECRET           identical to the server's
 *   DATABASE_URL + NODE_OPTIONS="--import ./.dev/neon-preload.mjs" so webhooks and the job run in-process
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe.
 *
 * Mutation checks (run 2026-10-19):
 *  - drop the release on Stripe failure → "Stripe failure gives the seats back" fails.
 *  - put `orderId` in the PaymentIntent metadata → "metadata never carries orderId or bookingId" fails.
 *  - the amount is checked twice (precheck in JS + `total_cents = amount` in the SQL): dropping either one
 *    alone still passes on purpose; dropping both makes "wrong amount issues nothing" fail. Settling a
 *    processing payment is also stopped by the amount check (amount_received is 0 until it succeeds).
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
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
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL + EV_TEST_STRIPE_PORT to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and EV_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub: PaymentIntents keep their amount + metadata; status set by the test ──
  const piStore: Record<string, any> = {};
  let failPaymentIntents = false; // stripe-node retries a 500, so fail every attempt while set
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === "POST" && req.url === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
      const custM = req.url?.match(/^\/v1\/customers\/([^/?]+)/);
      if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
      if (req.method === "POST" && req.url === "/v1/payment_intents") {
        if (failPaymentIntents) return send(500, { error: { type: "api_error", message: "stub outage" } });
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const id = `pi_tk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        piStore[id] = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: 0, status: "requires_payment_method",
          client_secret: `${id}_secret`, capture_method: form.get("capture_method") || "automatic", metadata, customer: form.get("customer") };
        return send(200, piStore[id]);
      }
      const cancelM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)\/cancel/);
      if (req.method === "POST" && cancelM) {
        const pi = piStore[cancelM[1]];
        if (!pi) return send(404, { error: { message: "No such payment_intent" } });
        pi.status = "canceled"; return send(200, pi);
      }
      const piM = req.url?.match(/^\/v1\/payment_intents\/([^/?]+)$/);
      if (req.method === "GET" && piM) { const pi = piStore[piM[1]]; return pi ? send(200, pi) : send(404, { error: { message: "No such payment_intent" } }); }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const { WebhookHandlers } = await import("../stripe/webhookHandlers");
  const { runTicketOrderJob } = await import("./ticketCheckout");
  const failOn = new Set<string>();
  const cancelled: string[] = [];
  const jobDeps = {
    getPaymentIntent: async (id: string) => { if (failOn.has(id)) throw new Error("stripe down"); if (!piStore[id]) throw new Error("no such pi"); return piStore[id]; },
    cancelPaymentIntent: async (id: string) => { cancelled.push(id); piStore[id].status = "canceled"; return piStore[id]; },
  };
  const pay = (piId: string, amount?: number) => { const pi = piStore[piId]; pi.status = "succeeded"; pi.amount_received = amount ?? pi.amount; return pi; };

  const P = `pc${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [`${P}-${s}@test.local`, `Buyer ${s}`, `Buyer${s}`, `${P}${s}`.slice(0, 20)],
  ))[0].id as string;
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });
  const host = await mkUser("host");
  const buyers: string[] = [];
  for (let i = 0; i < 16; i++) buyers.push(await mkUser(`b${i}`));
  const [b0, b1, b2, b3] = buyers;
  const ordersBefore = Number((await q(`SELECT count(*)::int AS n FROM orders`))[0].n);

  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  /** Paid events can't be published until payouts ship; tests open them directly. */
  const paidEvent = async (types: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => {
    const ev = (await call("POST", "/api/events", { token: tok(host), body: { title: "Paid Night", startsAt: inDays(7), endsAt: inDays(7, 5), timezone: "America/New_York", ...over } })).body.event;
    const out: any[] = [];
    for (const t of types) {
      const r = await call("POST", `/api/events/${ev.id}/ticket-types`, { token: tok(host), body: t });
      if (r.status !== 201) throw new Error(`type create failed ${JSON.stringify(r)}`);
      out.push(r.body.ticketType);
    }
    await q(`UPDATE events SET status = 'published', published_at = now() WHERE id = $1`, [ev.id]);
    return { ev, types: out };
  };
  const checkout = (eventId: string, user: string, body: Record<string, unknown>) => call("POST", `/api/events/${eventId}/checkout`, { token: tok(user), body });
  const counts = async (typeId: string, eventId: string) => ({
    type: Number((await q(`SELECT reserved_count FROM ticket_types WHERE id = $1`, [typeId]))[0].reserved_count),
    event: Number((await q(`SELECT reserved_count FROM events WHERE id = $1`, [eventId]))[0].reserved_count),
  });

  try {
    console.log("Checkout");
    const { ev, types: [ga, free] } = await paidEvent([
      { name: "General", priceCents: 2000, quantity: 5, maxPerOrder: 4, perAccountLimit: 4 },
      { name: "Free", priceCents: 0, quantity: 5 },
    ]);
    let r = await call("POST", `/api/events/${ev.id}/checkout`, { body: { ticketTypeId: ga.id } });
    assert(r.status === 401, "signed out can't check out", r);
    r = await checkout(ev.id, b0, { ticketTypeId: free.id });
    assert(r.status === 409 && r.body.error.code === "FREE_TICKET", "free ticket goes through RSVP, not checkout", r);
    r = await call("POST", `/api/events/${ev.id}/rsvp`, { token: tok(b0), body: { ticketTypeId: ga.id } });
    assert(r.status === 409 && r.body.error.code === "PAID_TICKET", "paid ticket can't be RSVPed for free", r);

    r = await checkout(ev.id, b0, { ticketTypeId: ga.id, quantity: 2, idempotencyKey: `${P}-k1` });
    assert(r.status === 201 && r.body.totalCents === 4518 && r.body.subtotalCents === 4000 && r.body.serviceFeeCents === 518 && r.body.clientSecret, "2 x $20: buyer pays $45.18, one service fee line", r);
    const o1 = r.body;
    const pi1 = piStore[o1.paymentIntentId];
    assert(pi1.amount === 4518 && pi1.metadata.type === "event_ticket" && pi1.metadata.ticketOrderId === o1.orderId, "PaymentIntent amount and metadata", pi1);
    assert(!("orderId" in pi1.metadata) && !("bookingId" in pi1.metadata), "metadata never carries orderId or bookingId", pi1.metadata);
    const [row1] = await q(`SELECT * FROM ticket_orders WHERE id = $1`, [o1.orderId]);
    assert(row1.status === "pending" && Number(row1.platform_fee_cents) === 80 && Number(row1.host_net_cents) === 3920 && Number(row1.per_ticket_fee_cents) === 198, "order saved with fees per ticket (host 2 x $19.60)", row1);
    let c = await counts(ga.id, ev.id);
    assert(c.type === 2 && c.event === 2, "seats held while paying", c);
    const [noTickets] = await q(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [o1.orderId]);
    assert(noTickets.n === 0, "no tickets before payment", noTickets);

    r = await checkout(ev.id, b0, { ticketTypeId: ga.id, quantity: 2, idempotencyKey: `${P}-k1` });
    assert(r.status === 200 && r.body.repeated && r.body.paymentIntentId === o1.paymentIntentId, "same key returns the same checkout", r);
    r = await checkout(ev.id, b0, { ticketTypeId: ga.id, quantity: 1, idempotencyKey: `${P}-k1` });
    assert(r.status === 409 && r.body.error.code === "IDEMPOTENCY_KEY_REUSED", "same key, different order refused", r);
    r = await checkout(ev.id, b0, { ticketTypeId: ga.id, quantity: 3 });
    assert(r.status === 409 && r.body.error.code === "LIMIT_REACHED", "held seats count toward the per-person limit", r);

    console.log("Webhook");
    await WebhookHandlers.handlePaymentIntentSucceeded(pay(o1.paymentIntentId, 4000));
    let [after] = await q(`SELECT status FROM ticket_orders WHERE id = $1`, [o1.orderId]);
    let [tk] = await q(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [o1.orderId]);
    assert(after.status === "pending" && tk.n === 0, "wrong amount issues nothing", { after, tk });
    await WebhookHandlers.handlePaymentIntentSucceeded(pay(o1.paymentIntentId, 4000));
    const [flag] = await q(`SELECT needs_review_at, review_reason FROM ticket_orders WHERE id = $1`, [o1.orderId]);
    assert(!!flag.needs_review_at && /could not be settled/.test(flag.review_reason), "mismatch flags the order for review (once)", flag);
    await WebhookHandlers.handlePaymentIntentSucceeded(pay(o1.paymentIntentId));
    [after] = await q(`SELECT status, paid_at FROM ticket_orders WHERE id = $1`, [o1.orderId]);
    const tix = await q(`SELECT * FROM tickets WHERE order_id = $1 ORDER BY item_index`, [o1.orderId]);
    assert(after.status === "completed" && after.paid_at && tix.length === 2, "payment issues 2 tickets", { after, n: tix.length });
    assert(tix.every((t) => Number(t.price_cents) === 2000 && Number(t.service_fee_cents) === 160 && Number(t.per_ticket_fee_cents) === 99 && Number(t.platform_fee_cents) === 40 && Number(t.host_net_cents) === 1960), "each ticket saves its own fees", tix[0]);
    await WebhookHandlers.handlePaymentIntentSucceeded(piStore[o1.paymentIntentId]);
    [tk] = await q(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [o1.orderId]);
    assert(tk.n === 2, "second webhook issues nothing more", tk);
    r = await call("GET", `/api/events/orders/${o1.orderId}`, { token: tok(b0) });
    assert(r.status === 200 && r.body.order.status === "completed" && r.body.order.tickets.length === 2, "buyer sees the paid order", r.body);
    r = await call("GET", `/api/events/orders/${o1.orderId}`, { token: tok(b1) });
    assert(r.status === 404, "someone else can't see it", r);
    r = await call("GET", "/api/events/me/tickets", { token: tok(b0) });
    assert(r.body.tickets.length === 2, "paid tickets in my tickets", r.body);
    const ordersAfter = Number((await q(`SELECT count(*)::int AS n FROM orders`))[0].n);
    assert(ordersAfter === ordersBefore, "product orders table untouched", { ordersBefore, ordersAfter });

    r = await checkout(ev.id, b1, { ticketTypeId: ga.id });
    const o2 = r.body;
    const otherPi = (await checkout((await paidEvent([{ name: "X", priceCents: 1500, quantity: 3 }])).ev.id, b1, { ticketTypeId: (await q(`SELECT id FROM ticket_types WHERE name = 'X' ORDER BY created_at DESC LIMIT 1`))[0].id })).body;
    const forged = { ...pay(otherPi.paymentIntentId), metadata: { type: "event_ticket", ticketOrderId: o2.orderId } };
    await WebhookHandlers.handlePaymentIntentSucceeded(forged);
    [after] = await q(`SELECT status FROM ticket_orders WHERE id = $1`, [o2.orderId]);
    assert(after.status === "pending", "a different PaymentIntent can't settle this order", after);
    await WebhookHandlers.handlePaymentIntentCanceled({ ...piStore[o2.paymentIntentId], status: "canceled" });
    [after] = await q(`SELECT status FROM ticket_orders WHERE id = $1`, [o2.orderId]);
    c = await counts(ga.id, ev.id);
    assert(after.status === "cancelled" && c.type === 2 && c.event === 2, "cancelled payment gives the seat back", { after, c });

    console.log("Everyone at once");
    const { ev: ev2, types: [vip] } = await paidEvent([{ name: "VIP", priceCents: 5000, quantity: 5, maxPerOrder: 1, perAccountLimit: 1 }]);
    const rush = await Promise.all(buyers.slice(4, 16).map((u) => checkout(ev2.id, u, { ticketTypeId: vip.id })));
    const ok = rush.filter((x) => x.status === 201).length;
    const soldOut = rush.filter((x) => x.body?.error?.code === "SOLD_OUT").length;
    c = await counts(vip.id, ev2.id);
    assert(ok === 5 && soldOut === 7 && c.type === 5 && c.event === 5, "12 buyers at once on 5 seats: 5 holds, 7 sold out", { ok, soldOut, c, other: rush.filter((x) => x.status !== 201 && x.body?.error?.code !== "SOLD_OUT").map((x) => x.body).slice(0, 2) });

    console.log("Stripe failure");
    const { ev: ev3, types: [t3] } = await paidEvent([{ name: "Door", priceCents: 1000, quantity: 3 }]);
    failPaymentIntents = true;
    r = await checkout(ev3.id, b2, { ticketTypeId: t3.id });
    failPaymentIntents = false;
    c = await counts(t3.id, ev3.id);
    const [fo] = await q(`SELECT status FROM ticket_orders WHERE event_id = $1`, [ev3.id]);
    assert(r.status === 502 && r.body.error.code === "PAYMENT_SETUP_FAILED" && c.type === 0 && c.event === 0 && fo.status === "cancelled", "Stripe failure gives the seats back", { r, c, fo });
    failPaymentIntents = true;
    r = await checkout(ev3.id, b3, { ticketTypeId: t3.id, idempotencyKey: `${P}-retry` });
    failPaymentIntents = false;
    const r2 = await checkout(ev3.id, b3, { ticketTypeId: t3.id, idempotencyKey: `${P}-retry` });
    assert(r.status === 502 && r2.status === 201, "retry with the same key after a Stripe failure works", { r: r.body, r2: r2.body });
    r = await checkout(ev3.id, b2, { ticketTypeId: t3.id, idempotencyKey: `${P}-k2` });
    assert(r.status === 201, "buyer can try again right away", r);
    const k2 = r.body;
    await q(`UPDATE ticket_orders SET stripe_payment_intent_id = NULL WHERE id = $1`, [k2.orderId]);
    r = await checkout(ev3.id, b2, { ticketTypeId: t3.id, idempotencyKey: `${P}-k2` });
    assert(r.status === 409 && r.body.error.code === "TRY_AGAIN", "repeat while the first is still setting up: try again, not a new hold", r);
    await q(`UPDATE ticket_orders SET stripe_payment_intent_id = $2 WHERE id = $1`, [k2.orderId, k2.paymentIntentId]);
    pay(k2.paymentIntentId);
    r = await checkout(ev3.id, b2, { ticketTypeId: t3.id, idempotencyKey: `${P}-k2` });
    assert(r.status === 200 && r.body.order?.status === "completed" && r.body.order.tickets.length === 1, "repeat after paying (webhook not here yet) issues the ticket", r);

    console.log("Every-minute job");
    const { ev: ev4, types: [t4] } = await paidEvent([{ name: "Job", priceCents: 1200, quantity: 10, maxPerOrder: 1 }]);
    const mk = async (u: string) => (await checkout(ev4.id, u, { ticketTypeId: t4.id })).body;
    const lost = await mk(b0);      // paid, webhook lost
    const abandoned = await mk(b1); // unpaid for 20 minutes
    const proc = await mk(b2);      // bank still processing
    const down = await mk(b3);      // Stripe errors
    const young = await mk(buyers[4]);
    const noPi = (await q(`INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count) VALUES ($1, $2, 'pending', 1) RETURNING id`, [ev4.id, buyers[5]]))[0].id;
    await q(`INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at) VALUES ($1, $2, $3, $4, 1, 0, 'held', now())`, [noPi, ev4.id, t4.id, buyers[5]]);
    await q(`INSERT INTO ticket_account_counts (ticket_type_id, user_id, count) VALUES ($1, $2, 1) ON CONFLICT (ticket_type_id, user_id) DO UPDATE SET count = ticket_account_counts.count + 1`, [t4.id, buyers[5]]);
    await q(`UPDATE ticket_types SET reserved_count = reserved_count + 1 WHERE id = $1`, [t4.id]);
    await q(`UPDATE events SET reserved_count = reserved_count + 1 WHERE id = $1`, [ev4.id]);
    await q(`UPDATE ticket_orders SET created_at = now() - interval '3 minutes' WHERE id = $1`, [lost.orderId]);
    await q(`UPDATE ticket_orders SET created_at = now() - interval '20 minutes' WHERE id = ANY($1)`, [[abandoned.orderId, proc.orderId, down.orderId, noPi]]);
    pay(lost.paymentIntentId);
    piStore[proc.paymentIntentId].status = "processing";
    failOn.add(down.paymentIntentId);
    const before = await counts(t4.id, ev4.id);
    const out = await runTicketOrderJob(new Date(), jobDeps as any);
    const st = async (id: string) => (await q(`SELECT status FROM ticket_orders WHERE id = $1`, [id]))[0].status;
    assert(await st(lost.orderId) === "completed" && Number((await q(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [lost.orderId]))[0].n) === 1, "paid order with a lost webhook gets its ticket", out);
    assert(await st(abandoned.orderId) === "expired" && cancelled.includes(abandoned.paymentIntentId), "abandoned checkout: payment cancelled first, then expired", { cancelled });
    assert(await st(proc.orderId) === "pending", "processing payment left alone");
    assert(await st(down.orderId) === "pending", "Stripe error leaves the order alone");
    assert(await st(noPi) === "expired", "order that never got a PaymentIntent expires");
    assert(await st(young.orderId) === "pending", "young checkout untouched");
    c = await counts(t4.id, ev4.id);
    assert(c.type === before.type - 2 && c.event === before.event - 2, "expired orders gave their 2 seats back", { before, c });
    assert(out.settled === 1 && out.expired === 2, "job counts", out);
    const again = await runTicketOrderJob(new Date(), jobDeps as any);
    assert(again.settled === 0 && again.expired === 0, "second run changes nothing", again);
    const [checked] = await q(`SELECT last_checked_at FROM ticket_orders WHERE id = $1`, [down.orderId]);
    assert(!!checked.last_checked_at, "Stripe-error order is marked checked, so it goes to the back of the queue", checked);
    await q(`UPDATE ticket_orders SET needs_review_at = now() WHERE id = $1`, [proc.orderId]);
    piStore[proc.paymentIntentId].status = "requires_payment_method";
    await runTicketOrderJob(new Date(), jobDeps as any);
    assert(await st(proc.orderId) === "pending", "flagged order is left for the admin");
    r = await checkout(ev4.id, b1, { ticketTypeId: t4.id });
    assert(r.status === 201, "buyer whose hold expired can check out again", r);
  } finally {
    stub.close();
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
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
