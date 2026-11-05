/**
 * Quotes step 4b-2a (migration 101, B15): the rest of a deposit quote paid outside Outsyde (to the business directly).
 * Legend 2026-11-05: the vendor picks it per quote, default through Outsyde (E5). Outside: no hold, no service fee and
 * no points on the rest, no Report protection on it; the "pay in person" amount shows again like a deposit booking.
 *
 * Run with: npx tsx server/quotes/quoteRestOutside.http.test.ts (same scratch setup as quoteBalance.http.test.ts).
 */
import http from "http";

const BASE = process.env.QB_TEST_BASE_URL;
const PG_URL = process.env.QB_TEST_PG_URL;
const STUB_PORT = Number(process.env.QB_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": `10.97.1.${Math.floor(Math.random() * 200) + 1}`, ...(o.headers ?? {}) };
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

const H = 3600_000;
const ymdNY = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hmNY = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

(async () => {
  if (!BASE) { console.log("⏭  skipped: set QB_TEST_BASE_URL (+ QB_TEST_PG_URL, QB_TEST_STRIPE_PORT) to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and QB_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "qb-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // ── Stripe stub (adds manual capture, off session confirm, capture with amount_to_capture, declines) ──
  const piStore: Record<string, any> = {};
  const piCreates: { key: string | undefined; amount: number; metadata: Record<string, string>; form: Record<string, string> }[] = [];
  const captures: { id: string; amount_to_capture: number | null; key: string | undefined }[] = [];
  const cancels: string[] = [];
  const refunds: any[] = [];
  const transfers: any[] = [];
  const transferTries: { key: string | undefined; form: Record<string, string> }[] = [];
  let failNextTransfers = 0;
  let loseNextTransferReply = false;
  let declineNextOffSession = 0;
  let loseNextBalanceReply = false;
  let loseNextCaptureReply = false;
  const failRefundFor = new Map<string, number>();
  const lostKeys = new Set<string>();
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const flat: Record<string, string> = {}; for (const [k, v] of form.entries()) flat[k] = v;
      const meta = () => { const m: Record<string, string> = {}; for (const [k, v] of form.entries()) { const x = k.match(/^metadata\[(.+)\]$/); if (x) m[x[1]] = v; } return m; };
      const url = new URL(req.url || "/", "http://stub");
      if (req.method === "POST" && url.pathname === "/v1/customers") return send(200, { id: `cus_qb_${Date.now()}`, object: "customer" });
      const custM = url.pathname.match(/^\/v1\/customers\/([^/]+)$/);
      if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
      if (req.method === "POST" && url.pathname === "/v1/customer_sessions") return send(200, { client_secret: "cuss_stub" });
      if (req.method === "POST" && url.pathname === "/v1/ephemeral_keys") return send(200, { secret: "ek_stub" });
      if (req.method === "POST" && url.pathname === "/v1/payment_intents") {
        const key = req.headers["idempotency-key"] as string | undefined;
        if (key && lostKeys.has(key)) { req.socket.destroy(); return; }
        const prior = Object.values(piStore).find((p: any) => p._key && p._key === key);
        if (prior) return send(200, prior);
        const metadata = meta();
        const id = `pi_qb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const offSession = flat.off_session === "true" && flat.confirm === "true";
        const amount = Number(flat.amount || 0);
        const manual = flat.capture_method === "manual";
        let status = "requires_payment_method";
        if (offSession) status = manual ? "requires_capture" : "succeeded";
        const pi: any = { id, object: "payment_intent", amount, amount_received: status === "succeeded" ? amount : 0, amount_capturable: status === "requires_capture" ? amount : 0,
          status, client_secret: `${id}_secret`, capture_method: flat.capture_method || "automatic", metadata, customer: flat.customer,
          payment_method: flat.payment_method || "pm_qb_card", latest_charge: status === "succeeded" ? `ch_${id}` : null,
          setup_future_usage: flat.setup_future_usage, off_session: flat.off_session, created: Math.floor(Date.now() / 1000), _key: key };
        piCreates.push({ key, amount, metadata, form: flat });
        if (offSession && declineNextOffSession > 0) {
          declineNextOffSession--;
          return send(402, { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds.", payment_intent: { ...pi, status: "requires_payment_method" } } });
        }
        if (offSession && metadata.type === "quote_balance" && loseNextBalanceReply) {
          loseNextBalanceReply = false;
          if (key) lostKeys.add(key);
          piStore[id] = pi; // landed at Stripe, the reply is lost
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
      const piCap = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)\/capture$/);
      if (req.method === "POST" && piCap) {
        const pi = piStore[piCap[1]];
        if (!pi) return send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
        if (pi.status !== "requires_capture") return send(400, { error: { type: "invalid_request_error", code: "payment_intent_unexpected_state", message: `This PaymentIntent could not be captured because it has a status of ${pi.status}.` } });
        const amt = flat.amount_to_capture ? Number(flat.amount_to_capture) : pi.amount;
        captures.push({ id: pi.id, amount_to_capture: flat.amount_to_capture ? Number(flat.amount_to_capture) : null, key: req.headers["idempotency-key"] as string | undefined });
        pi.status = "succeeded"; pi.amount_received = amt; pi.amount_capturable = 0; pi.latest_charge = `ch_${pi.id}`;
        if (loseNextCaptureReply) { loseNextCaptureReply = false; req.socket.destroy(); return; } // captured, reply lost
        return send(200, pi);
      }
      const piCancel = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (req.method === "POST" && piCancel) {
        const pi = piStore[piCancel[1]];
        if (!pi) return send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
        if (pi.status === "succeeded") return send(400, { error: { type: "invalid_request_error", message: "cannot cancel a succeeded PaymentIntent" } });
        pi.status = "canceled"; pi.amount_capturable = 0; cancels.push(pi.id);
        return send(200, pi);
      }
      if (req.method === "POST" && url.pathname === "/v1/refunds") {
        const fk = flat.payment_intent || "";
        if ((failRefundFor.get(fk) ?? 0) > 0) { failRefundFor.set(fk, failRefundFor.get(fk)! - 1); req.socket.destroy(); return; } // every try of this call fails
        const pi = piStore[flat.payment_intent || ""];
        const amount = Number(flat.amount || (pi ? pi.amount_received - (pi._refunded || 0) : 0));
        if (pi) pi._refunded = (pi._refunded || 0) + amount;
        const r = { id: `re_qb_${refunds.length + 1}`, object: "refund", amount, payment_intent: flat.payment_intent, status: "succeeded", metadata: meta(), created: Math.floor(Date.now() / 1000) };
        refunds.push(r);
        return send(200, r);
      }
      if (req.method === "GET" && url.pathname === "/v1/refunds") return send(200, { object: "list", data: refunds.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
      if (req.method === "POST" && url.pathname === "/v1/transfers") {
        transferTries.push({ key: req.headers["idempotency-key"] as string | undefined, form: flat });
        if (failNextTransfers > 0) { failNextTransfers--; return send(500, { error: { type: "api_error", message: "stub: transfer failed" } }); }
        const tkey = req.headers["idempotency-key"] as string | undefined;
        const tprior = transfers.find((x) => x._key && x._key === tkey);
        if (tprior) return send(200, tprior);
        const t = { id: `tr_qb_${transfers.length + 1}`, object: "transfer", amount: Number(flat.amount), destination: flat.destination, transfer_group: flat.transfer_group, metadata: meta(), amount_reversed: 0, reversals: { data: [] }, source_transaction: flat.source_transaction, _key: tkey };
        transfers.push(t);
        if (loseNextTransferReply) { loseNextTransferReply = false; req.socket.destroy(); return; }
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
  const balancePis = () => piCreates.filter((c) => c.metadata.type === "quote_balance");

  const { WebhookHandlers } = await import("../stripe/webhookHandlers");
  const qb = await import("./quoteBalance");
  const { resolveBooking } = await import("../bookingRecoveries");
  const { findSaleForTest } = await import("../stripe/stripeSync");
  const { computeHeld } = await import("../bankPayout");

  const P = `qo${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = "Ana", admin = false) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, stripe_customer_id, is_admin) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4, $5)`, [uid, `${uid}@qo.test`, first, `cus_${uid}`, admin]);
    users.push(uid);
    return { uid, token: generateAccessToken({ userId: uid, isVendor: false, isAdmin: admin }) };
  };
  let [tier] = await q(`SELECT id FROM subscription_tiers WHERE is_active = true LIMIT 1`);
  let tierMade = false;
  if (!tier) { [tier] = await q(`INSERT INTO subscription_tiers (id, name, display_name, price_monthly, is_active) VALUES ($1, 'qb', 'QB', 1000, true) RETURNING id`, [id("tier")]); tierMade = true; }
  const mkBiz = async (key: string, ownerId: string) => {
    const bid = id(`b-${key}`);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, time_zone, stripe_account_id, stripe_onboarding_complete, vendor_agreement_accepted, auto_accept_bookings, full_refund_window, has_partial_refund)
             VALUES ($1, $2, $3, 'home', 'approved', 'America/New_York', $4, true, true, true, 'never', false)`, [bid, ownerId, `Movers ${key}`, `acct_${key}_${P}`]);
    await q(`INSERT INTO vendor_subscriptions (id, vendor_id, business_id, tier_id, status, current_period_end) VALUES ($1, $2, $3, $4, 'active', now() + interval '30 days')`, [id(`sub-${key}`), ownerId, bid, tier.id]);
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
  /** A quote whose job starts `hoursOut` hours from now (New York wall clock), 3 hours long by default. */
  const mkQuote = async (o: { biz: string; sender: string; customer: string; conv: string; hoursOut: number; minutes?: number; total?: number; deposit?: number | null; staffId?: string | null; restPaid?: string }) => {
    const qid = id(`q${++qn}`);
    const deposit = o.deposit === undefined ? 10000 : o.deposit;
    // Whole minutes, so the wall clock and starts_at agree.
    const startsAt = new Date(Math.floor((Date.now() + o.hoursOut * H) / 60_000) * 60_000 + qn * 11 * 60_000);
    await q(`INSERT INTO quotes (id, business_id, staff_member_id, sender_id, customer_id, conversation_id, title, job_date, start_time, duration_minutes, time_zone, starts_at,
               total_cents, payment_mode, deposit_cents, expires_at, link_code, rest_paid)
             VALUES ($1, $2, $3, $4, $5, $6, '2 Bedroom Move', $7, $8, $9, 'America/New_York', $10, $11, $12, $13, LEAST($10::timestamptz, now() + interval '6 days'), $14, $15)`,
      [qid, o.biz, o.staffId ?? null, o.sender, o.customer, o.conv, ymdNY(startsAt), hmNY(startsAt), o.minutes ?? 10, startsAt.toISOString(),
        o.total ?? 65000, deposit === null ? "full" : "deposit", deposit, `lc${qid}`, o.restPaid ?? "outsyde"]);
    return { qid, startsAt };
  };
  const apptOf = async (qid: string) => (await q(`SELECT * FROM appointments WHERE quote_id = $1 ORDER BY created_at DESC`, [qid]))[0];
  const jobOf = async (apptId: string) => (await q(`SELECT * FROM quote_jobs WHERE appointment_id = $1`, [apptId]))[0];
  /** Pays a quote's deposit (or full price) and lets Stripe confirm it. */
  const payQuote = async (qid: string, token: string) => {
    const r = await call("POST", `/api/quotes/${qid}/pay`, { token, body: { version: 1 } });
    if (r.status !== 200) throw new Error(`pay failed ${JSON.stringify(r)}`);
    await WebhookHandlers.handlePaymentIntentSucceeded(succeed(r.body.paymentIntentId));
    await qb.flushQuoteBalanceWorkForTest();
    return apptOf(qid);
  };
  /** Moves a job's times back so the hold, retry or auto complete is due now. */
  const shiftJob = async (apptId: string, hours: number) => {
    await q(`UPDATE quote_jobs SET starts_at = starts_at - make_interval(hours => $2), auto_complete_at = auto_complete_at - make_interval(hours => $2),
               hold_at = hold_at - make_interval(hours => $2), retry_at = retry_at - make_interval(hours => $2) WHERE appointment_id = $1`, [apptId, hours]);
  };
  const cardsOf = async (conv: string, event: string) => q(`SELECT * FROM messages WHERE conversation_id = $1 AND kind = 'quote' AND card->>'event' = $2 ORDER BY created_at`, [conv, event]);

  const owner = await mkUser("owner", "Benny");
  const staffUser = await mkUser("staff", "Sam");
  const stranger = await mkUser("stranger", "Zed");
  // The admin routes check the allow listed email too: use (or make) that account on the scratch database.
  let [adminRow] = await q(`SELECT id FROM users WHERE lower(email) = 'info@goutsyde.com'`);
  if (!adminRow) {
    [adminRow] = await q(`INSERT INTO users (id, username, email, first_name, last_name, name, is_admin) VALUES ($1::varchar, $1::text, 'info@goutsyde.com', 'Ada', 'Admin', 'Ada', true) RETURNING id`, [id("admin")]);
    users.push(adminRow.id);
  } else await q(`UPDATE users SET is_admin = true WHERE id = $1`, [adminRow.id]);
  const admin = { uid: adminRow.id as string, token: generateAccessToken({ userId: adminRow.id, isVendor: false, isAdmin: true }) };
  const cust = await mkUser("cust");
  const biz = await mkBiz("a", owner.uid);
  const staffId = id("staff1");
  await q(`INSERT INTO staff_members (id, business_id, user_id, display_name, status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, $3, 'Sam', 'active', $4, true)`, [staffId, biz, staffUser.uid, `acct_staff_${P}`]);
  const conv = await mkConv(owner.uid, cust.uid, "a");
  const convStaff = await mkConv(staffUser.uid, cust.uid, "s");

  const qw = await import("./quoteWindow");
  qw.setQuoteAdminAlertForTest(async () => {});
  const futureDay = ymdNY(new Date(Date.now() + 10 * 24 * H));
  const body = (extra: Record<string, unknown> = {}) => ({ conversationId: conv, title: "3 Bedroom Move", jobDate: futureDay, startTime: "09:00", durationMinutes: 240, totalCents: 65000, paymentMode: "deposit", depositCents: 10000, ...extra });

  try {
    console.log("\n── sending a quote with the rest paid outside ──");
    let r = await call("POST", "/api/quotes", { token: owner.token, body: body({ restPaid: "outside" }) });
    const qo = r.body?.quote;
    assert((r.status === 200 || r.status === 201) && qo?.restPaid === "outside" && qo.amounts.paidDirectlyCents === 55000 && qo.amounts.balanceTotalCents === 0 && qo.amounts.balanceServiceFeeCents === 0 && qo.amounts.payNowCents === 10800, "the quote says the rest is paid directly, nothing held, no fee on it", r.body);
    const card = (await q(`SELECT * FROM messages WHERE id = $1`, [qo?.messageId]))[0];
    assert(card?.card?.restPaid === "outside" && card.card.paidDirectlyCents === 55000, "the card carries it too", card?.card);
    r = await call("POST", "/api/quotes", { token: owner.token, body: body() });
    assert((r.status === 200 || r.status === 201) && r.body?.quote?.restPaid === "outsyde" && r.body.quote.amounts.balanceTotalCents === 59400, "left out: through Outsyde, as before (E5)", r.body?.quote);
    r = await call("POST", "/api/quotes", { token: owner.token, body: body({ paymentMode: "full", depositCents: null, restPaid: "outside" }) });
    assert(r.status === 400 && r.body?.field === "restPaid", "a full payment quote has nothing left to pay outside", r.body);
    r = await call("PATCH", `/api/quotes/${qo.id}`, { token: owner.token, body: { ...body(), version: qo.version, totalCents: 70000 } });
    assert(r.status === 200 && r.body?.quote?.restPaid === "outside" && r.body.quote.amounts.paidDirectlyCents === 60000, "an edit that leaves it out keeps it", r.body?.quote);
    r = await call("PATCH", `/api/quotes/${qo.id}`, { token: owner.token, body: { ...body({ restPaid: "outsyde" }), version: r.body.quote.version } });
    assert(r.status === 200 && r.body?.quote?.restPaid === "outsyde", "and the vendor can switch it back", r.body?.quote);

    console.log("\n── paying it: the deposit as today, nothing held ──");
    const O = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72, minutes: 180, restPaid: "outside" });
    const aO = await payQuote(O.qid, cust.token);
    let jO = await jobOf(aO.id);
    assert(aO.status === "confirmed" && jO?.balance_status === "none" && jO.balance_cents === 0 && jO.hold_cents === 0 && jO.payout_status === "none", "no balance to hold or pay out", jO);
    await shiftJob(aO.id, 60);
    await qb.runQuoteBalanceJob(new Date());
    assert(balancePis().length === 0, "the 24 hour job never holds anything");
    r = await call("GET", `/api/business/appointments`, { token: owner.token });
    const rowO = (r.body?.appointments ?? r.body ?? []).find?.((x: any) => x.id === aO.id);
    assert(rowO && rowO.inPersonDueCents === 55000 && rowO.dueAtAppointmentCents === 55000, "the vendor sees $550 to collect in person, like a deposit booking", rowO && { i: rowO.inPersonDueCents, d: rowO.dueAtAppointmentCents });
    r = await call("GET", `/api/my-appointments`, { token: cust.token });
    const mine = (r.body?.appointments ?? r.body ?? []).find?.((x: any) => x.id === aO.id);
    assert(mine && mine.inPersonDueCents === 55000, "the customer sees it too", mine && mine.inPersonDueCents);
    const T = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 120, minutes: 180 });
    const aT = await payQuote(T.qid, cust.token);
    r = await call("GET", `/api/business/appointments`, { token: owner.token });
    const rowT = (r.body?.appointments ?? r.body ?? []).find?.((x: any) => x.id === aT.id);
    assert(rowT && rowT.inPersonDueCents === 0, "a quote through Outsyde still shows nothing in person (4a)", rowT && rowT.inPersonDueCents);
    await q(`UPDATE appointments SET appointment_date = $2 WHERE id = ANY($1)`, [[aO.id, aT.id], ymdNY(new Date())]);
    r = await call("GET", `/api/business/stats`, { token: owner.token });
    assert(r.status === 200 && r.body?.stats?.inPersonDueCents === 55000, "business stats count only the outside rest as due in person", r.body?.stats);

    console.log("\n── Job complete: nothing charged, the window still opens ──");
    await shiftJob(aO.id, 30);
    r = await call("POST", `/api/quotes/${O.qid}/job-complete`, { token: owner.token });
    jO = await jobOf(aO.id);
    assert(r.status === 200 && r.body?.balanceChargedCents === 0 && captures.length === 0, "complete with nothing to charge", r);
    assert(!!jO.window_ends_at && jO.payout_status === "none", "the 6 hour window opens; no balance payout", jO);
    const jc = await cardsOf(conv, "job_complete");
    const last = jc[jc.length - 1];
    assert(!!last && !/charged/i.test(last.content) && /report a problem within 6 hours/i.test(last.content), "the card never says charged", last?.content);
    r = await call("POST", `/api/quotes/${O.qid}/report`, { token: cust.token, body: { reason: "The crew never showed up" } });
    const repO = (await q(`SELECT * FROM quote_reports WHERE appointment_id = $1`, [aO.id]))[0];
    assert(r.status === 200 && repO?.held_cents === 10000, "a report covers only what went through Outsyde (the deposit)", repO);
    assert(!transfers.some((t) => t.transfer_group === `appointment_balance_${aO.id}`), "no balance transfer ever");
  } finally {
    const ids = users;
    await q(`DELETE FROM quote_jobs WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM refund_requests WHERE requester_id = ANY($1)`, [ids]).catch(() => undefined);
    await q(`DELETE FROM pending_points_transactions WHERE reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM booking_payout_issues WHERE reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM quote_reports WHERE customer_id = ANY($1)`, [users]).catch(() => undefined);
    await q(`DELETE FROM booking_refund_recoveries WHERE payment_intent_id LIKE 'pi_qb_%'`).catch(() => undefined);
    await q(`UPDATE quotes SET appointment_id = NULL WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM provider_blocks WHERE provider_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM appointment_state_logs WHERE appointment_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM appointments WHERE business_id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup appointments", e.message));
    await q(`DELETE FROM booking_holds WHERE provider_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id LIKE $1)`, [`${P}%`]).catch(() => undefined);
    await q(`DELETE FROM quotes WHERE business_id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup quotes", e.message));
    await q(`DELETE FROM conversations WHERE id LIKE $1`, [`${P}%`]).catch(() => undefined);
    await q(`DELETE FROM staff_members WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]).catch(() => undefined);
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizs]).catch((e) => console.error("cleanup businesses", e.message));
    if (tierMade) await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tier.id]).catch(() => undefined);
    await q(`DELETE FROM pending_points_transactions WHERE user_id = ANY($1)`, [ids]).catch(() => undefined);
    await q(`DELETE FROM cancellation_fee_charges WHERE customer_id = ANY($1)`, [ids.map((u) => `cus_${u}`)]).catch(() => undefined);
    for (const t of ["point_transactions", "loyalty_balances", "notification_preferences", "push_tokens", "admin_audit_logs"]) {
      await q(`DELETE FROM ${t} WHERE ${t === "admin_audit_logs" ? "admin_id" : "user_id"} = ANY($1)`, [ids]).catch(() => undefined);
    }
    await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]).catch((e) => console.error("cleanup users", e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
