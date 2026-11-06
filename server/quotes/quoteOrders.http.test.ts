/**
 * Deliverables D1b (Legend 2026-11-06, D1b plan v2, "just like selling a product"): paying a deliverable quote as a
 * normal product order. Destination charge (the business is paid at payment), own PaymentIntent type quote_order (the
 * cart and stock are never touched), quote lock and version kept, webhook, backstop, Mark picked up or delivered,
 * cancel through the normal order cancel.
 *
 * Run with: npx tsx server/quotes/quoteOrders.http.test.ts
 *
 * SCRATCH ONLY. Backend on localhost with STRIPE_STUB_PORT=<QO_TEST_STRIPE_PORT>, LOCAL Postgres (through 107):
 *   QO_TEST_BASE_URL, QO_TEST_PG_URL, QO_TEST_STRIPE_PORT, JWT_SECRET (same as the server)
 * Skips (exit 0) when QO_TEST_BASE_URL is unset; refuses any non-local host.
 */
import http from "http";

const BASE = process.env.QO_TEST_BASE_URL;
const PG_URL = process.env.QO_TEST_PG_URL;
const STUB_PORT = Number(process.env.QO_TEST_STRIPE_PORT || "0");

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
    const headers: Record<string, string> = { "X-Forwarded-For": `10.98.1.${Math.floor(Math.random() * 200) + 1}` };
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

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// booking_holds.start_at as the app writes it: a local wall clock Date sent as UTC (availabilityService parseDateWithTime + drizzle).
const holdTs = (date: string, h: number, m: number) => { const [y, mo, d] = date.split("-").map(Number); return new Date(y, mo - 1, d, h, m).toISOString().replace("T", " ").replace("Z", ""); };

