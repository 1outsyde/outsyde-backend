/**
 * Events & Ticketing Phase 2 PR 4: refunds (buyer, host), host cancel with guests, refund job, receipts.
 *
 * Run with: npx tsx server/events/ticketRefunds.http.test.ts
 *
 * SCRATCH ONLY. Same setup as ticketCheckout.http.test.ts (local Postgres with migrations 056, 059, 060,
 * backend on localhost with the Stripe stub preload, DATABASE_URL + neon preload for in-process calls):
 *   EV_TEST_BASE_URL, EV_TEST_PG_URL, EV_TEST_STRIPE_PORT, JWT_SECRET
 * Mutation note: make emailEvent always use formatEventWhere (ignore the reveal time) and the
 * "day-of event before the reveal" assertions fail (the street shows in receipt, refund and cancel emails).
 *
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe,
 * Resend or Expo (notices in this process go to recording fakes; the server has no Resend key).
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Emails are paced (one at a time with a gap), so wait for a notice instead of a fixed pause. */
async function waitFor(check: () => boolean, ms = 5000) { const end = Date.now() + ms; while (!check() && Date.now() < end) await sleep(50); }

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

  // ── Stripe stub, shared by the server (over HTTP) and this process (direct calls) ──
  const piStore: Record<string, any> = {};
  const refundsByKey: Record<string, any> = {};
  const refundCalls: Array<{ pi: string; amount: number; key: string | null }> = [];
  const failRefundsFor = new Set<string>();
  /** Stripe's rules: same key returns the same refund (different amount = error); never more than what's left. */
  const doRefund = (piId: string, amount: number, key: string | null): { code: number; body: any } => {
    const pi = piStore[piId];
    if (!pi) return { code: 404, body: { error: { message: "No such payment_intent" } } };
    if (failRefundsFor.has(piId)) return { code: 402, body: { error: { type: "card_error", message: "stub refund declined" } } };
    if (key && refundsByKey[key]) {
      if (refundsByKey[key].amount !== amount) return { code: 400, body: { error: { type: "idempotency_error", message: "key reused with different params" } } };
      return { code: 200, body: refundsByKey[key] };
    }
    if (amount > pi.amount_received - pi.amount_refunded) return { code: 400, body: { error: { type: "invalid_request_error", message: "amount exceeds what's left" } } };
    pi.amount_refunded += amount;
    const refund = { id: `re_${Math.random().toString(36).slice(2, 10)}`, object: "refund", amount, payment_intent: piId, status: "succeeded" };
    if (key) refundsByKey[key] = refund;
    refundCalls.push({ pi: piId, amount, key });
    return { code: 200, body: refund };
  };
  const piJson = (pi: any) => ({ ...pi, latest_charge: { id: `ch_${pi.id}`, object: "charge", amount_refunded: pi.amount_refunded } });
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "POST" && path === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
      const custM = path.match(/^\/v1\/customers\/([^/]+)$/);
      if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
      if (req.method === "POST" && path === "/v1/payment_intents") {
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const id = `pi_rf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        piStore[id] = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: 0, amount_refunded: 0,
          status: "requires_payment_method", client_secret: `${id}_secret`, metadata };
        return send(200, piStore[id]);
      }
      const cancelM = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelM) {
        const pi = piStore[cancelM[1]];
        if (!pi) return send(404, { error: { message: "No such payment_intent" } });
        if (pi.status === "succeeded") return send(400, { error: { message: "already succeeded" } });
        pi.status = "canceled"; return send(200, piJson(pi));
      }
      const piM = path.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (req.method === "GET" && piM) { const pi = piStore[piM[1]]; return pi ? send(200, piJson(pi)) : send(404, { error: { message: "No such payment_intent" } }); }
      if (req.method === "POST" && path === "/v1/refunds") {
        const key = (req.headers["idempotency-key"] as string) ?? null;
        const r = doRefund(String(form.get("payment_intent")), Number(form.get("amount")), key);
        return send(r.code, r.body);
      }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  // In-process Stripe for direct calls (same store and same rules as the HTTP stub).
  const direct = {
    getPaymentIntentForRefund: async (id: string) => {
      const pi = piStore[id]; if (!pi) throw new Error("no such pi");
      return { status: pi.status, amountReceived: pi.amount_received, amountRefunded: pi.amount_refunded };
    },
    createBookingRefund: async (p: any) => {
      const r = doRefund(p.paymentIntentId, p.amountCents, p.idempotencyKey ?? null);
      if (r.code !== 200) throw new Error(r.body.error.message);
      return r.body;
    },
    cancelPaymentIntent: async (id: string) => { piStore[id].status = "canceled"; return piStore[id]; },
  };

  // Notices sent from this process are recorded, not sent.
  const notices: Array<{ kind: string; p: any }> = [];
  const { setNoticeDepsForTest, formatEventWhen, formatEventWhere } = await import("./ticketNotices");
  setNoticeDepsForTest({
    sendReceipt: async (p) => { notices.push({ kind: "receipt", p }); },
    sendRefund: async (p) => { notices.push({ kind: "refund", p }); },
    sendCancelled: async (p) => { notices.push({ kind: "cancelled", p }); },
    sendAddressReveal: async () => {},
    sendPush: async (p) => { notices.push({ kind: "push", p }); return true; },
  });

  const { WebhookHandlers } = await import("../stripe/webhookHandlers");
  const { requestOrderRefund, processTicketRefund, runTicketRefundJob, queueCancelledEventOrders, refundKey, REFUND_MAX_ATTEMPTS } = await import("./ticketRefunds");

  const P = `rf${Date.now().toString(36)}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [`${P}-${s}@test.local`, `Guest ${s}`, `Guest${s}`, `${P}${s}`.slice(0, 20)],
  ))[0].id as string;
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });
  const host = await mkUser("host");
  const other = await mkUser("other");
  const g: string[] = [];
  for (let i = 0; i < 14; i++) g.push(await mkUser(`g${i}`));

  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  const paidEvent = async (types: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => {
    const ev = (await call("POST", "/api/events", { token: tok(host), body: { title: "Refund Night", startsAt: inDays(7), endsAt: inDays(7, 5), timezone: "America/New_York", venueName: "The Loft", city: "Freeport", state: "NY", ...over } })).body.event;
    if (!ev) throw new Error("event create failed");
    const out: any[] = [];
    for (const t of types) {
      const r = await call("POST", `/api/events/${ev.id}/ticket-types`, { token: tok(host), body: t });
      if (r.status !== 201) throw new Error(`type create failed ${JSON.stringify(r)}`);
      out.push(r.body.ticketType);
    }
    await q(`UPDATE events SET status = 'published', published_at = now() WHERE id = $1`, [ev.id]);
    return { ev, types: out };
  };
  /** Checkout + pay through the real webhook handler (in this process). Returns the order row. */
  const buy = async (eventId: string, user: string, typeId: string, quantity = 1) => {
    const r = await call("POST", `/api/events/${eventId}/checkout`, { token: tok(user), body: { ticketTypeId: typeId, quantity } });
    if (r.status !== 201) throw new Error(`checkout failed ${JSON.stringify(r)}`);
    const pi = piStore[r.body.paymentIntentId];
    pi.status = "succeeded"; pi.amount_received = pi.amount;
    await WebhookHandlers.handlePaymentIntentSucceeded(pi);
    return (await q(`SELECT * FROM ticket_orders WHERE id = $1`, [r.body.orderId]))[0];
  };
  const order = async (id: string) => (await q(`SELECT * FROM ticket_orders WHERE id = $1`, [id]))[0];
  const ticketStatuses = async (id: string) => (await q(`SELECT status FROM tickets WHERE order_id = $1 ORDER BY item_index`, [id])).map((t) => t.status);
  const counts = async (typeId: string, eventId: string, userId?: string) => ({
    type: Number((await q(`SELECT reserved_count FROM ticket_types WHERE id = $1`, [typeId]))[0].reserved_count),
    event: Number((await q(`SELECT reserved_count FROM events WHERE id = $1`, [eventId]))[0].reserved_count),
    account: userId ? Number((await q(`SELECT count FROM ticket_account_counts WHERE ticket_type_id = $1 AND user_id = $2`, [typeId, userId]))[0]?.count ?? 0) : 0,
  });
  const noDash = (s: string) => !/[‒–—―]| - /.test(s);

  try {
    console.log("Receipt and host push on first settle");
    const { ev: e1, types: [t1] } = await paidEvent([{ name: "General", priceCents: 2000, quantity: 10, maxPerOrder: 4, perAccountLimit: 4 }],
      { refundPolicy: "until_cutoff", refundCutoffHours: 24 });
    notices.length = 0;
    const o1 = await buy(e1.id, g[0], t1.id, 2);
    await waitFor(() => notices.some((n) => n.kind === "receipt") && notices.some((n) => n.kind === "push"));
    const receipts = notices.filter((n) => n.kind === "receipt");
    const pushes = notices.filter((n) => n.kind === "push");
    assert(o1.status === "completed" && Number(o1.total_cents) === 4518, "paid order completed ($45.18 for 2 x $20)", o1);
    assert(receipts.length === 1 && receipts[0].p.toEmail === `${P}-g0@test.local` && receipts[0].p.codes.length === 2
      && receipts[0].p.ticketPriceCents === 4000 && receipts[0].p.serviceFeeCents === 518 && receipts[0].p.totalCents === 4518, "one receipt with both ticket codes and the money split", receipts);
    assert(receipts[0]?.p.event.title === "Refund Night" && receipts[0]?.p.event.whereText === "The Loft, Freeport, NY", "receipt shows the event and place", receipts[0]?.p.event);
    assert(pushes.length === 1 && pushes[0].p.userId === host && pushes[0].p.data.type === "ticket_sold" && pushes[0].p.body === `Guestg0 bought 2 tickets to Refund Night.`, "host gets one push", pushes);
    notices.length = 0;
    await WebhookHandlers.handlePaymentIntentSucceeded(piStore[o1.stripe_payment_intent_id]);
    await sleep(200);
    assert(notices.length === 0, "a repeated webhook sends nothing again", notices);
    assert(formatEventWhen("2026-10-25T00:00:00Z", "America/New_York") === "Saturday, October 24 at 8:00 PM EDT", "time shown in the event's time zone", formatEventWhen("2026-10-25T00:00:00Z", "America/New_York"));
    assert(formatEventWhere({ venue_name: "Loft", address_line1: "1 Main St", city: "Freeport", state: "NY", postal_code: "11520" }) === "Loft, 1 Main St, Freeport, NY 11520", "address line");

    console.log("Email copy rules (rendered)");
    const em = await import("../emailService");
    const visible = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const evx = { title: "Night <b>Out</b>", whenText: "Saturday, October 24 at 8:00 PM EDT", whereText: "The Loft, Freeport, NY" };
    const rendered = [
      em.renderTicketReceipt({ toEmail: "a@b.c", firstName: "Ana", event: evx, ticketTypeName: "GA", quantity: 2, ticketPriceCents: 4000, serviceFeeCents: 518, totalCents: 4518, codes: ["ABCD", "EFGH"] }),
      em.renderTicketRefund({ toEmail: "a@b.c", firstName: "Ana", event: evx, reason: "buyer", refundCents: 4000, keptFeeCents: 518 }),
      em.renderTicketRefund({ toEmail: "a@b.c", firstName: null, event: evx, reason: "host", refundCents: 4000, keptFeeCents: 518 }),
      em.renderTicketRefund({ toEmail: "a@b.c", firstName: "Ana", event: evx, reason: "event_cancelled", refundCents: 4518, keptFeeCents: 0, cancelReason: "Rain." }),
      em.renderEventCancelled({ toEmail: "a@b.c", firstName: "Ana", event: evx, cancelReason: "Rain." }),
    ];
    const texts = rendered.map((x) => `${x.subject} ${visible(x.html)}`);
    assert(texts.every((t) => !t.includes("%")), "no percentage anywhere a customer can read", texts.filter((t) => t.includes("%")));
    assert(texts.every(noDash), "no dashes in what a customer reads", texts.map((t) => t.match(/.{0,30}([\u2013\u2014]| - ).{0,30}/)?.[0]).filter(Boolean));
    assert(texts[0].includes("Service fee") && texts[0].includes("$45.18") && texts[0].includes("ABCD") && texts[0].includes("EFGH"), "receipt: service fee line, total, both codes", texts[0]);
    assert(texts[1].includes("$40.00") && texts[1].includes("$5.18, not refunded"), "buyer refund email: refund and kept fee", texts[1]);
    assert(texts[3].includes("$45.18") && !texts[3].includes("not refunded") && texts[3].includes("Rain."), "cancel refund email: everything back, host message shown", texts[3]);
    assert(!rendered.some((x) => x.html.includes("<b>Out</b>")) && rendered[0].html.includes("Night &lt;b&gt;Out&lt;/b&gt;"), "event title is escaped in the HTML");

    console.log("Buyer refund under the host's policy");
    const before1 = await counts(t1.id, e1.id, g[0]);
    let r = await call("POST", `/api/events/orders/${o1.id}/refund`, { token: tok(other) });
    assert(r.status === 404 && r.body.error.code === "ORDER_NOT_FOUND", "someone else can't refund my order", r);
    r = await call("POST", `/api/events/orders/${o1.id}/refund`, { token: tok(g[0]) });
    let row = await order(o1.id);
    assert(r.status === 200 && r.body.order.status === "refunded" && r.body.order.refundedCents === 4000, "refund goes through at once", r);
    assert(row.status === "refunded" && Number(row.refunded_cents) === 4000 && row.refund_reason === "buyer" && row.stripe_refund_id && Number(row.refund_amount_cents) === 0, "order: ticket price back, service fee kept", row);
    assert(refundCalls.filter((c) => c.pi === o1.stripe_payment_intent_id).length === 1 && refundCalls.at(-1)!.amount === 4000 && refundCalls.at(-1)!.key === refundKey(o1.id, "buyer"), "one Stripe refund of $40.00 with the fixed key", refundCalls.at(-1));
    let after1 = await counts(t1.id, e1.id, g[0]);
    assert(after1.type === before1.type - 2 && after1.event === before1.event - 2 && after1.account === before1.account - 2, "both seats back on sale and the per-person count freed", { before1, after1 });
    assert((await ticketStatuses(o1.id)).every((s) => s === "refunded"), "tickets marked refunded");
    r = await call("GET", "/api/events/me/tickets", { token: tok(g[0]) });
    assert(r.status === 200 && !r.body.tickets.some((t: any) => t.orderId === o1.id), "refunded tickets leave My tickets", r.body);
    r = await call("POST", `/api/events/orders/${o1.id}/refund`, { token: tok(g[0]) });
    assert(r.status === 409 && r.body.error.code === "ALREADY_REFUNDED", "second refund refused", r);
    assert(refundCalls.filter((c) => c.pi === o1.stripe_payment_intent_id).length === 1, "still one Stripe refund");

    console.log("Buyer refund blocked");
    const { ev: e2, types: [t2, f2] } = await paidEvent([
      { name: "GA", priceCents: 1500, quantity: 10 },
      { name: "Free", priceCents: 0, quantity: 10 },
    ]);
    const o2 = await buy(e2.id, g[1], t2.id);
    r = await call("POST", `/api/events/orders/${o2.id}/refund`, { token: tok(g[1]) });
    assert(r.status === 409 && r.body.error.code === "NO_REFUNDS", "no-refund policy: buyer can't refund", r);
    const rsvp = await call("POST", `/api/events/${e2.id}/rsvp`, { token: tok(g[2]), body: { ticketTypeId: f2.id } });
    r = await call("POST", `/api/events/orders/${rsvp.body.order.id}/refund`, { token: tok(g[2]) });
    assert(r.status === 409 && r.body.error.code === "FREE_ORDER", "free RSVP isn't refunded, it's cancelled", r);
    const { ev: e3, types: [t3] } = await paidEvent([{ name: "GA", priceCents: 1500, quantity: 10 }], { refundPolicy: "until_cutoff", refundCutoffHours: 24 });
    const o3 = await buy(e3.id, g[3], t3.id);
    await q(`UPDATE events SET starts_at = now() + interval '10 hours', ends_at = now() + interval '15 hours' WHERE id = $1`, [e3.id]);
    r = await call("POST", `/api/events/orders/${o3.id}/refund`, { token: tok(g[3]) });
    assert(r.status === 409 && r.body.error.code === "REFUND_WINDOW_CLOSED", "inside the cutoff: buyer can't refund", r);
    await q(`UPDATE events SET starts_at = now() + interval '3 days', ends_at = now() + interval '3 days 5 hours' WHERE id = $1`, [e3.id]);
    await q(`UPDATE tickets SET checked_in_at = now() WHERE order_id = $1`, [o3.id]);
    r = await call("POST", `/api/events/orders/${o3.id}/refund`, { token: tok(g[3]) });
    assert(r.status === 409 && r.body.error.code === "CHECKED_IN", "checked in: buyer can't refund", r);
    assert((await order(o3.id)).status === "completed" && refundCalls.every((c) => c.pi !== o3.stripe_payment_intent_id), "blocked refunds change nothing and call nobody");

    console.log("Host refund");
    r = await call("POST", `/api/events/${e2.id}/orders/${o2.id}/refund`, { token: tok(other) });
    assert(r.status === 404 && r.body.error.code === "EVENT_NOT_FOUND", "only the host can refund from the host side", r);
    r = await call("GET", `/api/events/${e2.id}/orders`, { token: tok(host) });
    const listed = r.body?.orders?.find((x: any) => x.id === o2.id);
    assert(r.status === 200 && listed && listed.ticketPriceCents === 1500 && listed.guest.firstName === "Guestg1" && !("email" in listed.guest), "host sees orders with first name, no email", r.body);
    r = await call("GET", `/api/events/${e2.id}/orders`, { token: tok(other) });
    assert(r.status === 404, "others can't list orders", r);
    const before2 = await counts(t2.id, e2.id, g[1]);
    r = await call("POST", `/api/events/${e2.id}/orders/${o2.id}/refund`, { token: tok(host) });
    row = await order(o2.id);
    assert(r.status === 200 && row.status === "refunded" && Number(row.refunded_cents) === 1500 && row.refund_reason === "host", "host refunds even under no refunds: ticket price back", { r, row });
    const after2 = await counts(t2.id, e2.id, g[1]);
    assert(after2.type === before2.type - 1 && after2.event === before2.event - 1, "seat back on sale", { before2, after2 });
    r = await call("POST", `/api/events/${e2.id}/orders/${rsvp.body.order.id}/refund`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "FREE_ORDER", "host can't refund a free RSVP", r);
    r = await call("POST", `/api/events/${e1.id}/orders/${o2.id}/refund`, { token: tok(host) });
    assert(r.status === 404 && r.body.error.code === "ORDER_NOT_FOUND", "order must belong to that event", r);
    // After the event started: refund still allowed, seats untouched.
    const o3b = await buy(e3.id, g[4], t3.id);
    await q(`UPDATE events SET starts_at = now() - interval '1 hour', ends_at = now() + interval '4 hours' WHERE id = $1`, [e3.id]);
    const before3 = await counts(t3.id, e3.id);
    r = await call("POST", `/api/events/${e3.id}/orders/${o3b.id}/refund`, { token: tok(host) });
    const after3 = await counts(t3.id, e3.id);
    assert(r.status === 200 && (await order(o3b.id)).status === "refunded" && after3.type === before3.type && after3.event === before3.event, "host refund after the start: refunded, seats left alone", { r, before3, after3 });

    console.log("Reopen rule: a sold later tier keeps the earlier tier closed");
    const { ev: e4, types: [early] } = await paidEvent([{ name: "Early", priceCents: 1000, quantity: 1 }], { refundPolicy: "until_cutoff", refundCutoffHours: 1 });
    await q(`UPDATE events SET status = 'draft' WHERE id = $1`, [e4.id]); // paid tiers can only be added to drafts
    const late = (await call("POST", `/api/events/${e4.id}/ticket-types`, { token: tok(host), body: { name: "Late", priceCents: 1500, quantity: 5, unlockAfterTicketTypeId: early.id } })).body.ticketType;
    await q(`UPDATE events SET status = 'published' WHERE id = $1`, [e4.id]);
    const oe = await buy(e4.id, g[5], early.id);
    await buy(e4.id, g[6], late.id);
    r = await call("POST", `/api/events/orders/${oe.id}/refund`, { token: tok(g[5]) });
    const ce = await counts(early.id, e4.id);
    assert(r.status === 200 && ce.type === 1 && ce.event === 1, "early tier stays sold out after a refund once the late tier sold; event capacity freed", ce);

    console.log("Ten refund requests at once");
    const { ev: e5, types: [t5] } = await paidEvent([{ name: "GA", priceCents: 2500, quantity: 10 }], { refundPolicy: "until_cutoff", refundCutoffHours: 2 });
    const o5 = await buy(e5.id, g[7], t5.id, 1);
    const before5 = await counts(t5.id, e5.id, g[7]);
    const many = await Promise.all(Array.from({ length: 10 }, () => call("POST", `/api/events/orders/${o5.id}/refund`, { token: tok(g[7]) })));
    const after5 = await counts(t5.id, e5.id, g[7]);
    assert(many.filter((x) => x.status === 200).length === 1 && many.filter((x) => x.status === 409).length === 9, "exactly one wins, nine refused", many.map((x) => x.status));
    assert(refundCalls.filter((c) => c.pi === o5.stripe_payment_intent_id).length === 1 && after5.type === before5.type - 1 && after5.event === before5.event - 1, "one Stripe refund, seat freed once", { after5, before5 });

    console.log("Stripe errors: retry, then review");
    const { ev: e6, types: [t6] } = await paidEvent([{ name: "GA", priceCents: 3000, quantity: 10 }], { refundPolicy: "until_cutoff", refundCutoffHours: 2 });
    const o6 = await buy(e6.id, g[8], t6.id);
    failRefundsFor.add(o6.stripe_payment_intent_id);
    r = await call("POST", `/api/events/orders/${o6.id}/refund`, { token: tok(g[8]) });
    row = await order(o6.id);
    assert(r.status === 200 && r.body.order.status === "refunding" && row.status === "refunding" && Number(row.refund_attempts) === 1 && row.refund_last_error, "Stripe down: refund recorded, seats freed, waiting to retry", { r: r.body, row });
    assert((await ticketStatuses(o6.id)).every((s) => s === "refunded"), "tickets already stop working");
    // Keep the server's own job away from it while we drive the retries here.
    await q(`UPDATE ticket_orders SET refund_next_attempt_at = now() + interval '1 day' WHERE id = $1`, [o6.id]);
    assert(await processTicketRefund(o6.id, direct as any) === "not_due", "not retried before its time");
    assert(await processTicketRefund(o6.id, direct as any, true) === "not_due", "forcing only works on the first try; retries follow the schedule");
    const due6 = () => q(`UPDATE ticket_orders SET refund_next_attempt_at = now() - interval '1 second' WHERE id = $1`, [o6.id]);
    for (let i = 2; i < REFUND_MAX_ATTEMPTS; i++) { await due6(); assert(await processTicketRefund(o6.id, direct as any) === "retry", `try ${i} fails and waits`); }
    const [wait6] = await q(`SELECT refund_next_attempt_at > now() + interval '7 minutes' AS later FROM ticket_orders WHERE id = $1`, [o6.id]);
    assert(wait6.later === true, "waits longer after each failed try", wait6);
    notices.length = 0;
    await due6();
    assert(await processTicketRefund(o6.id, direct as any) === "review", `try ${REFUND_MAX_ATTEMPTS} flags it for review`);
    row = await order(o6.id);
    assert(row.needs_review_at && row.status === "refunding" && Number(row.refund_attempts) === REFUND_MAX_ATTEMPTS, "flagged once, left for the admin", row);
    await due6();
    assert(await processTicketRefund(o6.id, direct as any) === "not_due", "flagged order isn't retried");
    // Admin clears the flag after Stripe recovers: one more try finishes it.
    failRefundsFor.delete(o6.stripe_payment_intent_id);
    await q(`UPDATE ticket_orders SET needs_review_at = NULL, refund_next_attempt_at = now() - interval '1 second' WHERE id = $1`, [o6.id]);
    const job = await runTicketRefundJob(direct as any);
    row = await order(o6.id);
    assert(job.refunded >= 1 && row.status === "refunded" && Number(row.refunded_cents) === 3000, "job finishes it", { job, row });
    await waitFor(() => notices.some((n) => n.kind === "refund" && n.p.toEmail === `${P}-g8@test.local`));
    const rn = notices.filter((n) => n.kind === "refund" && n.p.toEmail === `${P}-g8@test.local`);
    assert(rn.length === 1 && rn[0].p.refundCents === 3000 && rn[0].p.keptFeeCents === Number(o6.total_cents) - 3000 && rn[0].p.reason === "buyer", "buyer gets one refund email showing the kept service fee", rn);

    console.log("Refund went through but wasn't saved");
    const o7 = await buy(e6.id, g[9], t6.id);
    await q(`UPDATE ticket_orders SET status = 'refunding', refund_reason = 'buyer', refund_amount_cents = 3000, refund_next_attempt_at = now() + interval '1 day' WHERE id = $1`, [o7.id]);
    piStore[o7.stripe_payment_intent_id].amount_refunded = 3000; // Stripe already did it
    const callsBefore = refundCalls.length;
    assert(await processTicketRefund(o7.id, direct as any, true) === "refunded" && refundCalls.length === callsBefore, "recorded without a second Stripe refund");
    const o8 = await buy(e6.id, g[10], t6.id);
    await q(`UPDATE ticket_orders SET status = 'refunding', refund_reason = 'host', refund_amount_cents = 3000, refund_next_attempt_at = now() + interval '1 day' WHERE id = $1`, [o8.id]);
    piStore[o8.stripe_payment_intent_id].amount_refunded = 500; // someone refunded part in the Stripe dashboard
    assert(await processTicketRefund(o8.id, direct as any, true) === "review" && refundCalls.length === callsBefore, "Stripe disagrees with the order: flagged, nothing sent");
    const o8b = await buy(e6.id, g[10], t6.id);
    await q(`UPDATE ticket_orders SET status = 'refunding', refund_reason = 'host', refund_amount_cents = 3000, refund_next_attempt_at = now() + interval '1 day' WHERE id = $1`, [o8b.id]);
    piStore[o8b.stripe_payment_intent_id].amount_refunded = Number(o8b.total_cents); // more refunded at Stripe than this refund
    assert(await processTicketRefund(o8b.id, direct as any, true) === "review" && (await order(o8b.id)).status === "refunding", "Stripe shows more refunded than expected: flagged, not recorded");

    console.log("Late or repeated payment webhook after a refund");
    const o12 = await buy(e1.id, g[1], t1.id, 1);
    r = await call("POST", `/api/events/orders/${o12.id}/refund`, { token: tok(g[1]) });
    await WebhookHandlers.handlePaymentIntentSucceeded(piStore[o12.stripe_payment_intent_id]);
    row = await order(o12.id);
    assert(r.status === 200 && row.status === "refunded" && !row.needs_review_at, "a late webhook on a refunded order changes nothing and flags nothing", row);

    console.log("Host cancels an event with guests");
    const { ev: e9, types: [t9, f9] } = await paidEvent([
      { name: "GA", priceCents: 2000, quantity: 20, maxPerOrder: 4 },
      { name: "Free", priceCents: 0, quantity: 20 },
    ], { refundPolicy: "until_cutoff", refundCutoffHours: 2 });
    const pa = await buy(e9.id, g[11], t9.id, 2);
    const pb = await buy(e9.id, g[12], t9.id, 1);
    r = await call("POST", `/api/events/orders/${pb.id}/refund`, { token: tok(g[12]) }); // buyer refund first: price back, fee kept
    const fr = await call("POST", `/api/events/${e9.id}/rsvp`, { token: tok(g[13]), body: { ticketTypeId: f9.id } });
    const pend = await call("POST", `/api/events/${e9.id}/checkout`, { token: tok(g[0]), body: { ticketTypeId: t9.id } });
    r = await call("POST", `/api/events/${e9.id}/cancel`, { token: tok(other), body: {} });
    assert(r.status === 404, "only the host can cancel", r);
    r = await call("POST", `/api/events/${e9.id}/cancel`, { token: tok(host), body: { reason: "Venue flooded." } });
    assert(r.status === 200 && r.body.event.status === "cancelled" && r.body.guests.freeCancelled === 1 && r.body.guests.refunding === 2, "cancel with guests works and reports them", r.body);
    await sleep(1500);
    const ra = await order(pa.id), rb = await order(pb.id);
    assert(ra.status === "refunded" && Number(ra.refunded_cents) === Number(ra.total_cents) && ra.refund_reason === "event_cancelled", "paid order: everything back, fees included", ra);
    assert(rb.status === "refunded" && Number(rb.refunded_cents) === Number(rb.total_cents)
      && piStore[pb.stripe_payment_intent_id].amount_refunded === Number(pb.total_cents), "earlier refund topped up with the kept service fee", { rb, pi: piStore[pb.stripe_payment_intent_id] });
    assert(refundCalls.filter((c) => c.pi === pb.stripe_payment_intent_id).map((c) => c.key).join() === `${refundKey(pb.id, "buyer")},${refundKey(pb.id, "event_cancelled")}`, "two refunds, each with its own key", refundCalls.filter((c) => c.pi === pb.stripe_payment_intent_id));
    assert((await order(fr.body.order.id)).status === "cancelled" && (await ticketStatuses(fr.body.order.id)).every((s) => s === "cancelled"), "free RSVP cancelled");
    assert((await ticketStatuses(pa.id)).every((s) => s === "refunded"), "paid tickets stop working");
    assert(piStore[pend.body.paymentIntentId].status === "canceled" && (await order(pend.body.orderId)).status === "cancelled", "open checkout closed and its payment stopped", piStore[pend.body.paymentIntentId]);
    r = await call("POST", `/api/events/${e9.id}/cancel`, { token: tok(host), body: {} });
    assert(r.status === 409 && r.body.error.code === "ALREADY_CANCELLED", "cancel twice refused", r);
    r = await call("POST", `/api/events/orders/${pa.id}/refund`, { token: tok(g[11]) });
    assert(r.status === 409 && r.body.error.code === "ALREADY_REFUNDED", "buyer can't refund again after the cancel", r);
    r = await call("POST", `/api/events/${e9.id}/checkout`, { token: tok(g[1]), body: { ticketTypeId: t9.id } });
    assert(r.status === 409 && r.body.error.code === "EVENT_CANCELLED", "no new checkouts", r);
    const callsAfterCancel = refundCalls.length;
    const sweep = await queueCancelledEventOrders(e9.id);
    assert(sweep.refunding.length === 0 && sweep.freeCancelled.length === 0, "running the sweep again queues nothing", sweep);
    await runTicketRefundJob(direct as any);
    assert(refundCalls.length === callsAfterCancel, "no extra Stripe refunds");

    console.log("Payment that lands after the cancel");
    const { ev: e10, types: [t10] } = await paidEvent([{ name: "GA", priceCents: 1200, quantity: 5 }]);
    const late10 = await call("POST", `/api/events/${e10.id}/checkout`, { token: tok(g[2]), body: { ticketTypeId: t10.id } });
    await q(`UPDATE events SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [e10.id]); // cancelled while the buyer was paying
    notices.length = 0;
    const pi10 = piStore[late10.body.paymentIntentId]; pi10.status = "succeeded"; pi10.amount_received = pi10.amount;
    await WebhookHandlers.handlePaymentIntentSucceeded(pi10);
    await sleep(1000);
    assert(!notices.some((n) => n.kind === "receipt"), "no receipt for a cancelled event", notices);
    await runTicketRefundJob(direct as any);
    const r10 = await order(late10.body.orderId);
    assert(r10.status === "refunded" && Number(r10.refunded_cents) === Number(r10.total_cents) && pi10.amount_refunded === pi10.amount, "job refunds it in full", r10);

    console.log("Cancel while an earlier refund is still going");
    const { ev: e13, types: [t13] } = await paidEvent([{ name: "GA", priceCents: 2000, quantity: 5 }], { refundPolicy: "until_cutoff", refundCutoffHours: 1 });
    const o13 = await buy(e13.id, g[4], t13.id);
    failRefundsFor.add(o13.stripe_payment_intent_id);
    await call("POST", `/api/events/orders/${o13.id}/refund`, { token: tok(g[4]) });
    assert((await order(o13.id)).status === "refunding", "buyer refund waiting on Stripe");
    r = await call("POST", `/api/events/${e13.id}/cancel`, { token: tok(host), body: {} });
    assert(r.status === 200 && r.body.guests.refunding === 0, "cancel leaves the in-flight refund alone", r.body?.guests);
    failRefundsFor.delete(o13.stripe_payment_intent_id);
    await q(`UPDATE ticket_orders SET refund_next_attempt_at = now() - interval '1 second' WHERE id = $1`, [o13.id]);
    await runTicketRefundJob(direct as any); // finishes the buyer refund (price only)
    const mid = await order(o13.id);
    assert(mid.status === "refunded" && Number(mid.refunded_cents) === 2000, "buyer refund finished", mid);
    await runTicketRefundJob(direct as any); // sweep queues the top-up (waits 2 minutes for the cancel step)
    await q(`UPDATE ticket_orders SET refund_next_attempt_at = now() - interval '1 second' WHERE id = $1`, [o13.id]);
    await runTicketRefundJob(direct as any);
    const fin = await order(o13.id);
    assert(fin.status === "refunded" && Number(fin.refunded_cents) === Number(fin.total_cents) && piStore[o13.stripe_payment_intent_id].amount_refunded === Number(fin.total_cents), "then topped up to everything", fin);

    console.log("Cancel after the event started");
    const { ev: e14, types: [t14] } = await paidEvent([{ name: "GA", priceCents: 2000, quantity: 5 }]);
    const o14 = await buy(e14.id, g[5], t14.id);
    await q(`UPDATE events SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id = $1`, [e14.id]);
    r = await call("POST", `/api/events/${e14.id}/cancel`, { token: tok(host), body: {} });
    assert(r.status === 409 && r.body.error.code === "EVENT_STARTED" && (await order(o14.id)).status === "completed", "host can't cancel a paid event that already happened", r);
    r = await call("POST", `/api/events/${e14.id}/orders/${o14.id}/refund`, { token: tok(host) });
    assert(r.status === 200 && Number((await order(o14.id)).refunded_cents) === 2000, "but can still refund a single order (ticket price)", r);

    console.log("Paused event");
    const { ev: e15, types: [t15] } = await paidEvent([{ name: "GA", priceCents: 2000, quantity: 5 }], { refundPolicy: "until_cutoff", refundCutoffHours: 1 });
    const o15 = await buy(e15.id, g[6], t15.id);
    await q(`UPDATE events SET status = 'paused' WHERE id = $1`, [e15.id]);
    r = await call("POST", `/api/events/orders/${o15.id}/refund`, { token: tok(g[6]) });
    assert(r.status === 409 && r.body.error.code === "EVENT_PAUSED", "buyer refund on a paused event says paused", r);
    r = await call("POST", `/api/events/${e15.id}/orders/${o15.id}/refund`, { token: tok(host) });
    assert(r.status === 409 && r.body.error.code === "EVENT_PAUSED", "host refund on a paused event refused", r);

    console.log("Repeat checkout key on a refunded order");
    const { ev: e11, types: [t11] } = await paidEvent([{ name: "GA", priceCents: 1000, quantity: 5 }], { refundPolicy: "until_cutoff", refundCutoffHours: 1 });
    const k = await call("POST", `/api/events/${e11.id}/checkout`, { token: tok(g[3]), body: { ticketTypeId: t11.id, idempotencyKey: `${P}-key11` } });
    const pi11 = piStore[k.body.paymentIntentId]; pi11.status = "succeeded"; pi11.amount_received = pi11.amount;
    await WebhookHandlers.handlePaymentIntentSucceeded(pi11);
    await call("POST", `/api/events/orders/${k.body.orderId}/refund`, { token: tok(g[3]) });
    r = await call("POST", `/api/events/${e11.id}/checkout`, { token: tok(g[3]), body: { ticketTypeId: t11.id, idempotencyKey: `${P}-key11` } });
    assert(r.status === 200 && r.body.repeated && r.body.order.status === "refunded", "same key shows the refunded order instead of 'closed'", r);

    console.log("Emails hide the street until the day-of reveal");
    const { ev: e20, types: [t20, f20] } = await paidEvent([
      { name: "GA", priceCents: 2000, quantity: 20, maxPerOrder: 4 },
      { name: "Free", priceCents: 0, quantity: 20 },
    ], { addressVisibility: "ticket_holders_day_of", addressLine1: "9 Hidden Way", refundPolicy: "until_cutoff", refundCutoffHours: 2 });
    const mine = (n: { p: any }, i: number) => n.p.toEmail === `${P}-g${i}@test.local`;
    notices.length = 0;
    const o20 = await buy(e20.id, g[4], t20.id);
    await waitFor(() => notices.some((n) => n.kind === "receipt" && mine(n, 4)));
    const rc20 = notices.find((n) => n.kind === "receipt" && mine(n, 4))!;
    assert(rc20.p.event.whereText === "Freeport, NY", "day-of before reveal: receipt shows only city and state", rc20.p.event);
    assert(!JSON.stringify(rc20.p).includes("The Loft") && !JSON.stringify(rc20.p).includes("9 Hidden Way"), "day-of before reveal: no venue or street anywhere in the receipt", rc20.p);
    notices.length = 0;
    // Driven in this process so the recorded notices are ours (the server process would send its own).
    const rr20 = await requestOrderRefund(o20.id, g[4], "buyer");
    await processTicketRefund(o20.id, direct as any, true);
    await waitFor(() => notices.some((n) => n.kind === "refund" && mine(n, 4)));
    const rf20 = notices.find((n) => n.kind === "refund" && mine(n, 4))!;
    assert(rr20 && rf20.p.event.whereText === "Freeport, NY" && !JSON.stringify(rf20.p).includes("9 Hidden Way"), "day-of before reveal: refund email shows only city and state", rf20.p.event);
    const o20b = await buy(e20.id, g[5], t20.id);
    const rsvp20 = await call("POST", `/api/events/${e20.id}/rsvp`, { token: tok(g[6]), body: { ticketTypeId: f20.id } });
    notices.length = 0;
    await q(`UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Rain.' WHERE id = $1`, [e20.id]);
    await runTicketRefundJob(direct as any); // its sweep cancels the free RSVP and refunds the paid order, both due now
    await waitFor(() => notices.some((n) => n.kind === "cancelled" && mine(n, 6)) && notices.some((n) => n.kind === "refund" && mine(n, 5)));
    await sleep(500);
    const cn20 = notices.filter((n) => (n.kind === "cancelled" && mine(n, 6)) || (n.kind === "refund" && mine(n, 5)));
    assert(rsvp20.status === 201 && cn20.length === 2 && cn20.every((n) => n.p.event.whereText === "Freeport, NY" && !JSON.stringify(n.p).includes("9 Hidden Way")),
      "day-of before reveal: cancel and cancel refund emails show only city and state", cn20.map((n) => ({ k: n.kind, w: n.p.event.whereText })));
    assert(o20b.status === "completed", "second day-of order completed");

    const { ev: e21, types: [t21] } = await paidEvent([{ name: "GA", priceCents: 2000, quantity: 20 }], { addressVisibility: "ticket_holders_day_of", addressLine1: "9 Hidden Way" });
    await q(`UPDATE events SET starts_at = now() + interval '2 hours', ends_at = now() + interval '6 hours' WHERE id = $1`, [e21.id]);
    notices.length = 0;
    await buy(e21.id, g[7], t21.id);
    await waitFor(() => notices.some((n) => n.kind === "receipt" && mine(n, 7)));
    const rc21 = notices.find((n) => n.kind === "receipt" && mine(n, 7))!;
    assert(rc21.p.event.whereText === "The Loft, 9 Hidden Way, Freeport, NY", "day-of after reveal: receipt shows the full address", rc21.p.event);

    const { ev: e22, types: [t22] } = await paidEvent([{ name: "GA", priceCents: 2000, quantity: 20 }], { addressVisibility: "ticket_holders", addressLine1: "9 Hidden Way" });
    notices.length = 0;
    await buy(e22.id, g[8], t22.id);
    await waitFor(() => notices.some((n) => n.kind === "receipt" && mine(n, 8)));
    assert(notices.find((n) => n.kind === "receipt" && mine(n, 8))!.p.event.whereText === "The Loft, 9 Hidden Way, Freeport, NY", "ticket_holders event: receipt keeps the full address");

    const { ev: e23, types: [t23] } = await paidEvent([{ name: "GA", priceCents: 2000, quantity: 20 }], { addressVisibility: "ticket_holders_day_of" });
    await q(`UPDATE events SET state = NULL WHERE id = $1`, [e23.id]);
    notices.length = 0;
    await buy(e23.id, g[9], t23.id);
    await waitFor(() => notices.some((n) => n.kind === "receipt" && mine(n, 9)));
    const rc23 = notices.find((n) => n.kind === "receipt" && mine(n, 9))!;
    assert(rc23.p.event.whereText === "Freeport", "day-of before reveal with only a city: just the city", rc23.p.event);
    await q(`UPDATE events SET city = NULL WHERE id = $1`, [e23.id]);
    const o23 = await buy(e23.id, g[10], t23.id);
    await waitFor(() => notices.some((n) => n.kind === "receipt" && mine(n, 10)));
    assert(notices.find((n) => n.kind === "receipt" && mine(n, 10))!.p.event.whereText === null && o23.status === "completed", "day-of before reveal with no city or state: no place line");
  } finally {
    setNoticeDepsForTest(null);
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
