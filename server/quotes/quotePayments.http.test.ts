/**
 * Paying a quote (Quotes in Messages, step 3, migration 098): HTTP + webhook integration tests.
 *
 * Legend 2026-11-04 (all 12 recommended): quote payments check that the business can take money (R38 rule for
 * quotes); a full price quote cancel refunds the price minus the vendor's fee; the vendor keeps a quote's
 * cancellation fee; the quote's service policy (else the business's) is saved at payment; only an overlap refuses
 * the time; extra days are blocked; edits, withdraw, decline and expiry wait while a payment runs and a changed
 * quote is refunded in full; a paid quote confirms right away; points codes allowed; a backstop for missed Stripe
 * confirmations; R39 on both fee callers; quotes expire the day before the job.
 *
 * Run with: npx tsx server/quotes/quotePayments.http.test.ts
 *
 * SCRATCH ONLY. Backend booted on localhost against a LOCAL scratch Postgres (migrations through 098) with the
 * Stripe stub preload, and this process reaches the same DB (webhooks and jobs run in process):
 *   QP_TEST_BASE_URL     e.g. http://localhost:5062 (must be localhost)
 *   QP_TEST_PG_URL       the SAME scratch database (localhost only; seeds + cleans up)
 *   QP_TEST_STRIPE_PORT  port for the Stripe stub started here (server booted with STRIPE_STUB_PORT=<same>)
 *   JWT_SECRET           identical to the server's
 *   DATABASE_URL, STRIPE_SECRET_KEY=sk_test_stub, STRIPE_STUB_PORT and
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 * Skips (exit 0) when QP_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe.
 */
import http from "http";