(async () => {
  if (!BASE) { console.log("⏭  skipped: set QO_TEST_BASE_URL (+ QO_TEST_PG_URL, QO_TEST_STRIPE_PORT) to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and QO_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "qt-test-jwt-secret";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub ──
  const piStore: Record<string, any> = {};
  const piCreates: { key: string | undefined; amount: number; metadata: Record<string, string> }[] = [];
  const refunds: any[] = [];
  const transfers: any[] = [];
  const reversals: any[] = [];
  let failNextCreateNetwork = false;
  const lostKeys = new Set<string>();
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const meta = () => { const m: Record<string, string> = {}; for (const [k, v] of form.entries()) { const x = k.match(/^metadata\[(.+)\]$/); if (x) m[x[1]] = v; } return m; };
      const url = new URL(req.url || "/", "http://stub");
      if (req.method === "POST" && url.pathname === "/v1/customers") return send(200, { id: `cus_qo_${Date.now()}`, object: "customer" });
      const custM = url.pathname.match(/^\/v1\/customers\/([^/]+)$/);
      if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
      if (req.method === "POST" && url.pathname === "/v1/customer_sessions") return send(200, { client_secret: "cuss_stub" });
      if (req.method === "POST" && url.pathname === "/v1/ephemeral_keys") return send(200, { secret: "ek_stub" });
      if (req.method === "POST" && url.pathname === "/v1/payment_intents") {
        const key = req.headers["idempotency-key"] as string | undefined;
        if (key && lostKeys.has(key)) { req.socket.destroy(); return; } // still unreachable on the SDK's retry
        const prior = Object.values(piStore).find((p: any) => p._key && p._key === key);
        if (prior) return send(200, prior);
        const metadata = meta();
        const id = `pi_qo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const isFee = metadata.type === "cancellation_fee";
        const pi = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: isFee ? Number(form.get("amount") || 0) : 0,
          status: isFee ? "succeeded" : "requires_payment_method", client_secret: `${id}_secret`, capture_method: form.get("capture_method") || "automatic",
          metadata, customer: form.get("customer"), payment_method: isFee ? form.get("payment_method") : "pm_qp_card", latest_charge: isFee ? `ch_${id}` : null,
          setup_future_usage: form.get("setup_future_usage"), transfer_data: { destination: form.get("transfer_data[destination]"), amount: Number(form.get("transfer_data[amount]") || 0) }, created: Math.floor(Date.now() / 1000), _key: key };
        piCreates.push({ key, amount: pi.amount, metadata });
        if (isFee && failNextCreateNetwork) {
          failNextCreateNetwork = false;
          if (key) lostKeys.add(key);
          piStore[id] = pi; // it lands at Stripe, but the reply is lost
          req.socket.destroy();
          return;
        }
        piStore[id] = pi;
        return send(200, pi);
      }
      if (req.method === "GET" && url.pathname === "/v1/payment_intents") {
        const customer = url.searchParams.get("customer");
        const data = Object.values(piStore).filter((p: any) => !customer || p.customer === customer);
        return send(200, { object: "list", data, has_more: false });
      }
      const piM = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (req.method === "GET" && piM) {
        const pi = piStore[piM[1]];
        if (!pi) return send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
        return send(200, { ...pi, latest_charge: pi.latest_charge ? { id: pi.latest_charge, amount_refunded: pi._refunded || 0, transfer: pi.transfer_data?.destination ? `tr_dest_${pi.id}` : null } : pi.latest_charge });
      }
      const piCancel = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (req.method === "POST" && piCancel) { const pi = piStore[piCancel[1]]; if (pi) pi.status = "canceled"; return send(200, pi); }
      if (req.method === "POST" && url.pathname === "/v1/refunds") {
        const pi = piStore[form.get("payment_intent") || ""];
        const amount = Number(form.get("amount") || (pi ? pi.amount_received - (pi._refunded || 0) : 0));
        if (pi) pi._refunded = (pi._refunded || 0) + amount;
        const r = { id: `re_qo_${refunds.length + 1}`, object: "refund", amount, payment_intent: form.get("payment_intent"), status: "succeeded", metadata: meta() };
        refunds.push(r);
        return send(200, r);
      }
      if (req.method === "GET" && url.pathname === "/v1/refunds") return send(200, { object: "list", data: refunds.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
      if (req.method === "POST" && url.pathname === "/v1/transfers") {
        const t = { id: `tr_qo_${transfers.length + 1}`, object: "transfer", amount: Number(form.get("amount")), destination: form.get("destination"),
          transfer_group: form.get("transfer_group"), metadata: meta(), source_transaction: form.get("source_transaction"), amount_reversed: 0, reversals: { data: [] } };
        transfers.push(t);
        return send(200, t);
      }
      const revM = url.pathname.match(/^\/v1\/transfers\/([^/]+)\/reversals$/);
      if (req.method === "POST" && revM) { const r = { id: `trr_qo_${reversals.length + 1}`, object: "transfer_reversal", amount: Number(form.get("amount")), transfer: revM[1] }; reversals.push(r); return send(200, r); }
      if (req.method === "GET" && url.pathname === "/v1/transfers") {
        const g = url.searchParams.get("transfer_group");
        return send(200, { object: "list", data: transfers.filter((t) => !g || t.transfer_group === g), has_more: false });
      }
      const chM = url.pathname.match(/^\/v1\/charges\/([^/]+)$/);
      if (req.method === "GET" && chM) return send(200, { id: chM[1], object: "charge", amount_refunded: 0 });
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));
  const succeed = (piId: string) => { const pi = piStore[piId]; pi.status = "succeeded"; pi.amount_received = pi.amount; pi.latest_charge = `ch_${piId}`; return { ...pi }; };

  const { WebhookHandlers } = await import("../stripe/webhookHandlers");
  const { settleStaleDeliverableOrders } = await import("./quoteOrders");
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const daysFromNow = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

  const P = `qo${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = "Ana") => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, stripe_customer_id) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4)`, [uid, `${uid}@qo.test`, first, `cus_${uid}`]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: false, isAdmin: false }) };
  };
  let [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true LIMIT 1`);
  let tierMade = false;
  if (!tier) { [tier] = await q(`INSERT INTO subscription_tiers (id, name, display_name, price_monthly, is_active) VALUES ($1, 'qo', 'QO', 1000, true) RETURNING id`, [id("tier")]); tierMade = true; }
  const mkBiz = async (key: string, ownerId: string, o: { plan?: boolean } = {}) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, time_zone, stripe_account_id, stripe_onboarding_complete, vendor_agreement_accepted, auto_accept_bookings)
             VALUES ($1, $2, $3, 'food', 'approved', 'America/New_York', $4, true, true, true)`, [bid, ownerId, `Sweets ${key}`, `acct_${key}_${P}`]);
    if (o.plan ?? true) await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_end) VALUES ($1, $2, $3, $4, 'active', now() + interval '30 days')`, [id(`sub-${key}`), ownerId, bid, tier.id]);
    bizs.push(bid);
    return bid;
  };
  const mkConv = async (a: string, b: string, k: string) => {
    const [p1, p2] = a < b ? [a, b] : [b, a];
    const cid = id(`c-${k}`);
    await q(`INSERT INTO conversations (id, participant1_id, participant2_id) VALUES ($1, $2, $3)`, [cid, p1, p2]);
    return cid;
  };

  const owner = await mkUser("owner", "Jazzy");
  const owner2 = await mkUser("owner2", "Nope");
  const cust = await mkUser("cust");
  const cust2 = await mkUser("cust2", "Bo");
  const biz = await mkBiz("a", owner.uid);
  const bizNoPlan = await mkBiz("np", owner2.uid, { plan: false });
  const conv = await mkConv(owner.uid, cust.uid, "a");
  const conv2 = await mkConv(owner.uid, cust2.uid, "b");
  const convNp = await mkConv(owner2.uid, cust.uid, "np");
  const prod = id("prod");
  await q(`INSERT INTO vendor_products (id, business_id, name, price, status, is_active, inventory, track_inventory) VALUES ($1, $2, 'Custom cakes', 5000, 'live', true, 7, true)`, [prod, biz]);
  await q(`INSERT INTO cart_items (id, user_id, product_id, product_name, price_in_cents, quantity, business_id) VALUES ($1, $2, $3, 'Custom cakes', 5000, 1, $4)`, [id("cart"), cust.uid, prod, biz]);

  const send = async (body: Record<string, unknown>, token = owner.token) => call("POST", "/api/quotes", { token, body });
  const cake = (o: Record<string, unknown> = {}) => ({ conversationId: conv, kind: "product", title: "Two tier birthday cake", dueDate: daysFromNow(14), totalCents: 20000, paymentMode: "full", ...o });
  const pay = async (quoteId: string, version: number, token = cust.token, extra: Record<string, unknown> = {}) => call("POST", `/api/quotes/${quoteId}/pay`, { token, body: { version, paymentSheet: true, ...extra } });
  const orderOf = async (oid: string) => (await q(`SELECT * FROM orders WHERE id = $1`, [oid]))[0];
  const quoteRow = async (qid: string) => (await q(`SELECT * FROM quotes WHERE id = $1`, [qid]))[0];

  try {
    console.log("\n── before paying ──");
    const dq = (await send(cake({ fulfillment: "delivery", deliveryFeeCents: 2000 }))).body?.quote;
    const noAddr = await pay(dq.id, dq.version);
    assert(noAddr.status === 400 && noAddr.body?.code === "ADDRESS_NEEDED" && piCreates.length === 0, "Delivery needs the address before paying", noAddr.body);
    const npq = (await send({ ...cake(), conversationId: convNp }, owner2.token)).body?.quote;
    const np = await pay(npq.id, npq.version);
    assert(np.status === 400 && np.body?.code === "PLAN_NOT_ACTIVE" && piCreates.length === 0, "the business must have an active plan", np.body);
    const stale = await pay(dq.id, dq.version + 5);
    assert(stale.status === 409 && stale.body?.code === "QUOTE_CHANGED", "an old version can't be paid", stale.body);

    console.log("\n── paying a Pickup deliverable in full ──");
    const pq = (await send(cake({ productId: prod }))).body?.quote;
    const r1 = await pay(pq.id, pq.version);
    const pi1 = piCreates[piCreates.length - 1];
    assert(r1.status === 200 && r1.body?.orderId && r1.body.clientSecret && r1.body.amounts?.baseCents === 20000 && r1.body.amounts.chargeCents === 20000 + r1.body.amounts.serviceFeeCents, "the payment starts: the total plus the service fee", r1.body);
    assert(pi1?.metadata?.type === "quote_order" && pi1.metadata.orderId === r1.body?.orderId && pi1.metadata.quoteId === pq.id && pi1.metadata.quoteVersion === String(pq.version), "own payment type, with the order and the quote version", pi1?.metadata);
    const st1 = piStore[r1.body?.paymentIntentId];
    const o1 = await orderOf(r1.body?.orderId);
    assert(st1?.transfer_data?.destination === `acct_a_${P}` && st1.transfer_data.amount === o1.vendor_net && o1.vendor_net === 20000 - o1.platform_fee, "a destination charge: the business's share is sent inside the payment", { td: st1?.transfer_data, o1 });
    assert(o1.status === "pending" && o1.total_amount === 20000 && o1.quote_id === pq.id && o1.fulfillment === "pickup" && o1.quote_total_cents === 20000 && o1.paid_directly_cents === 0 && o1.items?.length === 1 && o1.items[0].name === "Two tier birthday cake" && o1.items[0].productId === prod && o1.business_id === biz, "a pending order: one line, the quote title, the linked product as a label", o1);
    const lock1 = await quoteRow(pq.id);
    assert(!!lock1.paying_until && lock1.status === "sent", "the quote is locked while paying", lock1);
    const edit = await call("PATCH", `/api/quotes/${pq.id}`, { token: owner.token, body: { ...cake(), version: pq.version } });
    assert(edit.status === 409 && edit.body?.code === "QUOTE_PAYING", "the business can't edit while the customer pays", edit.body);
    const n = piCreates.length;
    const r1b = await pay(pq.id, pq.version);
    assert(r1b.status === 200 && r1b.body?.paymentIntentId === r1.body?.paymentIntentId && piCreates.length === n, "tapping Pay again picks up the same payment", r1b.body);
    const other = await pay(pq.id, pq.version, cust2.token);
    assert(other.status === 404, "another customer can't pay it", other.body);

    console.log("\n── a declined card ──");
    await WebhookHandlers.handlePaymentIntentFailed({ ...piStore[r1.body.paymentIntentId], metadata: piStore[r1.body.paymentIntentId].metadata });
    assert((await orderOf(r1.body.orderId)).status === "pending", "a decline leaves the order pending (another card can be tried)");

    console.log("\n── paid ──");
    const stockBefore = (await q(`SELECT inventory FROM vendor_products WHERE id = $1`, [prod]))[0].inventory;
    const cartBefore = (await q(`SELECT count(*)::int n FROM cart_items WHERE user_id = $1`, [cust.uid]))[0].n;
    const paid = succeed(r1.body.paymentIntentId);
    await Promise.all([WebhookHandlers.handlePaymentIntentSucceeded({ ...paid }), WebhookHandlers.handlePaymentIntentSucceeded({ ...paid })]);
    const o1p = await orderOf(r1.body.orderId);
    const q1p = await quoteRow(pq.id);
    assert(o1p.status === "paid" && o1p.stripe_payment_intent_id === paid.id && !!o1p.paid_at, "the order is paid", o1p);
    assert(q1p.status === "paid" && q1p.order_id === o1p.id && q1p.paying_until === null && q1p.appointment_id === null, "the quote is paid by the order (no booking)", q1p);
    const cards = await q(`SELECT card FROM messages WHERE conversation_id = $1 AND kind = 'quote' AND card->>'event' = 'paid' AND card->>'quoteId' = $2`, [conv, pq.id]);
    assert(cards.length === 1 && cards[0].card.orderId === o1p.id && cards[0].card.kind === "product", "one Paid card in the chat, with the order", cards);
    assert((await q(`SELECT inventory FROM vendor_products WHERE id = $1`, [prod]))[0].inventory === stockBefore, "stock never changes");
    assert(cartBefore === 1 && (await q(`SELECT count(*)::int n FROM cart_items WHERE user_id = $1`, [cust.uid]))[0].n === 1, "the customer's cart is left alone", cartBefore);
    const pts = await q(`SELECT count(*)::int n FROM point_transactions WHERE reference_type = 'cart_order' AND reference_id = $1`, [o1p.id]).catch(() => [{ n: -1 }]);
    assert(pts[0].n === 1, "points right away, once, as on a product purchase", pts);
    assert((await q(`SELECT count(*)::int n FROM appointments WHERE quote_id = $1`, [pq.id]))[0].n === 0, "no booking is made");
    const again = await pay(pq.id, pq.version);
    assert(again.status === 409 && again.body?.code === "QUOTE_CLOSED", "a paid deliverable can't be paid again", again.body);
    const read = await call("GET", `/api/quotes/${pq.id}`, { token: cust.token });
    assert(read.body?.quote?.orderId === o1p.id && read.body.quote.orderStatus === "paid" && read.body.quote.status === "paid", "the quote shows its order and its status", read.body?.quote);

    console.log("\n── in Orders ──");
    const bl = await call("GET", "/api/business/orders", { token: owner.token });
    // Found by its quote: the local Neon proxy reads joined rows by column name, so the joined users.id hides orders.id
    // here (real Neon returns columns by position).
    const bo = bl.body?.orders?.find((o: any) => o.quoteId === pq.id);
    assert(bl.status === 200 && bo && bo.quoteId === pq.id && bo.fulfillment === "pickup", "the business sees it in Orders, marked Pickup", bo ?? { status: bl.status, n: bl.body?.orders?.length, body: bl.body });
    const bs = await call("GET", "/api/business/orders?format=snake", { token: owner.token });
    const bso = bs.body?.orders?.find((o: any) => o.quote_id === pq.id);
    assert(bso?.quote_id === pq.id && bso.fulfillment === "pickup" && bso.quote_total_cents === 20000, "the vendor site shape has the same fields", bso);
    const ml = await call("GET", "/api/my-orders", { token: cust.token });
    const mo = ml.body?.orders?.find((o: any) => o.id === o1p.id);
    assert(mo && mo.quoteId === pq.id && mo.fulfillment === "pickup" && mo.items?.[0]?.name === "Two tier birthday cake", "the customer sees it in My orders", mo);

    console.log("\n── Mark picked up ──");
    const notMine = await call("POST", `/api/business/orders/${o1p.id}/handed-over`, { token: owner2.token });
    assert(notMine.status === 404, "another business can't mark it", notMine.body);
    const custTry = await call("POST", `/api/business/orders/${o1p.id}/handed-over`, { token: cust.token });
    assert(custTry.status === 404, "the customer can't mark it", custTry.body);
    const ho = await call("POST", `/api/business/orders/${o1p.id}/handed-over`, { token: owner.token });
    assert(ho.status === 200 && ho.body?.order?.status === "delivered", "the business marks it picked up: Delivered", ho.body);
    const ho2 = await call("POST", `/api/business/orders/${o1p.id}/handed-over`, { token: owner.token });
    assert(ho2.status === 200 && ho2.body?.message === "Already marked", "marking it again is harmless", ho2.body);
    const cartOrder = id("cartorder");
    await q(`INSERT INTO orders (id, business_id, customer_id, items, total_amount, status) VALUES ($1, $2, $3, '[{"productId":"x","name":"Shirt","quantity":1,"price":2000}]', 2000, 'paid')`, [cartOrder, biz, cust.uid]);
    const shipOnly = await call("POST", `/api/business/orders/${cartOrder}/handed-over`, { token: owner.token });
    assert(shipOnly.status === 409 && shipOnly.body?.code === "NOT_HANDED_OVER_ORDER" && /tracking/.test(shipOnly.body.message), "a shipped order still needs carrier and tracking", shipOnly.body);

    console.log("\n── a deposit with the rest paid directly, and Delivery ──");
    const addr = await call("POST", `/api/quotes/${dq.id}/delivery-address`, { token: cust.token, body: { address: "14 Oak Ave, Uniondale, NY 11553" } });
    assert(addr.status === 200, "the customer adds the address", addr.body);
    const dEdit = await call("PATCH", `/api/quotes/${dq.id}`, { token: owner.token, body: { kind: "product", title: "Wedding cake", totalCents: 50000, paymentMode: "deposit", depositCents: 15000, restPaid: "outside", deliveryFeeCents: 3000, version: dq.version } });
    const dqv = dEdit.body?.quote;
    const r2 = await pay(dq.id, dqv.version);
    const o2 = await orderOf(r2.body?.orderId);
    assert(r2.status === 200 && o2.total_amount === 15000 && o2.quote_total_cents === 50000 && o2.paid_directly_cents === 35000 && o2.fulfillment === "delivery" && o2.shipping_address === "14 Oak Ave, Uniondale, NY 11553", "the order is the deposit; the total and the part paid directly are kept; the address is the shipping address", o2);
    await WebhookHandlers.handlePaymentIntentSucceeded(succeed(r2.body.paymentIntentId));
    assert((await orderOf(o2.id)).status === "paid", "the deposit order is paid");

    console.log("\n── the business cancels: refund like a product order ──");
    const before = refunds.length;
    const cancel = await call("PATCH", `/api/business/orders/${o2.id}`, { token: owner.token, body: { status: "cancelled" } });
    const o2c = await orderOf(o2.id);
    const rf = refunds.slice(before);
    assert(cancel.status === 200 && o2c.status === "cancelled", "the business cancels the paid order", { s: cancel.status, b: cancel.body, st: o2c.status });
    assert(rf.length === 1 && rf[0].amount === 15000, "the business's part is refunded in full, the service fee is kept", rf);
    assert(reversals.some((x) => x.amount === o2.vendor_net), "the business's share is taken back", reversals);
    const r2read = await call("GET", `/api/quotes/${dq.id}`, { token: cust.token });
    assert(r2read.body?.quote?.orderStatus === "cancelled", "the quote shows the order was cancelled", r2read.body?.quote?.orderStatus);

    console.log("\n── the quote changed before Stripe confirmed ──");
    const cq = (await send({ ...cake(), conversationId: conv2 })).body?.quote;
    const r3 = await pay(cq.id, cq.version, cust2.token);
    await q(`UPDATE quotes SET version = version + 1, paying_until = NULL WHERE id = $1`, [cq.id]);
    const rb = refunds.length;
    const paid3 = succeed(r3.body.paymentIntentId);
    await WebhookHandlers.handlePaymentIntentSucceeded(paid3);
    const o3 = await orderOf(r3.body.orderId);
    assert(o3.status === "cancelled" && (await quoteRow(cq.id)).status === "sent", "the order is cancelled and the quote stays open", { o3: o3.status });
    assert(refunds.length === rb + 1 && refunds[rb].amount === paid3.amount, "everything is refunded, the service fee too", refunds.slice(rb));

    console.log("\n── backstop ──");
    const bq = (await send({ ...cake(), conversationId: conv2, title: "Cupcakes" })).body?.quote;
    const r4 = await pay(bq.id, bq.version, cust2.token);
    succeed(r4.body.paymentIntentId); // paid at Stripe, the webhook never came
    await q(`UPDATE orders SET created_at = now() - interval '5 minutes' WHERE id = $1`, [r4.body.orderId]);
    const s1 = await settleStaleDeliverableOrders();
    assert(s1.confirmed >= 1 && (await orderOf(r4.body.orderId)).status === "paid" && (await quoteRow(bq.id)).status === "paid", "a lost webhook is confirmed by the quote job", s1);
    const sq = (await send({ ...cake(), conversationId: conv2, title: "Cookies" })).body?.quote;
    const r5 = await pay(sq.id, sq.version, cust2.token);
    await q(`UPDATE orders SET created_at = now() - interval '20 minutes' WHERE id = $1`, [r5.body.orderId]);
    await q(`UPDATE quotes SET paying_until = now() - interval '1 minute' WHERE id = $1`, [sq.id]);
    const s2 = await settleStaleDeliverableOrders();
    const o5 = await orderOf(r5.body.orderId);
    assert(s2.retired >= 1 && o5.status === "cancelled" && piStore[r5.body.paymentIntentId].status === "canceled" && (await quoteRow(sq.id)).paying_until === null, "an abandoned payment is retired after its lock", { s2, st: o5.status });
    const r6 = await pay(sq.id, sq.version, cust2.token);
    assert(r6.status === 200 && r6.body?.orderId !== r5.body.orderId, "the customer can start again with a new order", r6.body);
    const early = await call("POST", `/api/business/orders/${r6.body.orderId}/handed-over`, { token: owner.token });
    assert(early.status === 409 && early.body?.code === "NOT_HANDED_OVER_ORDER" && (await orderOf(r6.body.orderId)).status === "pending", "an unpaid order can't be marked picked up", early.body);
  } finally {
    await q(`UPDATE quotes SET order_id = NULL, message_id = NULL WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM point_transactions WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM audit_logs WHERE actor_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM orders WHERE business_id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup orders", e.message));
    await q(`DELETE FROM quotes WHERE business_id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup quotes", e.message));
    await q(`DELETE FROM cart_items WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM messages WHERE sender_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM vendor_products WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup businesses", e.message));
    if (tierMade) await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tier.id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch((e) => console.error("cleanup users", e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
