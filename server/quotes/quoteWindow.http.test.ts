/**
 * Quotes step 4b-1 (migration 100): the 6 hour Confirm or Report window, review outcomes on the admin Refunds page,
 * the vendor's balance payout (own transfer group, key per try, retries, disputes), and points that follow the money.
 *
 * Legend 2026-11-05 (B5 to B14): Confirm pays the vendor at once; Report pauses the payout for Outsyde's review; no
 * answer pays when the 6 hours end. Outcomes pay in full, partial refund, full refund (every dollar, fees included),
 * balance first then deposit. Decided reports are final. Deposit points wait for Confirm too; points follow the money.
 *
 * Run with: npx tsx server/quotes/quoteWindow.http.test.ts (same scratch setup as quoteBalance.http.test.ts:
 * QB_TEST_BASE_URL, QB_TEST_PG_URL, QB_TEST_STRIPE_PORT, DATABASE_URL, NODE_OPTIONS with both preloads).
 * Skips (exit 0) when QB_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe.
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
  let loseNextTransferReply = 0;
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
        if (tprior && loseNextTransferReply > 0) { loseNextTransferReply--; req.socket.destroy(); return; }
        if (tprior) return send(200, tprior);
        const t = { id: `tr_qb_${transfers.length + 1}`, object: "transfer", amount: Number(flat.amount), destination: flat.destination, transfer_group: flat.transfer_group, metadata: meta(), amount_reversed: 0, reversals: { data: [] }, source_transaction: flat.source_transaction, _key: tkey };
        transfers.push(t);
        if (loseNextTransferReply > 0) { loseNextTransferReply--; req.socket.destroy(); return; }
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

  const P = `qw${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = "Ana", admin = false) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, stripe_customer_id, is_admin) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4, $5)`, [uid, `${uid}@qw.test`, first, `cus_${uid}`, admin]);
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
  const mkQuote = async (o: { biz: string; sender: string; customer: string; conv: string; hoursOut: number; minutes?: number; total?: number; deposit?: number | null; staffId?: string | null }) => {
    const qid = id(`q${++qn}`);
    const deposit = o.deposit === undefined ? 10000 : o.deposit;
    // Whole minutes, so the wall clock and starts_at agree.
    const startsAt = new Date(Math.floor((Date.now() + o.hoursOut * H) / 60_000) * 60_000 + qn * 11 * 60_000);
    await q(`INSERT INTO quotes (id, business_id, staff_member_id, sender_id, customer_id, conversation_id, title, job_date, start_time, duration_minutes, time_zone, starts_at,
               total_cents, payment_mode, deposit_cents, expires_at, link_code)
             VALUES ($1, $2, $3, $4, $5, $6, '2 Bedroom Move', $7, $8, $9, 'America/New_York', $10, $11, $12, $13, LEAST($10::timestamptz, now() + interval '6 days'), $14)`,
      [qid, o.biz, o.staffId ?? null, o.sender, o.customer, o.conv, ymdNY(startsAt), hmNY(startsAt), o.minutes ?? 10, startsAt.toISOString(),
        o.total ?? 65000, deposit === null ? "full" : "deposit", deposit, `lc${qid}`]);
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
  const alerts: { subject: string; text: string }[] = [];
  qw.setQuoteAdminAlertForTest(async (subject: string, text: string) => { alerts.push({ subject, text }); });
  const R2 = process.env.R2_PUBLIC_URL || "http://127.0.0.1:4591/bucket";
  const { pointsForGrossCents } = await import("../loyaltyLedger");

  /** Pays a deposit quote, holds the balance and marks the job complete (owner). Returns the booking and its job. */
  const completed = async (o: { staffId?: string | null; sender?: string; conv?: string; deposit?: number | null } = {}) => {
    const Q = await mkQuote({ biz, sender: o.sender ?? owner.uid, customer: cust.uid, conv: o.conv ?? conv, hoursOut: 72, minutes: 180, staffId: o.staffId ?? null, deposit: o.deposit });
    const a = await payQuote(Q.qid, cust.token);
    await shiftJob(a.id, 49 + Math.ceil((qn * 11) / 60));
    await qb.runQuoteBalanceJob(new Date());
    await shiftJob(a.id, 24);
    await q(`UPDATE appointments SET appointment_date = $2 WHERE id = $1`, [a.id, ymdNY(new Date(Date.now() - 2 * H))]);
    const r = await call("POST", `/api/quotes/${Q.qid}/job-complete`, { token: owner.token });
    if (r.status !== 200) throw new Error(`job complete failed ${JSON.stringify(r)}`);
    return { qid: Q.qid, a: await apptOf(Q.qid), job: await jobOf(a.id) };
  };
  /** Moves Job complete (and its window) back by `hours`. */
  const shiftWindow = async (apptId: string, hours: number) => {
    await q(`UPDATE quote_jobs SET completed_at = completed_at - make_interval(hours => $2), window_ends_at = window_ends_at - make_interval(hours => $2) WHERE appointment_id = $1`, [apptId, hours]);
  };
  const balanceTransfers = (apptId: string) => transfers.filter((t) => t.transfer_group === `appointment_balance_${apptId}`);
  const pending = async (type: string, ref: string) => (await q(`SELECT * FROM pending_points_transactions WHERE reference_type = $1 AND reference_id = $2`, [type, ref]))[0];
  const earned = async (type: string, ref: string) => Number((await q(`SELECT COALESCE(SUM(points), 0)::int AS p FROM point_transactions WHERE type = 'earn' AND reference_type = $1 AND reference_id = $2`, [type, ref]))[0].p);
  const reversed = async (ref: string) => Number((await q(`SELECT COALESCE(SUM(-points), 0)::int AS p FROM point_transactions WHERE type = 'reversal' AND reference_type = 'refund_reversal' AND reference_id = $1`, [ref]))[0].p);
  const DEP_GROSS = 10800, BAL_GROSS = 59400;

  try {
    console.log("\n── Job complete opens the 6 hour window (deposit points wait, balance points pending) ──");
    const A = await completed();
    let j = A.job;
    assert(!!j.window_ends_at && Math.abs(new Date(j.window_ends_at).getTime() - (new Date(j.completed_at).getTime() + 6 * H)) < 1000, "the window ends 6 hours after Job complete", j);
    assert(j.payout_status === "held" && balanceTransfers(A.a.id).length === 0, "the vendor's balance share is held", j.payout_status);
    let pd = await pending("appointment", A.a.id);
    assert(pd?.status === "pending" && pd.release_after === null, "deposit points still pending, no automatic release date (B8)", pd);
    let pb = await pending("quote_balance", j.id);
    assert(pb?.status === "pending" && pb.points_earned === pointsForGrossCents(BAL_GROSS) && pb.release_after === null && pb.user_id === cust.uid, "balance points pending on the balance paid, keyed by the job", pb);
    assert((await cardsOf(conv, "job_complete")).length === 1, "the customer gets a Job complete card");
    const jc = (await cardsOf(conv, "job_complete"))[0];
    assert(jc?.recipient_id === cust.uid || jc?.sender_id === owner.uid, "sent to the customer", jc && { s: jc.sender_id, r: jc.recipient_id });
    assert(/report a problem within 6 hours/i.test(jc?.content ?? "") && !/[–—]/.test(jc?.content ?? "") && !/8%/.test(jc?.content ?? ""), "plain text, no dashes, no fee rate", jc?.content);
    let r = await call("GET", `/api/quotes/${A.qid}`, { token: cust.token });
    const w = r.body?.quote?.window;
    assert(w?.state === "open" && w.canConfirm === true && w.canReport === true && !!w.endsAt, "the quote shows the window to the customer", w);
    r = await call("GET", `/api/quotes/${A.qid}`, { token: owner.token });
    assert(r.body?.quote?.window?.canConfirm === false && r.body?.quote?.payout?.status === "held", "the vendor sees the window but can't confirm, and sees the payout", { w: r.body?.quote?.window, p: r.body?.quote?.payout });

    console.log("\n── Confirm pays the vendor at once ──");
    r = await call("POST", `/api/quotes/${A.qid}/confirm`, { token: stranger.token });
    assert(r.status === 404, "a stranger can't", r.status);
    r = await call("POST", `/api/quotes/${A.qid}/confirm`, { token: owner.token });
    assert(r.status === 404, "the vendor can't confirm for the customer", r.status);
    r = await call("POST", `/api/quotes/${A.qid}/confirm`, { token: cust.token });
    j = await jobOf(A.a.id);
    let bt = balanceTransfers(A.a.id);
    assert(r.status === 200 && !!j.confirmed_at, "the customer confirms", r);
    assert(bt.length === 1 && bt[0].amount === 53900 && bt[0].destination === `acct_a_${P}` && bt[0].metadata.recipient === "business_balance", "one transfer, balance less 2%, own group and recipient", bt);
    assert(j.payout_status === "paid" && j.payout_transfer_id === bt[0]?.id && j.payout_cents === 53900 && j.payout_recipient === "business", "payout recorded", j);
    assert(transferTries.some((t) => t.key?.startsWith(`quote_balance_payout_${A.a.id}`)), "keyed per try", transferTries.map((t) => t.key));
    assert(await earned("appointment", A.a.id) === pointsForGrossCents(DEP_GROSS) && await earned("quote_balance", j.id) === pointsForGrossCents(BAL_GROSS), "deposit and balance points released", { d: await earned("appointment", A.a.id), b: await earned("quote_balance", j.id) });
    assert((await cardsOf(conv, "job_confirmed")).length === 1, "the vendor gets a confirmed card");
    r = await call("POST", `/api/quotes/${A.qid}/confirm`, { token: cust.token });
    assert(r.status === 409 && r.body?.code === "ALREADY_CONFIRMED" && balanceTransfers(A.a.id).length === 1, "a second tap does nothing", r);
    r = await call("POST", `/api/quotes/${A.qid}/report`, { token: cust.token, body: { reason: "Actually the crew broke a lamp" } });
    assert(r.status === 409 && r.body?.code === "ALREADY_CONFIRMED", "no report after Confirm", r);
    await qw.runQuoteWindowJob(new Date());
    assert(balanceTransfers(A.a.id).length === 1, "the job never pays twice");

    console.log("\n── a later refund takes points back down to what stays paid ──");
    r = await call("POST", `/api/bookings/appointments/${A.a.id}/refund`, { token: owner.token, body: { amountCents: 27500, reason: "Missed a room" } });
    assert(r.status === 200 && r.body?.balanceRefundedCents === 27500, "the vendor refunds part of the balance", r);
    await qw.runQuoteWindowJob(new Date());
    j = await jobOf(A.a.id);
    const balTarget = pointsForGrossCents(BAL_GROSS - 27500);
    assert(await earned("quote_balance", j.id) - await reversed(j.id) === balTarget, "balance points down to what stays paid", { e: await earned("quote_balance", j.id), r: await reversed(j.id), balTarget });
    assert(await reversed(A.a.id) === 0, "deposit points untouched (the refund came off the balance)", await reversed(A.a.id));
    await qw.runQuoteWindowJob(new Date());
    assert(await earned("quote_balance", j.id) - await reversed(j.id) === balTarget, "a second run takes nothing more");

    console.log("\n── no answer: paid when the 6 hours end ──");
    const B = await completed();
    await qw.runQuoteWindowJob(new Date());
    assert(balanceTransfers(B.a.id).length === 0, "not before the 6 hours end");
    await shiftWindow(B.a.id, 7);
    await Promise.all([qw.runQuoteWindowJob(new Date()), qw.runQuoteWindowJob(new Date())]);
    j = await jobOf(B.a.id);
    assert(balanceTransfers(B.a.id).length === 1 && j.payout_status === "paid", "two runs at once pay once", { t: balanceTransfers(B.a.id).length, s: j.payout_status });
    assert(await earned("quote_balance", j.id) === pointsForGrossCents(BAL_GROSS) && await earned("appointment", B.a.id) === pointsForGrossCents(DEP_GROSS), "points released at the end of the window");
    r = await call("POST", `/api/quotes/${B.qid}/report`, { token: cust.token, body: { reason: "Too late to report this one" } });
    assert(r.status === 409 && r.body?.code === "WINDOW_OVER", "no report after the window", r);

    console.log("\n── payout failures retry, a lost reply never pays twice ──");
    const C = await completed();
    failNextTransfers = 2; // the first try and stripe-node's own retry
    await shiftWindow(C.a.id, 7);
    await qw.runQuoteWindowJob(new Date());
    j = await jobOf(C.a.id);
    assert(j.payout_status === "held" && !!j.payout_error && !!j.payout_next_at && balanceTransfers(C.a.id).length === 0, "a failed transfer waits for a retry", j);
    assert(alerts.some((x) => x.text.includes(C.a.id)), "Outsyde is emailed about the unpaid payout", alerts.map((x) => x.subject));
    await qw.runQuoteWindowJob(new Date());
    assert(balanceTransfers(C.a.id).length === 0, "not before the retry time");
    await q(`UPDATE quote_jobs SET payout_next_at = now() - interval '1 minute' WHERE appointment_id = $1`, [C.a.id]);
    loseNextTransferReply = 2; // the reply to the try and to stripe-node's own retry
    const tries0 = transferTries.filter((t) => t.key?.startsWith(`quote_balance_payout_${C.a.id}`)).length;
    await qw.runQuoteWindowJob(new Date());
    j = await jobOf(C.a.id);
    assert(balanceTransfers(C.a.id).length === 1 && j.payout_status === "held", "the transfer landed but the reply was lost: still held", { t: balanceTransfers(C.a.id).length, s: j.payout_status });
    assert(!!j.payout_claimed_at, "no reply at all: the claim is kept until it runs out (no second try meanwhile)", j.payout_claimed_at);
    await q(`UPDATE quote_jobs SET payout_next_at = now() - interval '1 minute' WHERE appointment_id = $1`, [C.a.id]);
    await qw.runQuoteWindowJob(new Date());
    assert(transferTries.filter((t) => t.key?.startsWith(`quote_balance_payout_${C.a.id}`)).length === tries0 + 2 && (await jobOf(C.a.id)).payout_status === "held", "a run before the claim runs out does not try again", transferTries.length);
    await q(`UPDATE quote_jobs SET payout_next_at = now() - interval '1 minute', payout_claimed_at = now() - interval '20 minutes' WHERE appointment_id = $1`, [C.a.id]);
    await qw.runQuoteWindowJob(new Date());
    j = await jobOf(C.a.id);
    assert(balanceTransfers(C.a.id).length === 1 && j.payout_status === "paid" && j.payout_transfer_id === balanceTransfers(C.a.id)[0].id, "the next try finds it at Stripe and records it", j);

    console.log("\n── staff bookings pay the staff member ──");
    const S = await completed({ staffId, sender: staffUser.uid, conv: convStaff });
    r = await call("POST", `/api/quotes/${S.qid}/confirm`, { token: cust.token });
    bt = balanceTransfers(S.a.id);
    assert(r.status === 200 && bt.length === 1 && bt[0].destination === `acct_staff_${P}` && bt[0].metadata.recipient === "staff_balance", "the staff member's account, like the deposit", bt);

    console.log("\n── an open dispute pauses the payout (B10) ──");
    const D = await completed();
    await q(`INSERT INTO stripe_disputes (dispute_id, payment_intent_id, kind, reference_id, amount_cents, status) VALUES ($1, $2, 'appointment', $3, 59400, 'needs_response')`, [`dp_${D.a.id}`, D.job.stripe_payment_intent_id, D.a.id]);
    await shiftWindow(D.a.id, 7);
    await qw.runQuoteWindowJob(new Date());
    assert(balanceTransfers(D.a.id).length === 0 && (await jobOf(D.a.id)).payout_status === "held", "not paid while the dispute is open");
    await q(`UPDATE stripe_disputes SET outcome = 'won', status = 'won' WHERE dispute_id = $1`, [`dp_${D.a.id}`]);
    await qw.runQuoteWindowJob(new Date());
    assert(balanceTransfers(D.a.id).length === 1, "paid once the dispute is won");

    console.log("\n── Report a problem ──");
    const E = await completed();
    r = await call("POST", `/api/quotes/${E.qid}/report`, { token: owner.token, body: { reason: "The vendor reporting himself" } });
    assert(r.status === 404, "only the customer can report", r.status);
    r = await call("POST", `/api/quotes/${E.qid}/report`, { token: cust.token, body: { reason: "Bad" } });
    assert(r.status === 400 && r.body?.code === "REASON_TOO_SHORT", "a reason is required", r);
    r = await call("POST", `/api/quotes/${E.qid}/report`, { token: cust.token, body: { reason: "The crew broke a lamp", photos: ["https://evil.example/x.jpg"] } });
    assert(r.status === 400 && r.body?.code === "BAD_PHOTO", "photos must be our uploads", r);
    const reqsBefore = (await q(`SELECT count(*)::int AS n FROM refund_requests WHERE target_id = $1`, [E.a.id]))[0].n;
    r = await call("POST", `/api/quotes/${E.qid}/report`, { token: cust.token, body: { reason: "  The crew broke a lamp in the hallway  ", photos: [`${R2}/lamp.jpg`] } });
    j = await jobOf(E.a.id);
    const rep = (await q(`SELECT * FROM quote_reports WHERE appointment_id = $1`, [E.a.id]))[0];
    const rr = rep ? (await q(`SELECT * FROM refund_requests WHERE id = $1`, [rep.refund_request_id]))[0] : null;
    assert(r.status === 200 && reqsBefore === 0, "the customer reports a problem", r);
    assert(j.payout_status === "paused" && !!j.reported_at, "the payout is paused", j);
    assert(rep?.status === "open" && rep.reason === "The crew broke a lamp in the hallway" && rep.photos?.length === 1 && rep.held_cents === BAL_GROSS + DEP_GROSS, "the report covers everything still paid", rep);
    assert(rr?.status === "pending" && rr.target_type === "appointment" && rr.target_id === E.a.id && rr.amount === BAL_GROSS + DEP_GROSS && rr.requester_id === cust.uid && rr.reason.includes("lamp"), "it shows on the admin Refunds page", rr);
    assert((await cardsOf(conv, "problem_reported")).length >= 1, "the vendor gets a paused payout card");
    r = await call("POST", `/api/quotes/${E.qid}/report`, { token: cust.token, body: { reason: "Reporting a second time" } });
    assert(r.status === 409 && r.body?.code === "ALREADY_REPORTED", "one report per booking", r);
    r = await call("POST", `/api/quotes/${E.qid}/confirm`, { token: cust.token });
    assert(r.status === 409 && r.body?.code === "REPORTED", "no Confirm after a report", r);
    await shiftWindow(E.a.id, 7);
    await qw.runQuoteWindowJob(new Date());
    assert(balanceTransfers(E.a.id).length === 0 && (await pending("quote_balance", j.id))?.status === "pending" && (await pending("appointment", E.a.id))?.status === "pending", "after the window: still paused, points still pending");
    r = await call("GET", `/api/admin/refund-requests`, { token: admin.token });
    const row = (r.body?.requests ?? []).find((x: any) => x.id === rr?.id);
    assert(row?.quoteReport?.reportId === rep?.id && row.quoteReport.maxRefundCents === BAL_GROSS + DEP_GROSS && row.quoteReport.photos?.length === 1 && Array.isArray(row.quoteReport.outcomes), "the admin list shows the report details (additive)", row?.quoteReport);
    r = await call("GET", `/api/quotes/${E.qid}`, { token: cust.token });
    assert(r.body?.quote?.window?.state === "reported" && r.body?.quote?.report?.status === "open", "the quote shows the open report", { w: r.body?.quote?.window, rp: r.body?.quote?.report });
    // The 48 hour reminder.
    await qw.runQuoteWindowJob(new Date());
    assert(!alerts.some((x) => x.subject.toLowerCase().includes("reminder") && x.text.includes(E.a.id)), "no reminder before 48 hours");
    await q(`UPDATE quote_reports SET created_at = now() - interval '49 hours' WHERE id = $1`, [rep.id]);
    await qw.runQuoteWindowJob(new Date());
    await qw.runQuoteWindowJob(new Date());
    assert(alerts.filter((x) => x.subject.toLowerCase().includes("reminder") && x.text.includes(E.a.id)).length === 1, "one reminder after 48 hours");

    console.log("\n── your decision: partial refund ──");
    r = await call("PATCH", `/api/admin/refund-requests/${rr.id}`, { token: cust.token, body: { status: "approved", outcome: "partial_refund", amountCents: 25000 } });
    assert(r.status === 401 || r.status === 403, "only an admin", r.status);
    r = await call("PATCH", `/api/admin/refund-requests/${rr.id}`, { token: admin.token, body: { status: "approved", outcome: "partial_refund" } });
    assert(r.status === 400 && r.body?.code === "AMOUNT_REQUIRED", "partial needs an amount", r);
    r = await call("PATCH", `/api/admin/refund-requests/${rr.id}`, { token: admin.token, body: { status: "approved", outcome: "partial_refund", amountCents: BAL_GROSS + DEP_GROSS } });
    assert(r.status === 400 && r.body?.code === "USE_FULL_REFUND", "everything is a full refund", r);
    const refundsBefore = refunds.length;
    r = await call("PATCH", `/api/admin/refund-requests/${rr.id}`, { token: admin.token, body: { status: "approved", outcome: "partial_refund", amountCents: 25000, adminNotes: "Lamp" } });
    j = await jobOf(E.a.id);
    const repD = (await q(`SELECT * FROM quote_reports WHERE id = $1`, [rep.id]))[0];
    const newRefunds = refunds.slice(refundsBefore);
    assert(r.status === 200 && repD.status === "decided" && repD.outcome === "partial_refund" && repD.refund_cents === 25000, "decided: partial refund", { r, repD });
    assert(newRefunds.length === 1 && newRefunds[0].amount === 25000 && newRefunds[0].payment_intent === j.stripe_payment_intent_id, "refunded from the balance payment first", newRefunds);
    assert((await q(`SELECT status FROM refund_requests WHERE id = $1`, [rr.id]))[0].status === "approved", "the request is approved");
    bt = balanceTransfers(E.a.id);
    assert(bt.length === 1 && bt[0].amount === 53900 - Math.round(53900 * 25000 / 55000) && j.payout_status === "paid", "the vendor is paid the rest of their share", { bt, s: j.payout_status });
    assert(await earned("quote_balance", j.id) === pointsForGrossCents(BAL_GROSS - 25000) && await earned("appointment", E.a.id) === pointsForGrossCents(DEP_GROSS), "points on what stays paid", { b: await earned("quote_balance", j.id), d: await earned("appointment", E.a.id) });
    assert((await apptOf(E.qid)).status === "completed", "the booking stays completed");
    r = await call("PATCH", `/api/admin/refund-requests/${rr.id}`, { token: admin.token, body: { status: "approved", outcome: "full_refund" } });
    assert(r.status === 400 && refunds.length === refundsBefore + 1, "decided reports are final (B13)", r);
    r = await call("PATCH", `/api/admin/refund-requests/${rr.id}`, { token: admin.token, body: { status: "rejected" } });
    assert(r.status === 400, "no change after a decision", r);

    console.log("\n── today's Approve button: full refund, fees included ──");
    const F = await completed();
    // In process (the server process sends real email): the report emails Outsyde.
    const { db: appDb2 } = await import("../db");
    const { quotes: quotesTbl } = await import("@shared/schema");
    const { eq: deq } = await import("drizzle-orm");
    const [qF] = await appDb2.select().from(quotesTbl).where(deq(quotesTbl.id, F.qid));
    const rF = await qw.reportQuoteJob(qF, { reason: "Nobody came to do the job" });
    assert(rF.ok && alerts.some((x) => x.subject.startsWith("Problem reported") && x.text.includes(F.a.id) && x.text.includes("Nobody came")), "Outsyde is emailed about the report", alerts.map((x) => x.subject));
    const repF = (await q(`SELECT * FROM quote_reports WHERE appointment_id = $1`, [F.a.id]))[0];
    const rb0 = refunds.length;
    r = await call("PATCH", `/api/admin/refund-requests/${repF.refund_request_id}`, { token: admin.token, body: { status: "approved" } });
    j = await jobOf(F.a.id);
    const fr = refunds.slice(rb0);
    const aF = await apptOf(F.qid);
    assert(r.status === 200, "approved", r);
    assert(fr.length === 2 && fr.find((x) => x.payment_intent === j.stripe_payment_intent_id)?.amount === BAL_GROSS && fr.find((x) => x.payment_intent === aF.stripe_payment_intent_id)?.amount === DEP_GROSS, "every dollar back from both payments, fees included", fr);
    assert(j.payout_status === "canceled" && balanceTransfers(F.a.id).length === 0, "the vendor's balance share is never paid", j.payout_status);
    assert(await earned("quote_balance", j.id) === 0 && await earned("appointment", F.a.id) === 0 && (await pending("quote_balance", j.id))?.status === "rejected" && (await pending("appointment", F.a.id))?.status === "rejected", "no points (all refunded)");
    assert((await q(`SELECT outcome FROM quote_reports WHERE id = $1`, [repF.id]))[0].outcome === "full_refund", "recorded as full refund");

    console.log("\n── today's Reject button: pay in full ──");
    const G = await completed();
    r = await call("POST", `/api/quotes/${G.qid}/report`, { token: cust.token, body: { reason: "Not sure the floor was cleaned" } });
    const repG = (await q(`SELECT * FROM quote_reports WHERE appointment_id = $1`, [G.a.id]))[0];
    const rb1 = refunds.length;
    r = await call("PATCH", `/api/admin/refund-requests/${repG.refund_request_id}`, { token: admin.token, body: { status: "rejected", adminNotes: "Photos show it clean" } });
    j = await jobOf(G.a.id);
    assert(r.status === 200 && refunds.length === rb1 && balanceTransfers(G.a.id).length === 1 && balanceTransfers(G.a.id)[0].amount === 53900 && j.payout_status === "paid", "the vendor is paid in full, nothing refunded", { r, s: j.payout_status });
    assert(await earned("quote_balance", j.id) === pointsForGrossCents(BAL_GROSS), "points released");

    console.log("\n── points follow the money on cancels (B8) ──");
    const K = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72, minutes: 180 });
    const aK = await payQuote(K.qid, cust.token);
    r = await call("POST", `/api/bookings/appointments/${aK.id}/cancel`, { token: cust.token });
    assert(r.status === 200, "the customer cancels (deposit kept)", r);
    await qw.runQuoteWindowJob(new Date());
    assert((await pending("appointment", aK.id))?.status === "pending", "settled only after a short wait");
    await q(`UPDATE appointments SET updated_at = now() - interval '5 minutes', canceled_at = now() - interval '5 minutes' WHERE id = $1`, [aK.id]);
    await qw.runQuoteWindowJob(new Date());
    assert(await earned("appointment", aK.id) === pointsForGrossCents(DEP_GROSS), "the deposit stays paid, so its points are kept", { e: await earned("appointment", aK.id), p: await pending("appointment", aK.id) });
    const V = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72, minutes: 180 });
    const aV = await payQuote(V.qid, cust.token);
    r = await call("POST", `/api/bookings/appointments/${aV.id}/refund`, { token: owner.token, body: {} });
    assert(r.status === 200, "the vendor refunds and cancels", r);
    await q(`UPDATE appointments SET updated_at = now() - interval '5 minutes', canceled_at = now() - interval '5 minutes' WHERE id = $1`, [aV.id]);
    await qw.runQuoteWindowJob(new Date());
    assert(await earned("appointment", aV.id) === 0 && (await pending("appointment", aV.id))?.status === "rejected", "everything refunded: no points", await pending("appointment", aV.id));

    console.log("\n── the old refund request route sends quote bookings to Report (B12) ──");
    const blocked = await qw.refundRequestBlocker("appointment", A.a.id);
    assert(blocked?.code === "USE_REPORT", "a quote booking is refused", blocked);
    assert(await qw.refundRequestBlocker("order", "anything") === null && await qw.refundRequestBlocker("appointment", "not-a-quote-booking") === null, "everything else unchanged");

    console.log("\n── a normal (non report) refund request on a quote booking still works as before ──");
    const L = await completed();
    await call("POST", `/api/quotes/${L.qid}/confirm`, { token: cust.token });
    const [legacy] = await q(`INSERT INTO refund_requests (id, requester_id, requester_type, target_type, target_id, reason, amount) VALUES ($1, $2, 'customer', 'appointment', $3, 'legacy', 5000) RETURNING id`, [id("rr-legacy"), cust.uid, L.a.id]);
    const rb2 = refunds.length;
    r = await call("PATCH", `/api/admin/refund-requests/${legacy.id}`, { token: admin.token, body: { status: "approved" } });
    assert(r.status === 200 && refunds.length === rb2 + 1 && refunds[refunds.length - 1].amount === 5000, "approved through the 4a refund plan", r);
    await qw.runQuoteWindowJob(new Date());
    const jL = await jobOf(L.a.id);
    assert(await earned("quote_balance", jL.id) - await reversed(jL.id) === pointsForGrossCents(BAL_GROSS - 5000) && await reversed(L.a.id) === 0, "points follow the money there too", { b: await earned("quote_balance", jL.id), rv: await reversed(jL.id), d: await reversed(L.a.id) });
  } finally {
    const ids = users;
    await q(`DELETE FROM quote_jobs WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM refund_requests WHERE requester_id = ANY($1)`, [ids]).catch(() => undefined);
    await q(`DELETE FROM pending_points_transactions WHERE reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM booking_payout_issues WHERE reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM booking_refund_recoveries WHERE payment_intent_id LIKE 'pi_qb_%'`).catch(() => undefined);
    await q(`DELETE FROM stripe_disputes WHERE payment_intent_id LIKE 'pi_qb_%'`).catch(() => undefined);
    await q(`DELETE FROM quote_reports WHERE customer_id = ANY($1)`, [users]).catch(() => undefined);
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