const BASE = process.env.QP_TEST_BASE_URL;
const PG_URL = process.env.QP_TEST_PG_URL;
const STUB_PORT = Number(process.env.QP_TEST_STRIPE_PORT || "0");

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
  if (!BASE) { console.log("⏭  skipped: set QP_TEST_BASE_URL (+ QP_TEST_PG_URL, QP_TEST_STRIPE_PORT) to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and QP_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "qp-test-jwt";
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
  let failNextCreateNetwork = false;
  const lostKeys = new Set<string>();
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const meta = () => { const m: Record<string, string> = {}; for (const [k, v] of form.entries()) { const x = k.match(/^metadata\[(.+)\]$/); if (x) m[x[1]] = v; } return m; };
      const url = new URL(req.url || "/", "http://stub");
      if (req.method === "POST" && url.pathname === "/v1/customers") return send(200, { id: `cus_qp_${Date.now()}`, object: "customer" });
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
        const id = `pi_qp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const isFee = metadata.type === "cancellation_fee";
        const pi = { id, object: "payment_intent", amount: Number(form.get("amount") || 0), amount_received: isFee ? Number(form.get("amount") || 0) : 0,
          status: isFee ? "succeeded" : "requires_payment_method", client_secret: `${id}_secret`, capture_method: form.get("capture_method") || "automatic",
          metadata, customer: form.get("customer"), payment_method: isFee ? form.get("payment_method") : "pm_qp_card", latest_charge: isFee ? `ch_${id}` : null,
          setup_future_usage: form.get("setup_future_usage"), created: Math.floor(Date.now() / 1000), _key: key };
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
        return send(200, { ...pi, latest_charge: pi.latest_charge ? { id: pi.latest_charge, amount_refunded: pi._refunded || 0 } : pi.latest_charge });
      }
      const piCancel = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (req.method === "POST" && piCancel) { const pi = piStore[piCancel[1]]; if (pi) pi.status = "canceled"; return send(200, pi); }
      if (req.method === "POST" && url.pathname === "/v1/refunds") {
        const pi = piStore[form.get("payment_intent") || ""];
        const amount = Number(form.get("amount") || (pi ? pi.amount_received - (pi._refunded || 0) : 0));
        if (pi) pi._refunded = (pi._refunded || 0) + amount;
        const r = { id: `re_qp_${refunds.length + 1}`, object: "refund", amount, payment_intent: form.get("payment_intent"), status: "succeeded", metadata: meta() };
        refunds.push(r);
        return send(200, r);
      }
      if (req.method === "GET" && url.pathname === "/v1/refunds") return send(200, { object: "list", data: refunds.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
      if (req.method === "POST" && url.pathname === "/v1/transfers") {
        const t = { id: `tr_qp_${transfers.length + 1}`, object: "transfer", amount: Number(form.get("amount")), destination: form.get("destination"),
          transfer_group: form.get("transfer_group"), metadata: meta(), source_transaction: form.get("source_transaction"), amount_reversed: 0, reversals: { data: [] } };
        transfers.push(t);
        return send(200, t);
      }
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
  const { confirmMissedQuotePayments } = await import("./quotePaid");
  const { expireDueQuotes } = await import("./quoteExpiry");
  const { chargeCancellationFeeOnce, resolveStaleFeeCharges } = await import("../payments/cancellationFees");

  const P = `qp${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = "Ana") => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, stripe_customer_id) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4)`, [uid, `${uid}@qp.test`, first, `cus_${uid}`]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: false, isAdmin: false }) };
  };
  let [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true LIMIT 1`);
  let tierMade = false;
  if (!tier) {
    [tier] = await q(`INSERT INTO subscription_tiers (id, name, display_name, price_monthly, is_active) VALUES ($1, 'qp', 'QP', 1000, true) RETURNING id`, [id("tier")]);
    tierMade = true;
  }
  const mkBiz = async (key: string, ownerId: string, o: { onboarded?: boolean; plan?: boolean; agreement?: boolean; autoAccept?: boolean; fee?: [string, number] | null } = {}) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, time_zone, stripe_account_id, stripe_onboarding_complete, vendor_agreement_accepted, auto_accept_bookings,
               has_cancellation_fee, cancellation_fee_type, cancellation_fee_amount, full_refund_window, has_partial_refund, partial_refund_window, partial_refund_percentage)
             VALUES ($1, $2, $3, 'home', 'approved', 'America/New_York', $4, $5, $6, $7, $8, $9, $10, 'never', true, '24_hours', 50)`,
      [bid, ownerId, `Movers ${key}`, `acct_${key}_${P}`, o.onboarded ?? true, o.agreement ?? true, o.autoAccept ?? true,
        o.fee ? true : false, o.fee ? o.fee[0] : null, o.fee ? o.fee[1] : null]);
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
  let qn = 0;
  const mkQuote = async (o: { biz: string; sender: string; customer: string; conv: string; jobDate?: string; start?: string; minutes?: number; total?: number; deposit?: number | null; serviceId?: string | null; requestId?: string | null; staffId?: string | null }) => {
    const qid = id(`q${++qn}`);
    const deposit = o.deposit === undefined ? 10000 : o.deposit;
    await q(`INSERT INTO quotes (id, business_id, staff_member_id, sender_id, customer_id, conversation_id, request_id, service_id, title, job_date, start_time, duration_minutes, time_zone, starts_at,
               total_cents, payment_mode, deposit_cents, expires_at, link_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2 Bedroom Move', $9, $10, $11, 'America/New_York', now() + interval '10 days', $12, $13, $14, now() + interval '6 days', $15)`,
      [qid, o.biz, o.staffId ?? null, o.sender, o.customer, o.conv, o.requestId ?? null, o.serviceId ?? null, o.jobDate ?? daysFromNow(10), o.start ?? "09:00", o.minutes ?? 300,
        o.total ?? 65000, deposit === null ? "full" : "deposit", deposit, `lc${qid}`]);
    return qid;
  };
  const quoteRow = async (qid: string) => (await q(`SELECT * FROM quotes WHERE id = $1`, [qid]))[0];
  const apptOf = async (qid: string) => (await q(`SELECT * FROM appointments WHERE quote_id = $1 ORDER BY created_at DESC`, [qid]));

  const owner = await mkUser("owner", "Benny");
  const cust = await mkUser("cust");
  const cust2 = await mkUser("cust2");
  const ownerNo = await mkUser("ownerno", "Nopay");
  const biz = await mkBiz("a", owner.uid, { autoAccept: false, fee: ["flat", 5000] });
  const bizNoPayouts = await mkBiz("np", ownerNo.uid, { onboarded: false });
  const conv = await mkConv(owner.uid, cust.uid, "a");
  const conv2 = await mkConv(owner.uid, cust2.uid, "a2");
  const convNo = await mkConv(ownerNo.uid, cust.uid, "np");
  const svc = id("svc");
  await q(`INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, is_active, status, request_only, has_cancellation_fee, cancellation_fee_type, cancellation_fee_amount)
           VALUES ($1, $2, 'Standard Move', 30000, 180, true, 'live', true, true, 'flat', 5000)`, [svc, biz]);
  const reqId = id("req");
  await q(`INSERT INTO estimate_requests (id, business_id, customer_id, service_id, service_name, customer_name, customer_email, customer_phone, status, conversation_id) VALUES ($1, $2, $3, $4, 'Standard Move', 'Ana', 'ana@qp.test', '757 555 0100', 'quoted', $5)`, [reqId, biz, cust.uid, svc, conv]);

  try {
    console.log("\n── who can pay, and the R38 rule for quotes ──");
    const qNo = await mkQuote({ biz: bizNoPayouts, sender: ownerNo.uid, customer: cust.uid, conv: convNo });
    let r = await call("POST", `/api/quotes/${qNo}/pay`, { token: cust.token, body: { version: 1 } });
    assert(r.status === 400 && r.body?.code === "PAYOUTS_NOT_READY", "a Stripe account id without finished payouts can't take quote payments", r);
    assert(typeof r.body?.message === "string" && !/ - | — | – /.test(r.body.message), "customer message reads plainly", r.body);
    assert(piCreates.length === 0, "nothing charged");
    await q(`UPDATE businesses SET stripe_onboarding_complete = true, vendor_agreement_accepted = false WHERE id = $1`, [bizNoPayouts]);
    r = await call("POST", `/api/quotes/${qNo}/pay`, { token: cust.token, body: { version: 1 } });
    assert(r.status === 400 && r.body?.code === "AGREEMENT_NOT_ACCEPTED", "Vendor Agreement not accepted: refused", r);
    await q(`UPDATE businesses SET vendor_agreement_accepted = true WHERE id = $1`, [bizNoPayouts]);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = $1`, [bizNoPayouts]);
    r = await call("POST", `/api/quotes/${qNo}/pay`, { token: cust.token, body: { version: 1 } });
    assert(r.status === 400 && r.body?.code === "PLAN_NOT_ACTIVE", "no active plan: refused", r);

    const q1 = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, serviceId: svc, requestId: reqId });
    r = await call("POST", `/api/quotes/${q1}/pay`, { token: cust2.token, body: { version: 1 } });
    assert(r.status === 404, "someone else can't pay it", r);
    r = await call("POST", `/api/quotes/${q1}/pay`, { token: owner.token, body: { version: 1 } });
    assert(r.status === 404, "the business can't pay its own quote", r);
    r = await call("POST", `/api/quotes/${q1}/pay`, { token: cust.token, body: {} });
    assert(r.status === 400 && r.body?.field === "version", "version required", r);
    r = await call("POST", `/api/quotes/${q1}/pay`, { token: cust.token, body: { version: 2 } });
    assert(r.status === 409 && r.body?.code === "QUOTE_CHANGED", "an old version can't be paid", r);

    console.log("\n── paying a deposit quote ──");
    r = await call("POST", `/api/quotes/${q1}/pay`, { token: cust.token, body: { version: 1 } });
    assert(r.status === 200 && typeof r.body?.clientSecret === "string" && r.body?.quoteId === q1, "pay starts a payment", r);
    const pi1 = piStore[r.body?.paymentIntentId];
    assert(pi1?.amount === 10800, "charged the deposit plus the service fee, the same as the quote card (payNowCents)", pi1?.amount);
    assert(pi1?.metadata?.type === "appointment" && pi1.metadata.quoteId === q1 && pi1.metadata.quoteVersion === "1", "same booking PaymentIntent, with the quote and version", pi1?.metadata);
    assert(pi1?.setup_future_usage === "off_session", "card saved for the balance (step 4)", pi1?.setup_future_usage);
    assert(pi1?.capture_method === "automatic", "charged now even though this business accepts bookings by hand (call 8)", pi1?.capture_method);
    let [a1] = await apptOf(q1);
    assert(a1 && a1.status === "pending_payment" && a1.total_price === 65000 && a1.deposit_amount_cents === 10000 && a1.capture_method === "automatic", "pending booking with the quote's total and deposit", a1);
    assert(a1?.service_cancellation_fee_amount === 5000 && a1?.service_has_cancellation_fee === true, "the service policy is saved on the booking (call 4)", a1);
    assert(a1?.appointment_time === "09:00" && a1?.appointment_end_time === "14:00" && a1?.duration_minutes === 300, "the quote's own time and length", a1);
    const [h1] = await q(`SELECT * FROM booking_holds WHERE quote_id = $1`, [q1]);
    assert(h1 && h1.status === "active" && h1.id === a1?.hold_id, "the time is held while paying", h1);
    let qr = await quoteRow(q1);
    assert(qr.status === "sent" && qr.paying_until !== null, "the quote stays open, locked while paying", qr);

    console.log("\n── locked while paying (call 7) ──");
    r = await call("PATCH", `/api/quotes/${q1}`, { token: owner.token, body: { version: 1, title: "Changed", jobDate: daysFromNow(10), startTime: "09:00", durationMinutes: 300, totalCents: 70000, paymentMode: "deposit", depositCents: 10000 } });
    assert(r.status === 409 && r.body?.code === "QUOTE_PAYING", "edit waits", r);
    r = await call("POST", `/api/quotes/${q1}/withdraw`, { token: owner.token });
    assert(r.status === 409 && r.body?.code === "QUOTE_PAYING", "withdraw waits", r);
    r = await call("POST", `/api/quotes/${q1}/decline`, { token: cust.token, body: {} });
    assert(r.status === 409 && r.body?.code === "QUOTE_PAYING", "decline waits", r);
    await q(`UPDATE quotes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [q1]);
    await expireDueQuotes();
    qr = await quoteRow(q1);
    assert(qr.status === "sent", "expiry waits for the payment", qr.status);
    r = await call("GET", `/api/quotes/${q1}`, { token: cust.token });
    assert(r.body?.quote?.status === "sent" && r.body.quote.paying === true, "reads open and paying", r.body?.quote);
    const before = piCreates.length;
    r = await call("POST", `/api/quotes/${q1}/pay`, { token: cust.token, body: { version: 1 } });
    assert(r.status === 200 && r.body?.paymentIntentId === pi1.id && piCreates.length === before, "tapping Pay again picks up the same payment", r);

    console.log("\n── Stripe confirms: the quote becomes a booking ──");
    await WebhookHandlers.handlePaymentIntentSucceeded(succeed(pi1.id));
    [a1] = await apptOf(q1);
    qr = await quoteRow(q1);
    assert(a1.status === "confirmed", "booking confirmed", a1.status);
    assert(qr.status === "paid" && qr.appointment_id === a1.id && qr.paid_at && qr.paying_until === null, "quote paid and linked to its booking", qr);
    const [rq] = await q(`SELECT status FROM estimate_requests WHERE id = $1`, [reqId]);
    assert(rq.status === "booked", "request moves to booked", rq);
    const cards = await q(`SELECT * FROM messages WHERE conversation_id = $1 AND kind = 'quote' ORDER BY created_at`, [conv]);
    const paidCard = cards.find((m: any) => m.card?.event === "paid");
    assert(paidCard && paidCard.sender_id === cust.uid && paidCard.content === "Paid the deposit for 2 Bedroom Move." && paidCard.card.appointmentId === a1.id, "paid card in Messages, readable on older builds", paidCard);
    const share = transfers.find((t) => t.transfer_group === `appointment_${a1.id}` && t.metadata?.recipient === "business");
    assert(share && share.amount === 9800, "the vendor's deposit share is paid like any deposit booking", share);
    const [pts] = await q(`SELECT count(*)::int AS n FROM pending_points_transactions WHERE reference_type = 'appointment' AND reference_id = $1`, [a1.id]);
    assert(pts.n === 1, "loyalty rewards points pending as for bookings", pts);
    await WebhookHandlers.handlePaymentIntentSucceeded(succeed(pi1.id));
    const cards2 = await q(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND kind = 'quote' AND card->>'event' = 'paid'`, [conv]);
    assert(cards2[0].n === 1, "a repeated webhook adds nothing", cards2);
    r = await call("POST", `/api/quotes/${q1}/pay`, { token: cust.token, body: { version: 1 } });
    assert(r.status === 409 && r.body?.code === "QUOTE_CLOSED", "a paid quote can't be paid again", r);

    console.log("\n── the time must be free (call 5) ──");
    const qClash = await mkQuote({ biz, sender: owner.uid, customer: cust2.uid, conv: conv2, start: "13:00", minutes: 60 });
    r = await call("POST", `/api/quotes/${qClash}/pay`, { token: cust2.token, body: { version: 1 } });
    assert(r.status === 409 && r.body?.code === "SLOT_TAKEN", "overlaps the paid booking: refused", r);
    assert((await quoteRow(qClash)).paying_until === null, "refused before locking", null);
    const qLater = await mkQuote({ biz, sender: owner.uid, customer: cust2.uid, conv: conv2, start: "14:00", minutes: 60 });
    await q(`INSERT INTO booking_holds (id, provider_type, provider_id, user_id, service_id, service_name, service_price_cents, duration_minutes, hold_date, start_time, end_time, start_at, end_at, status, expires_at)
             VALUES ($1, 'business', $2, $3, $4, 'Someone else', 1000, 60, $5, '14:30', '15:30', $6::timestamp, $7::timestamp, 'active', now() + interval '10 minutes')`,
      [id("hold-other"), biz, owner.uid, svc, daysFromNow(10), holdTs(daysFromNow(10), 14, 30), holdTs(daysFromNow(10), 15, 30)]);
    r = await call("POST", `/api/quotes/${qLater}/pay`, { token: cust2.token, body: { version: 1 } });
    assert(r.status === 409 && r.body?.code === "SLOT_TAKEN", "an overlapping hold is refused by the database", r);
    const ql = await quoteRow(qLater);
    assert(ql.paying_until === null && ql.status === "sent", "the lock is given back", ql);
    assert((await q(`SELECT count(*)::int AS n FROM appointments WHERE quote_id = $1`, [qLater]))[0].n === 0, "no booking row made");

    console.log("\n── a quote that changed before Stripe confirmed is refunded ──");
    const qChg = await mkQuote({ biz, sender: owner.uid, customer: cust2.uid, conv: conv2, start: "17:00", minutes: 60 });
    r = await call("POST", `/api/quotes/${qChg}/pay`, { token: cust2.token, body: { version: 1 } });
    assert(r.status === 200, "payment started", r);
    const piChg = r.body?.paymentIntentId;
    await q(`UPDATE quotes SET version = 2, paying_until = NULL WHERE id = $1`, [qChg]);
    await WebhookHandlers.handlePaymentIntentSucceeded(succeed(piChg));
    const [aChg] = await apptOf(qChg);
    assert(aChg.status === "canceled", "booking canceled", aChg.status);
    assert(refunds.some((x) => x.payment_intent === piChg && x.amount === piStore[piChg].amount), "everything refunded", refunds);
    assert((await quoteRow(qChg)).status === "sent", "the changed quote stays open", null);
    assert(!transfers.some((t) => t.transfer_group === `appointment_${aChg.id}`), "the vendor is never paid for it", null);

    console.log("\n── full price quote, multi day job (call 6) ──");
    const qLong = await mkQuote({ biz, sender: owner.uid, customer: cust2.uid, conv: conv2, jobDate: daysFromNow(20), start: "08:00", minutes: 2 * 24 * 60, deposit: null, total: 250000, serviceId: null });
    r = await call("POST", `/api/quotes/${qLong}/pay`, { token: cust2.token, body: { version: 1 } });
    assert(r.status === 200 && piStore[r.body?.paymentIntentId]?.amount === 270000, "full price plus the service fee", piStore[r.body?.paymentIntentId]?.amount);
    const piLong = r.body.paymentIntentId;
    let [aLong] = await apptOf(qLong);
    assert(aLong.deposit_amount_cents === null && aLong.appointment_end_time === "23:59", "first day booked to midnight", aLong);
    assert(aLong.service_cancellation_fee_amount === 5000 && aLong.service_cancellation_fee_type === "flat" && aLong.service_partial_refund_percentage === 50, "no service: the business policy is saved", aLong);
    await WebhookHandlers.handlePaymentIntentSucceeded(succeed(piLong));
    const blocks = await q(`SELECT * FROM provider_blocks WHERE appointment_id = $1`, [aLong.id]);
    assert(blocks.length === 1 && blocks[0].provider_id === biz, "the extra days are blocked", blocks);
    const qDay2 = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, jobDate: daysFromNow(21), start: "10:00", minutes: 60 });
    r = await call("POST", `/api/quotes/${qDay2}/pay`, { token: cust.token, body: { version: 1 } });
    assert(r.status === 409 && r.body?.code === "SLOT_TAKEN", "another quote on day two is refused", r);
    const fullCard = await q(`SELECT content FROM messages WHERE conversation_id = $1 AND card->>'event' = 'paid' AND card->>'quoteId' = $2`, [conv2, qLong]);
    assert(fullCard[0]?.content === "Paid in full for 2 Bedroom Move, $2,500.00.", "full price paid card", fullCard);

    console.log("\n── cancelling a full price quote: the vendor's own policy, as for services ──");
    // Business policy: no full refund, 50% back until 24 hours before, then a $50 cancellation fee on top.
    r = await call("GET", `/api/bookings/appointments/${aLong.id}/cancel-preview`, { token: cust2.token });
    assert(r.body?.refundTier === "partial" && r.body.refundAmountCents === 125000 && r.body.feeAmountCents === 5000 && r.body.feeWouldBeCharged === true,
      "preview: the vendor's partial refund and cancellation fee", r.body);
    r = await call("POST", `/api/bookings/appointments/${aLong.id}/cancel`, { token: cust2.token });
    assert(r.status === 200 && r.body?.refundAmountCents === 125000 && r.body.feeCharged === true, "cancel refunds half and charges the fee, as for a service", r);
    assert(refunds.some((x) => x.payment_intent === piLong && x.amount === 125000), "refund amount at Stripe", refunds.slice(-1));
    const longFee = piCreates.filter((p) => p.metadata.type === "cancellation_fee" && p.metadata.appointmentId === aLong.id);
    assert(longFee.length === 1 && longFee[0].amount === 5000 && typeof longFee[0].key === "string" && longFee[0].key.startsWith(`cancel_fee_appointment_${aLong.id}_`), "one fee charge, with an idempotency key (R39)", longFee);
    const [feeRow] = await q(`SELECT * FROM cancellation_fee_charges WHERE reference_id = $1`, [aLong.id]);
    assert(feeRow?.status === "charged" && feeRow.attempts === 1, "fee recorded", feeRow);
    const feeShare = transfers.find((t) => t.transfer_group === `appointment_${aLong.id}` && t.metadata?.recipient === "business_cancel_fee");
    assert(feeShare && feeShare.amount === 4900 && feeShare.source_transaction?.startsWith("ch_"), "the vendor gets the fee minus Outsyde's 2%, from the fee's own charge", feeShare);
    const [aLongC] = await q(`SELECT status, cancellation_fee_kept_cents FROM appointments WHERE id = $1`, [aLong.id]);
    assert(aLongC.status === "canceled" && aLongC.cancellation_fee_kept_cents === null, "not counted as Outsyde's kept fee", aLongC);
    assert((await q(`SELECT count(*)::int AS n FROM provider_blocks WHERE appointment_id = $1`, [aLong.id]))[0].n === 0, "extra day blocks removed", null);
    r = await call("POST", `/api/bookings/appointments/${aLong.id}/cancel`, { token: cust2.token });
    assert(r.status === 400 && piCreates.filter((p) => p.metadata.type === "cancellation_fee" && p.metadata.appointmentId === aLong.id).length === 1, "a second cancel charges nothing", r);

    console.log("\n── cancelling a deposit quote: same as a deposit booking ──");
    r = await call("GET", `/api/bookings/appointments/${a1.id}/cancel-preview`, { token: cust.token });
    assert(r.body?.refundTier === "none" && r.body.refundAmountCents === 0 && r.body.feeAmountCents === 0 && r.body.feeWouldBeCharged === false && r.body.depositNonRefundable === true,
      "preview: deposit non-refundable, no fee on top", r.body);
    const feesBefore = piCreates.filter((p) => p.metadata.type === "cancellation_fee").length;
    r = await call("POST", `/api/bookings/appointments/${a1.id}/cancel`, { token: cust.token });
    assert(r.status === 200 && r.body?.feeCharged === false && r.body.refundAmountCents === 0, "cancel keeps the deposit, nothing else charged", r);
    assert(piCreates.filter((p) => p.metadata.type === "cancellation_fee").length === feesBefore, "no fee charge", null);

    console.log("\n── R39: the fee is charged once even when a reply is lost ──");
    const refX = { type: "appointment" as const, id: id("feeX") };
    failNextCreateNetwork = true;
    const f1 = await chargeCancellationFeeOnce({ ref: refX, customerId: "cus_x", paymentMethodId: "pm_x", amountCents: 2500, metadata: {}, description: "x" });
    assert(f1.outcome === "unknown", "the lost reply is not treated as declined", f1);
    await q(`UPDATE cancellation_fee_charges SET updated_at = now() - interval '20 minutes' WHERE reference_id = $1`, [refX.id]);
    const f2 = await chargeCancellationFeeOnce({ ref: refX, customerId: "cus_x", paymentMethodId: "pm_x", amountCents: 2500, metadata: {}, description: "x" });
    const xCreates = piCreates.filter((p) => p.metadata.appointmentId === refX.id);
    assert(f2.outcome === "charged" && (f2 as any).alreadyCharged === true && xCreates.length === 1, "the retry finds the earlier charge at Stripe and charges nothing", { f2, n: xCreates.length });
    const f3 = await chargeCancellationFeeOnce({ ref: refX, customerId: "cus_x", paymentMethodId: "pm_x", amountCents: 2500, metadata: {}, description: "x" });
    assert(f3.outcome === "charged" && piCreates.filter((p) => p.metadata.appointmentId === refX.id).length === 1, "a third call reads the record", f3);
    const refY = { type: "shoot_booking" as const, id: id("feeY") };
    failNextCreateNetwork = true;
    await chargeCancellationFeeOnce({ ref: refY, customerId: "cus_y", paymentMethodId: "pm_y", amountCents: 1500, metadata: {}, description: "y" });
    await q(`UPDATE cancellation_fee_charges SET updated_at = now() - interval '20 minutes' WHERE reference_id = $1`, [refY.id]);
    await resolveStaleFeeCharges();
    const [yRow] = await q(`SELECT status FROM cancellation_fee_charges WHERE reference_id = $1`, [refY.id]);
    assert(yRow.status === "charged", "the later check records a fee that did land", yRow);

    console.log("\n── backstop for a missed Stripe confirmation (call 10) ──");
    const qMiss = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, jobDate: daysFromNow(12), start: "09:00", minutes: 60 });
    r = await call("POST", `/api/quotes/${qMiss}/pay`, { token: cust.token, body: { version: 1 } });
    const piMiss = r.body?.paymentIntentId;
    succeed(piMiss); // paid at Stripe, webhook never arrives
    await q(`UPDATE appointments SET created_at = now() - interval '5 minutes' WHERE quote_id = $1`, [qMiss]);
    const n = await confirmMissedQuotePayments();
    const [aMiss] = await apptOf(qMiss);
    assert(n >= 1 && aMiss.status === "confirmed" && (await quoteRow(qMiss)).status === "paid", "the backstop confirms it", { n, s: aMiss.status });

    console.log("\n── bookings without a quote are unchanged ──");
    const plain = id("plain");
    await q(`INSERT INTO appointments (id, business_id, client_id, service_id, appointment_date, appointment_time, appointment_end_time, duration_minutes, total_price, deposit_amount_cents, status, payment_method, capture_method, stripe_payment_intent_id)
             VALUES ($1, $2, $3, $4, $5, '07:00', '07:30', 30, 30000, 5000, 'confirmed', 'payment_intent', 'automatic', 'pi_plain_none')`, [plain, biz, cust.uid, svc, daysFromNow(15)]);
    r = await call("GET", `/api/bookings/appointments/${plain}/cancel-preview`, { token: cust.token });
    assert(r.body?.refundTier === "none" && r.body.feeAmountCents === 0 && r.body.feeWouldBeCharged === false, "a normal deposit booking: deposit kept and no fee, as before", r.body);

    await sleep(300);
  } finally {
    const ids = [...users];
    await q(`DELETE FROM cancellation_fee_charges WHERE reference_id LIKE $1 OR reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($2))`, [`${P}%`, bizs]).catch(() => undefined);
    await q(`DELETE FROM provider_blocks WHERE provider_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`UPDATE quotes SET appointment_id = NULL, message_id = NULL WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    for (const t of ["booking_refund_recoveries", "booking_payout_issues", "pending_points_transactions", "booking_audit_log", "notifications"]) {
      await q(`DELETE FROM ${t} WHERE ${t === "notifications" ? "user_id = ANY($2)" : t === "booking_audit_log" ? "booking_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))" : "reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))"}`, t === "notifications" ? [bizs, ids] : [bizs]).catch(() => undefined);
    }
    await q(`DELETE FROM appointments WHERE business_id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup appointments", e.message));
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM quotes WHERE business_id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup quotes", e.message));
    await q(`DELETE FROM messages WHERE sender_id = ANY($1)`, [ids]).catch(() => undefined);
    await q(`DELETE FROM estimate_requests WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM conversations WHERE participant1_id = ANY($1) OR participant2_id = ANY($1)`, [ids]).catch(() => undefined);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup businesses", e.message));
    if (tierMade) await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tier.id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]).catch((e) => console.error("cleanup users", e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
