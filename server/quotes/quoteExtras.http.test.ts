/**
 * Quotes step 4b-2b (migration 102): extras. The vendor sends them, the customer approves or declines, Approve
 * holds them on the card (on session; far out: a card check now and the hold 24 hours before), one charge at Job
 * complete, the vendor's share after the window as its own transfer, refunds from the extras first.
 *
 * Legend 2026-11-05 (B1 to B4, E2 to E7). Run with: npx tsx server/quotes/quoteExtras.http.test.ts (same scratch
 * setup as quoteBalance.http.test.ts). Skips (exit 0) when QB_TEST_BASE_URL is unset; refuses any non-local host.
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

  // ── Stripe stub: manual capture, off and on session confirms, SetupIntents, 3DS, declines, refunds, transfers ──
  const piStore: Record<string, any> = {};
  const siStore: Record<string, any> = {};
  const piCreates: { key: string | undefined; amount: number; metadata: Record<string, string>; form: Record<string, string> }[] = [];
  const siCreates: { key: string | undefined; metadata: Record<string, string>; form: Record<string, string> }[] = [];
  const captures: { id: string; amount_to_capture: number | null; key: string | undefined }[] = [];
  const cancels: string[] = [];
  const refunds: any[] = [];
  const transfers: any[] = [];
  let declineNextOffSession = 0;
  let declineNextOnSession = 0;
  let actionNextOnSession = 0;
  let declineNextSetup = 0;
  let actionNextSetup = 0;
  let loseNextExtrasReply = false;
  const lostKeys = new Set<string>();
  const cardError = (extra: Record<string, unknown>) => ({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds.", ...extra } });
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      const flat: Record<string, string> = {}; for (const [k, v] of form.entries()) flat[k] = v;
      const meta = () => { const m: Record<string, string> = {}; for (const [k, v] of form.entries()) { const x = k.match(/^metadata\[(.+)\]$/); if (x) m[x[1]] = v; } return m; };
      const url = new URL(req.url || "/", "http://stub");
      const key = req.headers["idempotency-key"] as string | undefined;
      if (req.method === "POST" && url.pathname === "/v1/customers") return send(200, { id: `cus_qx_${Date.now()}`, object: "customer" });
      const custM = url.pathname.match(/^\/v1\/customers\/([^/]+)$/);
      if (req.method === "GET" && custM) return send(200, { id: custM[1], object: "customer" });
      if (req.method === "POST" && url.pathname === "/v1/customer_sessions") return send(200, { client_secret: "cuss_stub" });
      if (req.method === "POST" && url.pathname === "/v1/ephemeral_keys") return send(200, { secret: "ek_stub" });
      if (req.method === "POST" && url.pathname === "/v1/payment_intents") {
        if (key && lostKeys.has(key)) { req.socket.destroy(); return; }
        const prior = Object.values(piStore).find((p: any) => p._key && p._key === key);
        if (prior) return send(200, prior);
        const metadata = meta();
        const id = `pi_qb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const confirm = flat.confirm === "true" && !!flat.payment_method;
        const offSession = confirm && flat.off_session === "true";
        const onSession = confirm && !offSession;
        const amount = Number(flat.amount || 0);
        const manual = flat.capture_method === "manual";
        let status = "requires_payment_method";
        if (confirm) status = manual ? "requires_capture" : "succeeded";
        if (onSession && actionNextOnSession > 0) { actionNextOnSession--; status = "requires_action"; }
        const pi: any = { id, object: "payment_intent", amount, amount_received: status === "succeeded" ? amount : 0, amount_capturable: status === "requires_capture" ? amount : 0,
          status, client_secret: `${id}_secret`, capture_method: flat.capture_method || "automatic", metadata, customer: flat.customer,
          payment_method: flat.payment_method || "pm_qb_card", latest_charge: status === "succeeded" ? `ch_${id}` : null,
          setup_future_usage: flat.setup_future_usage, off_session: flat.off_session, created: Math.floor(Date.now() / 1000), _key: key };
        piCreates.push({ key, amount, metadata, form: flat });
        if ((offSession && declineNextOffSession > 0) || (onSession && declineNextOnSession > 0)) {
          if (offSession) declineNextOffSession--; else declineNextOnSession--;
          return send(402, cardError({ payment_intent: { ...pi, status: "requires_payment_method" } }));
        }
        piStore[id] = pi;
        if (metadata.type === "quote_extras" && loseNextExtrasReply) { loseNextExtrasReply = false; if (key) lostKeys.add(key); req.socket.destroy(); return; }
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
        captures.push({ id: pi.id, amount_to_capture: flat.amount_to_capture ? Number(flat.amount_to_capture) : null, key });
        pi.status = "succeeded"; pi.amount_received = amt; pi.amount_capturable = 0; pi.latest_charge = `ch_${pi.id}`;
        return send(200, pi);
      }
      const piCancel = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
      if (req.method === "POST" && piCancel) {
        const pi = piStore[piCancel[1]];
        if (!pi) return send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
        if (pi.status === "succeeded") return send(400, { error: { type: "invalid_request_error", message: "cannot cancel a succeeded PaymentIntent" } });
        if (pi.status !== "canceled") cancels.push(pi.id);
        pi.status = "canceled"; pi.amount_capturable = 0;
        return send(200, pi);
      }
      if (req.method === "POST" && url.pathname === "/v1/setup_intents") {
        const prior = Object.values(siStore).find((p: any) => p._key && p._key === key);
        if (prior) return send(200, prior);
        const metadata = meta();
        const id = `seti_qx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const confirm = flat.confirm === "true" && !!flat.payment_method;
        let status = confirm ? "succeeded" : "requires_payment_method";
        if (confirm && actionNextSetup > 0) { actionNextSetup--; status = "requires_action"; }
        const si: any = { id, object: "setup_intent", status, client_secret: `${id}_secret`, customer: flat.customer, payment_method: flat.payment_method ?? null, usage: flat.usage, metadata, created: Math.floor(Date.now() / 1000), _key: key };
        siCreates.push({ key, metadata, form: flat });
        if (confirm && declineNextSetup > 0) { declineNextSetup--; return send(402, cardError({ setup_intent: { ...si, status: "requires_payment_method" } })); }
        siStore[id] = si;
        return send(200, si);
      }
      if (req.method === "GET" && url.pathname === "/v1/setup_intents") {
        const customer = url.searchParams.get("customer");
        return send(200, { object: "list", data: Object.values(siStore).filter((p: any) => !customer || p.customer === customer), has_more: false });
      }
      const siM = url.pathname.match(/^\/v1\/setup_intents\/([^/]+)$/);
      if (req.method === "GET" && siM) return siStore[siM[1]] ? send(200, siStore[siM[1]]) : send(404, { error: { type: "invalid_request_error", message: "No such setup_intent" } });
      const siCancel = url.pathname.match(/^\/v1\/setup_intents\/([^/]+)\/cancel$/);
      if (req.method === "POST" && siCancel) { const si = siStore[siCancel[1]]; if (!si) return send(404, { error: { type: "invalid_request_error", message: "No such setup_intent" } }); si.status = "canceled"; return send(200, si); }
      if (req.method === "POST" && url.pathname === "/v1/refunds") {
        const pi = piStore[flat.payment_intent || ""];
        const amount = Number(flat.amount || (pi ? pi.amount_received - (pi._refunded || 0) : 0));
        const prior = refunds.find((x) => x._key && x._key === key);
        if (prior) return send(200, prior);
        if (pi) pi._refunded = (pi._refunded || 0) + amount;
        const r = { id: `re_qx_${refunds.length + 1}`, object: "refund", amount, payment_intent: flat.payment_intent, status: "succeeded", metadata: meta(), created: Math.floor(Date.now() / 1000), _key: key };
        refunds.push(r);
        return send(200, r);
      }
      if (req.method === "GET" && url.pathname === "/v1/refunds") return send(200, { object: "list", data: refunds.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
      if (req.method === "POST" && url.pathname === "/v1/transfers") {
        const tprior = transfers.find((x) => x._key && x._key === key);
        if (tprior) return send(200, tprior);
        const t = { id: `tr_qx_${transfers.length + 1}`, object: "transfer", amount: Number(flat.amount), destination: flat.destination, transfer_group: flat.transfer_group, metadata: meta(), amount_reversed: 0, reversals: { data: [] }, source_transaction: flat.source_transaction, _key: key };
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
  const extrasPis = () => piCreates.filter((c) => c.metadata.type === "quote_extras");

  const { WebhookHandlers } = await import("../stripe/webhookHandlers");
  const qb = await import("./quoteBalance");
  const { quoteExtraSplit } = await import("../fees");

  const P = `qx${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = "Ana", admin = false) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, stripe_customer_id, is_admin) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4, $5)`, [uid, `${uid}@qx.test`, first, `cus_${uid}`, admin]);
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
    // A job that crossed midnight left a block on its next day: move it back with the booking (test runs after 9 PM).
    await q(`UPDATE provider_blocks SET start_at = start_at - interval '30 days', end_at = end_at - interval '30 days' WHERE appointment_id = $1`, [a.id]);
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
  const DEP_GROSS = 10800, BAL_GROSS = 59400, DEP = 10000, BAL = 55000; // money paid, and the business's part (the fee is never refunded)
  const balPts = (refunded: number) => Math.round((pointsForGrossCents(BAL_GROSS) * (BAL - refunded)) / BAL);
  const qx = await import("./quoteExtras");
  // Step 6a: pushes and emails sent in this process are captured (the server's own go to the Expo stub file).
  const qnot = await import("./quoteNotices");
  const noticePushes: { userId: string; title: string; body: string; data?: Record<string, string> }[] = [];
  const noticeEmails: { to: string; subject: string; text: string; html: string }[] = [];
  qnot.setQuoteNoticeDepsForTest({
    sendPush: async (p) => { noticePushes.push(p); return true; },
    sendEmail: async (m) => { noticeEmails.push(m); return true; },
  });
  const { resolveBooking: resolveBookingForTest } = await import("../bookingRecoveries");
  const payOf = async (apptId: string) => (await q(`SELECT * FROM quote_extras_payments WHERE appointment_id = $1`, [apptId]))[0];
  const extraOf = async (extraId: string) => (await q(`SELECT * FROM quote_extras WHERE id = $1`, [extraId]))[0];
  const extrasTransfers = (apptId: string) => transfers.filter((t) => t.transfer_group === `appointment_extras_${apptId}`);
  const split = (c: number) => quoteExtraSplit(c);
  /** A near paid quote (the job ends within 6 days): extras are held at Approve. */
  const paidQuote = async (o: { hoursOut?: number; deposit?: number | null } = {}) => {
    const Q = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: o.hoursOut ?? 72, minutes: 180, deposit: o.deposit });
    const a = await payQuote(Q.qid, cust.token);
    return { qid: Q.qid, a, startsAt: Q.startsAt };
  };
  /** Holds the balance (24 hours before) and moves the start into the past, so Job complete can run. */
  const readyToComplete = async (apptId: string, hoursOut = 72) => {
    await shiftJob(apptId, hoursOut - 23 + Math.ceil((qn * 11) / 60));
    await qb.runQuoteBalanceJob(new Date());
    await shiftJob(apptId, 24);
    await q(`UPDATE appointments SET appointment_date = $2 WHERE id = $1`, [apptId, ymdNY(new Date(Date.now() - 2 * H))]);
    await q(`UPDATE provider_blocks SET start_at = start_at - interval '30 days', end_at = end_at - interval '30 days' WHERE appointment_id = $1`, [apptId]);
  };
  const propose = async (qid: string, description: string, amountCents: number, token = owner.token) =>
    call("POST", `/api/quotes/${qid}/extras`, { token, body: { description, amountCents } });
  const approve = async (qid: string, extraId: string, body: Record<string, unknown> = {}) => call("POST", `/api/quotes/${qid}/extras/${extraId}/approve`, { token: cust.token, body });

  try {
    console.log("\n── the vendor sends an extra (B3) ──");
    const unpaid = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72, minutes: 180 });
    let r = await propose(unpaid.qid, "2 extra hours", 10000);
    assert(r.status === 409 && r.body?.code === "NOT_CONFIRMED", "only after the quote is paid", r);
    const E = await paidQuote();
    r = await propose(E.qid, "2 extra hours", 10000, stranger.token);
    assert(r.status === 404, "a stranger can't", r.status);
    r = await propose(E.qid, "2 extra hours", 10000, cust.token);
    assert(r.status === 404, "the customer can't send one", r.status);
    r = await propose(E.qid, "ab", 10000);
    assert(r.status === 400 && r.body?.field === "description", "a description is required", r);
    r = await propose(E.qid, "Stairs", 99);
    assert(r.status === 400 && r.body?.field === "amountCents", "at least $1", r);
    r = await propose(E.qid, "  2 extra   hours ", 10000);
    const x1 = r.body?.extra;
    assert(r.status === 201 && x1?.status === "proposed" && x1.description === "2 extra hours" && x1.amountCents === 10000 && x1.serviceFeeCents === 800 && x1.totalCents === 10800, "sent: $100 plus its own fee", r);
    let card = (await cardsOf(conv, "extra_proposed")).pop();
    assert(card?.content === "Movers a added 2 extra hours, $100.00 plus a service fee. Nothing is charged unless you approve." && card.card?.extraId === x1?.id && card.sender_id === owner.uid, "the customer gets an Approve or Decline card", card && { c: card.content, s: card.sender_id });
    assert((await extraOf(x1.id))?.message_id === card?.id, "the card is saved on the extra");
    r = await propose(E.qid, "Piano", 55001);
    assert(r.status === 409 && r.body?.code === "OVER_TOTAL", "all extras together up to the quote total ($650)", r);
    assert(extrasPis().length === 0 && siCreates.length === 0, "nothing is charged or checked when it is sent");
    r = await call("GET", `/api/quotes/${E.qid}`, { token: cust.token });
    let ex = r.body?.quote?.extras;
    assert(Array.isArray(ex) && ex.length === 1 && ex[0].canApprove === true && ex[0].canDecline === true && ex[0].canWithdraw === false, "the customer sees it with Approve and Decline", ex);
    r = await call("GET", `/api/quotes/${E.qid}`, { token: owner.token });
    ex = r.body?.quote?.extras;
    assert(ex?.[0]?.canWithdraw === true && ex[0].canApprove === false, "the vendor can withdraw it", ex);

    console.log("\n── withdraw and decline ──");
    r = await propose(E.qid, "Packing tape", 2500);
    const x2 = r.body?.extra;
    r = await call("POST", `/api/quotes/${E.qid}/extras/${x2.id}/withdraw`, { token: cust.token });
    assert(r.status === 404, "the customer can't withdraw", r.status);
    r = await call("POST", `/api/quotes/${E.qid}/extras/${x2.id}/withdraw`, { token: owner.token });
    assert(r.status === 200 && (await extraOf(x2.id)).status === "withdrawn", "the vendor withdraws it before it is answered", r);
    assert((await cardsOf(conv, "extra_withdrawn")).pop()?.content === "Movers a took back Packing tape. Nothing was added.", "the customer is told");
    r = await call("POST", `/api/quotes/${E.qid}/extras/${x2.id}/withdraw`, { token: owner.token });
    assert(r.status === 409 && r.body?.code === "NOT_OPEN", "only once", r);
    r = await propose(E.qid, "Boxes", 1000);
    const x3 = r.body?.extra;
    r = await call("POST", `/api/quotes/${E.qid}/extras/${x3.id}/decline`, { token: owner.token });
    assert(r.status === 404, "the vendor can't decline", r.status);
    r = await call("POST", `/api/quotes/${E.qid}/extras/${x3.id}/decline`, { token: cust.token });
    assert(r.status === 200 && (await extraOf(x3.id)).status === "declined" && !!(await extraOf(x3.id)).answered_at, "the customer declines", r);
    const dc = (await cardsOf(conv, "extra_declined")).pop();
    assert(dc?.content === "Declined: Boxes. Nothing was added." && dc.sender_id === cust.uid, "the vendor is told", dc && { c: dc.content, s: dc.sender_id });
    r = await approve(E.qid, x3.id);
    assert(r.status === 409 && r.body?.code === "NOT_OPEN", "a declined extra can't be approved", r);
    r = await call("POST", `/api/quotes/${E.qid}/extras/${x2.id}/withdraw`, { token: owner.token });

    console.log("\n── Approve holds it on the card at once, on session (B1, held at Approve) ──");
    r = await call("POST", `/api/quotes/${E.qid}/extras/${x1.id}/approve`, { token: owner.token });
    assert(r.status === 404, "the vendor can't approve", r.status);
    r = await approve(E.qid, x1.id);
    let pis = extrasPis();
    assert(r.status === 200 && r.body?.status === "approved" && r.body?.extra?.status === "approved", "approved", r);
    assert(pis.length === 1 && pis[0].amount === 10800 && pis[0].form.capture_method === "manual" && pis[0].form.confirm === "true" && pis[0].form.off_session !== "true"
      && pis[0].form.payment_method === "pm_qb_card" && pis[0].form.customer === `cus_${cust.uid}` && pis[0].metadata.appointmentId === E.a.id, "one hold for $108, on session, the card the deposit used", pis);
    let p = await payOf(E.a.id);
    assert(p.status === "held" && p.approved_cents === 10000 && p.fee_cents === 800 && p.hold_cents === 10800 && p.vendor_net_cents === 9800 && p.stripe_payment_intent_id === piStore[Object.keys(piStore).find((k) => piStore[k]._key === pis[0].key)!]?.id, "the extras payment is held", p);
    const firstPi = p.stripe_payment_intent_id;
    const ac = (await cardsOf(conv, "extra_approved")).pop();
    assert(ac?.content === "Approved: 2 extra hours, $100.00. It is held on the card and charged when the job is complete." && ac.sender_id === cust.uid, "the vendor is told", ac && { c: ac.content, s: ac.sender_id });
    r = await approve(E.qid, x1.id);
    assert(r.status === 200 && r.body?.status === "approved" && extrasPis().length === 1, "a second tap answers approved and holds nothing more", r);
    // Review C1: Stripe's event for the hold Approve just recorded never lets it go.
    await WebhookHandlers.handlePaymentIntentCapturableUpdated({ ...piStore[firstPi] });
    assert(piStore[firstPi].status === "requires_capture" && (await payOf(E.a.id)).status === "held", "the event for the hold on record changes nothing", piStore[firstPi].status);

    console.log("\n── a new approval replaces the hold with one for the new total ──");
    const x4 = (await propose(E.qid, "Mattress bag", 5000)).body?.extra;
    r = await approve(E.qid, x4.id);
    p = await payOf(E.a.id);
    pis = extrasPis();
    assert(r.status === 200 && pis.length === 2 && pis[1].amount === 10800 + 5400 && p.hold_cents === 16200 && p.approved_cents === 15000 && p.vendor_net_cents === 9800 + 4900, "one hold for $162 now", { p, a: pis[1]?.amount });
    assert(p.stripe_payment_intent_id !== firstPi && cancels.includes(firstPi) && piStore[firstPi].status === "canceled" && !p.release_pi, "the old hold is let go", { cancels, p });

    console.log("\n── a declined card fails at Approve and adds nothing ──");
    const x5 = (await propose(E.qid, "Extra mover", 2000)).body?.extra;
    declineNextOnSession = 1;
    r = await approve(E.qid, x5.id);
    p = await payOf(E.a.id);
    assert(r.status === 402 && r.body?.code === "CARD_DECLINED" && (await extraOf(x5.id)).status === "proposed", "declined: the extra stays open", r);
    assert(p.hold_cents === 16200 && piStore[p.stripe_payment_intent_id].status === "requires_capture", "the hold on the card is unchanged", p);

    console.log("\n── a card that needs the customer (3D Secure) ──");
    actionNextOnSession = 1;
    r = await approve(E.qid, x5.id);
    let x5row = await extraOf(x5.id);
    assert(r.status === 200 && r.body?.status === "needs_action" && r.body?.intentType === "payment" && /_secret$/.test(r.body?.clientSecret ?? "") && x5row.status === "approving", "the app finishes it on the phone", r);
    p = await payOf(E.a.id);
    assert(p.hold_cents === 16200 && !p.approve_claim_tag, "nothing changes until it goes through, and nothing stays claimed", p);
    const actionPi = x5row.approve_intent_id;
    piStore[actionPi].status = "requires_capture"; piStore[actionPi].amount_capturable = piStore[actionPi].amount;
    await WebhookHandlers.handlePaymentIntentCapturableUpdated({ ...piStore[actionPi] });
    p = await payOf(E.a.id);
    x5row = await extraOf(x5.id);
    assert(x5row.status === "approved" && p.stripe_payment_intent_id === actionPi && p.hold_cents === 16200 + 2160 && piStore[actionPi].amount === 18360, "once it goes through, the new hold stands", { x5row, p });
    assert(piStore[firstPi].status === "canceled" && cancels.length >= 2, "and the one before is let go", cancels);
    await WebhookHandlers.handlePaymentIntentCapturableUpdated({ ...piStore[actionPi] });
    assert((await cardsOf(conv, "extra_approved")).length === 3, "one approved card each, even when Stripe repeats the event");
    // Review C1: the app calls Approve again after 3D Secure, after the event already finished it.
    r = await approve(E.qid, x5.id);
    assert(r.status === 200 && r.body?.status === "approved" && piStore[actionPi].status === "requires_capture" && (await payOf(E.a.id)).stripe_payment_intent_id === actionPi, "the call after 3D Secure answers approved and keeps the hold", { r, s: piStore[actionPi].status });
    // An event arriving while an Approve holds the claim never lets that Approve's hold go.
    const xr = (await propose(E.qid, "Race test", 500)).body?.extra;
    const racePi = `pi_qb_race_${Date.now()}`;
    piStore[racePi] = { id: racePi, object: "payment_intent", amount: 18360 + 540, amount_capturable: 18360 + 540, status: "requires_capture", capture_method: "manual", metadata: { type: "quote_extras", appointmentId: E.a.id, extraId: xr.id }, customer: `cus_${cust.uid}` };
    await q(`UPDATE quote_extras_payments SET approve_claim_tag = 'race', approve_claimed_at = now() WHERE appointment_id = $1`, [E.a.id]);
    await WebhookHandlers.handlePaymentIntentCapturableUpdated({ ...piStore[racePi] });
    assert(piStore[racePi].status === "requires_capture", "an event during a live Approve leaves its hold alone", piStore[racePi].status);
    await q(`UPDATE quote_extras_payments SET approve_claim_tag = NULL, approve_claimed_at = NULL WHERE appointment_id = $1`, [E.a.id]);
    piStore[racePi].status = "canceled";
    await call("POST", `/api/quotes/${E.qid}/extras/${xr.id}/withdraw`, { token: owner.token });

    console.log("\n── Job complete charges the extras once and lapses open ones (B1, B2) ──");
    const x6 = (await propose(E.qid, "Shelf mounting", 1500)).body?.extra;
    await readyToComplete(E.a.id);
    r = await call("POST", `/api/quotes/${E.qid}/job-complete`, { token: owner.token });
    p = await payOf(E.a.id);
    assert(r.status === 200 && r.body?.extrasChargedCents === 18360, "complete: the extras are charged with the balance", r);
    assert(p.status === "captured" && p.captured_cents === 18360 && p.payout_status === "held" && captures.some((c) => c.id === p.stripe_payment_intent_id), "charged once, the vendor's share held for the window", p);
    assert((await extraOf(x6.id)).status === "lapsed", "an unanswered extra lapses", await extraOf(x6.id));
    let pe = await pending("quote_extras", p.id);
    assert(pe?.status === "pending" && pe.points_earned === pointsForGrossCents(18360), "extras points pending on what was charged", pe);
    await qw.runQuoteWindowJob(new Date());
    assert(extrasTransfers(E.a.id).length === 0 && (await payOf(E.a.id)).payout_status === "held", "nothing is paid for the extras while the 6 hour window is open");
    r = await propose(E.qid, "Late add", 1000);
    assert(r.status === 409 && r.body?.code === "ALREADY_COMPLETE", "no extras after Job complete", r);
    r = await call("POST", `/api/quotes/${E.qid}/confirm`, { token: cust.token });
    let et = extrasTransfers(E.a.id);
    p = await payOf(E.a.id);
    assert(r.status === 200 && et.length === 1 && et[0].amount === 9800 + 4900 + 1960 && et[0].metadata.recipient === "business_extras" && et[0].destination === `acct_a_${P}`, "Confirm pays the extras share as its own transfer", et);
    assert(p.payout_status === "paid" && p.payout_transfer_id === et[0]?.id && balanceTransfers(E.a.id).length === 1, "recorded, and the balance is paid too", p);
    assert(await earned("quote_extras", p.id) === pointsForGrossCents(18360), "extras points land", await earned("quote_extras", p.id));
    await qw.runQuoteWindowJob(new Date());
    assert(extrasTransfers(E.a.id).length === 1, "never twice");
    r = await call("GET", `/api/quotes/${E.qid}`, { token: owner.token });
    const ep = r.body?.quote?.extrasPayment;
    assert(ep?.status === "captured" && ep.capturedCents === 18360 && ep.payout?.status === "paid", "the vendor sees the extras payment and payout", ep);
    r = await call("GET", `/api/quotes/${E.qid}`, { token: cust.token });
    assert(r.body?.quote?.extrasPayment && r.body.quote.extrasPayment.payout === undefined, "the customer doesn't see the payout", r.body?.quote?.extrasPayment);

    console.log("\n── far out: the card is checked now and the hold placed 24 hours before (E2, E3) ──");
    const F = await paidQuote({ hoursOut: 240 });
    const f1 = (await propose(F.qid, "Disassembly", 10000)).body?.extra;
    const piBefore = extrasPis().length;
    r = await approve(F.qid, f1.id);
    p = await payOf(F.a.id);
    assert(r.status === 200 && r.body?.status === "approved" && extrasPis().length === piBefore, "approved with no hold on the card", r);
    const si = siCreates[siCreates.length - 1];
    assert(si?.form.usage === "off_session" && si.form.payment_method === "pm_qb_card" && si.form.confirm === "true" && si.metadata.extraId === f1.id, "a card check that reserves nothing (a SetupIntent)", si);
    const jF = await jobOf(F.a.id);
    assert(p.status === "scheduled" && Math.abs(new Date(p.hold_at).getTime() - (new Date(jF.starts_at).getTime() - 24 * H)) < 1000 && p.hold_cents === 10800, "held with the balance, 24 hours before", { p, s: jF.starts_at });
    await qx.runQuoteExtrasJob(new Date());
    assert(extrasPis().length === piBefore, "nothing held before its time");
    await q(`UPDATE quote_extras_payments SET hold_at = now() - interval '1 minute', retry_at = now() + interval '12 hours' WHERE id = $1`, [p.id]);
    await qx.runQuoteExtrasJob(new Date());
    p = await payOf(F.a.id);
    pis = extrasPis();
    assert(p.status === "held" && pis.length === piBefore + 1 && pis[pis.length - 1].form.off_session === "true" && pis[pis.length - 1].amount === 10800, "the hold is placed off session when due", p);

    console.log("\n── a far out hold that fails: retried, then Update your card, Job complete waits (E3) ──");
    const G = await paidQuote({ hoursOut: 250 });
    const g1 = (await propose(G.qid, "Crating", 5000)).body?.extra;
    await approve(G.qid, g1.id);
    p = await payOf(G.a.id);
    await q(`UPDATE quote_extras_payments SET hold_at = now() - interval '1 minute', retry_at = now() + interval '12 hours' WHERE id = $1`, [p.id]);
    declineNextOffSession = 1;
    await qx.runQuoteExtrasJob(new Date());
    p = await payOf(G.a.id);
    assert(p.status === "hold_failed" && !!p.retry_at && (await cardsOf(conv, "extras_hold_failed")).length === 0, "the first decline waits for the retry", p);
    await q(`UPDATE quote_extras_payments SET retry_at = now() - interval '1 minute' WHERE id = $1`, [p.id]);
    declineNextOffSession = 1;
    await qx.runQuoteExtrasJob(new Date());
    p = await payOf(G.a.id);
    const hf = await cardsOf(conv, "extras_hold_failed");
    assert(p.status === "hold_failed" && !p.retry_at && hf.length === 1 && hf[0].content === "We couldn't hold the extras, $54.00, on your card. Update your card so the job can be marked complete.", "then the customer is asked to update the card", { p, hf: hf.map((m: any) => m.content) });
    await readyToComplete(G.a.id, 250);
    r = await call("POST", `/api/quotes/${G.qid}/job-complete`, { token: owner.token });
    assert(r.status === 409 && r.body?.code === "EXTRAS_NOT_HELD" && (await apptOf(G.qid)).status === "confirmed", "Job complete waits until the extras are held", r);
    const gBalPi = (await jobOf(G.a.id)).stripe_payment_intent_id;
    assert(!!gBalPi && captures.every((c) => c.id !== gBalPi), "and the balance isn't charged meanwhile", gBalPi);
    r = await call("POST", `/api/quotes/${G.qid}/extras/card`, { token: stranger.token });
    assert(r.status === 404, "only the customer", r.status);
    r = await call("POST", `/api/quotes/${G.qid}/extras/card`, { token: cust.token });
    const newCard = piStore[r.body?.paymentIntentId];
    assert(r.status === 200 && r.body?.captureMethod === "manual" && newCard?.amount === 5400 && newCard.metadata.type === "quote_extras" && newCard.setup_future_usage === "off_session", "Update your card: a hold for the extras with a new card", r);
    newCard.status = "requires_capture"; newCard.amount_capturable = newCard.amount;
    await WebhookHandlers.handlePaymentIntentCapturableUpdated({ ...newCard });
    p = await payOf(G.a.id);
    assert(p.status === "held" && p.stripe_payment_intent_id === newCard.id, "held once the customer finishes", p);
    r = await call("POST", `/api/quotes/${G.qid}/job-complete`, { token: owner.token });
    p = await payOf(G.a.id);
    assert(r.status === 200 && p.status === "captured" && p.captured_cents === 5400, "now Job complete charges it", { r, p });

    console.log("\n── the backup: a hold that can't be charged (B4, E7) ──");
    const U = await paidQuote();
    const u1 = (await propose(U.qid, "Wall repair", 10000)).body?.extra;
    await approve(U.qid, u1.id);
    p = await payOf(U.a.id);
    piStore[p.stripe_payment_intent_id].status = "canceled"; // let go at Stripe, no event seen
    await readyToComplete(U.a.id);
    r = await call("POST", `/api/quotes/${U.qid}/job-complete`, { token: owner.token });
    p = await payOf(U.a.id);
    const uf = await cardsOf(conv, "extras_failed");
    assert(r.status === 200 && (await apptOf(U.qid)).status === "completed", "the job still completes", r);
    assert(p.status === "unpaid" && p.payout_status === "none" && uf.length === 1 && uf[0].content === "We couldn't charge your card for the extras, $108.00. Pay for extras to finish your booking.", "the extras are unpaid and the customer gets Pay for extras", { p, uf: uf.map((m: any) => m.content) });
    r = await call("GET", `/api/quotes/${U.qid}`, { token: owner.token });
    assert(r.body?.quote?.extrasPayment?.unpaid === true, "the vendor sees Extras unpaid", r.body?.quote?.extrasPayment);
    await call("POST", `/api/quotes/${U.qid}/confirm`, { token: cust.token });
    assert(extrasTransfers(U.a.id).length === 0 && balanceTransfers(U.a.id).length === 1, "Outsyde doesn't pay the vendor for unpaid extras", extrasTransfers(U.a.id));
    await qx.runQuoteExtrasJob(new Date());
    assert((await cardsOf(conv, "extras_reminder")).length === 0, "no reminder before 24 hours");
    await q(`UPDATE quote_extras_payments SET failed_notice_at = now() - interval '25 hours' WHERE id = $1`, [p.id]);
    await qx.runQuoteExtrasJob(new Date());
    await qx.runQuoteExtrasJob(new Date());
    const rem = await cardsOf(conv, "extras_reminder");
    assert(rem.length === 1 && rem[0].content === "Reminder: the extras, $108.00, are still unpaid. Pay for extras to finish your booking.", "one reminder after 24 hours", rem.map((m: any) => m.content));
    r = await call("POST", `/api/quotes/${U.qid}/extras/card`, { token: cust.token });
    const payNow = piStore[r.body?.paymentIntentId];
    assert(r.status === 200 && r.body?.captureMethod === "automatic" && payNow?.amount === 10800 && payNow.capture_method !== "manual", "Pay for extras charges now", r);
    payNow.status = "processing";
    const piCount = extrasPis().length;
    r = await call("POST", `/api/quotes/${U.qid}/extras/card`, { token: cust.token });
    assert(r.status === 409 && r.body?.code === "PROCESSING" && extrasPis().length === piCount && (await payOf(U.a.id)).stripe_payment_intent_id === payNow.id, "a second tap while it is processing never starts another payment (review I4)", r);
    await WebhookHandlers.handlePaymentIntentSucceeded(succeed(payNow.id));
    p = await payOf(U.a.id);
    const strayPaid = `pi_qb_stray_${Date.now()}`;
    piStore[strayPaid] = { id: strayPaid, object: "payment_intent", amount: 10800, amount_received: 10800, status: "succeeded", metadata: { type: "quote_extras", appointmentId: U.a.id }, customer: `cus_${cust.uid}` };
    const alertsBefore = alerts.length;
    await WebhookHandlers.handlePaymentIntentSucceeded({ ...piStore[strayPaid] });
    assert(alerts.length === alertsBefore + 1 && /not on record/.test(alerts[alerts.length - 1].subject) && (await payOf(U.a.id)).stripe_payment_intent_id === payNow.id, "a payment that isn't on record is flagged to Outsyde, never recorded over the real one", alerts.slice(alertsBefore));
    assert(p.status === "captured" && p.captured_cents === 10800 && p.payout_status === "held", "paid", p);
    await qw.runQuoteWindowJob(new Date());
    et = extrasTransfers(U.a.id);
    assert(et.length === 1 && et[0].amount === 9800, "then the vendor's share is paid (window already over)", et);
    assert((await pending("quote_extras", p.id)) || (await earned("quote_extras", p.id)) > 0, "and it earns points", await pending("quote_extras", p.id));

    console.log("\n── a cancel before Job complete lets the extras go ──");
    const C = await paidQuote();
    const c1 = (await propose(C.qid, "Disposal", 4000)).body?.extra;
    await approve(C.qid, c1.id);
    const c2 = (await propose(C.qid, "More disposal", 1000)).body?.extra;
    p = await payOf(C.a.id);
    const cPi = p.stripe_payment_intent_id;
    r = await call("POST", `/api/bookings/appointments/${C.a.id}/refund`, { token: owner.token, body: {} });
    p = await payOf(C.a.id);
    assert(r.status === 200 && piStore[cPi].status === "canceled" && p.status === "released", "the vendor cancels: the extras hold is released", { r: r.status, p });
    assert((await extraOf(c2.id)).status === "canceled" && (await extraOf(c1.id)).status === "approved", "an open extra is closed", [await extraOf(c2.id), await extraOf(c1.id)].map((x: any) => x.status));

    console.log("\n── a cancel that doesn't go through holds the extras again (review I2) ──");
    const K = await paidQuote();
    await approve(K.qid, (await propose(K.qid, "Hauling", 3000)).body?.extra.id);
    const kPi = (await payOf(K.a.id)).stripe_payment_intent_id;
    await qb.settleBalanceOnCancel(K.a.id, 0); // the cancel's refund then fails: the booking stays confirmed
    p = await payOf(K.a.id);
    assert(p.status === "released" && piStore[kPi].status === "canceled" && (await apptOf(K.qid)).status === "confirmed", "released for the cancel", p.status);
    await q(`UPDATE quote_extras_payments SET released_at = now() - interval '3 minutes' WHERE id = $1`, [p.id]);
    await qx.runQuoteExtrasJob(new Date());
    p = await payOf(K.a.id);
    assert(p.status === "held" && p.stripe_payment_intent_id !== kPi && piStore[p.stripe_payment_intent_id]?.amount === 3240 && piStore[p.stripe_payment_intent_id]?.off_session === "true", "the job holds them again off session", p);

    console.log("\n── a stuck extras claim never holds up the balance (review I3) ──");
    await q(`UPDATE quote_extras_payments SET status = 'holding', updated_at = now() WHERE id = $1`, [p.id]);
    r = await call("POST", `/api/bookings/appointments/${K.a.id}/refund`, { token: owner.token, body: {} });
    const jK = await jobOf(K.a.id);
    assert(r.status === 200 && (await apptOf(K.qid)).status === "canceled" && jK.balance_status === "released", "the vendor cancels: the balance is released even though the extras are busy", { r: r.status, b: jK.balance_status });
    await q(`UPDATE quote_extras_payments SET updated_at = now() - interval '15 minutes' WHERE id = $1`, [p.id]);
    const heldPi = p.stripe_payment_intent_id;
    await qx.runQuoteExtrasJob(new Date());
    p = await payOf(K.a.id);
    assert(p.status === "released" && piStore[heldPi].status === "canceled", "the job takes the stale claim over and lets every extras hold go", { s: p.status, pi: piStore[heldPi].status });

    console.log("\n── refunds come from the extras first, never the fee (B6) ──");
    const R = await paidQuote();
    await approve(R.qid, (await propose(R.qid, "Assembly", 10000)).body?.extra.id);
    await readyToComplete(R.a.id);
    await call("POST", `/api/quotes/${R.qid}/job-complete`, { token: owner.token });
    r = await call("POST", `/api/quotes/${R.qid}/report`, { token: cust.token, body: { reason: "The assembly was not done" } });
    p = await payOf(R.a.id);
    assert(r.status === 200 && p.payout_status === "paused", "a report pauses the extras payout too", p);
    const repR = (await q(`SELECT * FROM quote_reports WHERE appointment_id = $1`, [R.a.id]))[0];
    assert(repR?.held_cents === 10000 + BAL + DEP, "the report covers the extras, balance and deposit (business part)", repR?.held_cents);
    const rb = refunds.length;
    r = await call("PATCH", `/api/admin/refund-requests/${repR.refund_request_id}`, { token: admin.token, body: { status: "approved", outcome: "partial_refund", amountCents: 6000 } });
    p = await payOf(R.a.id);
    const newRefunds = refunds.slice(rb);
    assert(r.status === 200 && newRefunds.length === 1 && newRefunds[0].payment_intent === p.stripe_payment_intent_id && newRefunds[0].amount === 6000, "$60 back, all from the extras", newRefunds);
    // Review C1: the extras payout waits while refund recovery checks the refund; the balance (not refunded) is paid.
    const recsR = await q(`SELECT * FROM booking_refund_recoveries WHERE payment_intent_id = $1`, [p.stripe_payment_intent_id]);
    assert(p.refunded_cents === 6000 && extrasTransfers(R.a.id).length === 0 && recsR.length === 1 && recsR[0].status === "pending" && balanceTransfers(R.a.id)[0]?.amount === 53900,
      "the whole balance share is paid, the extras share waits for refund recovery", { p: p.refunded_cents, recs: recsR.map((x: any) => x.status), b: balanceTransfers(R.a.id) });
    const rec = await resolveBookingForTest(p.stripe_payment_intent_id);
    assert(rec?.group === `appointment_extras_${R.a.id}`, "recovery looks only at the extras transfer", rec);
    await q(`UPDATE booking_refund_recoveries SET refund_created_at = now() - interval '20 minutes', next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [recsR[0].id]);
    const { processBookingRecovery } = await import("../bookingRecoveries");
    assert(await processBookingRecovery(recsR[0].id) === "nothing_sent", "recovery closes it: nothing was sent yet");
    await qw.runQuoteWindowJob(new Date());
    et = extrasTransfers(R.a.id);
    assert(et.length === 1 && et[0].amount === 9800 - Math.round(9800 * 0.6), "then the vendor gets the extras share less their part", et);
    await qw.runQuoteWindowJob(new Date());
    assert(await earned("quote_extras", p.id) === Math.round((pointsForGrossCents(10800) * 4000) / 10000), "extras points follow the money", await earned("quote_extras", p.id));

    const R2 = await paidQuote();
    await approve(R2.qid, (await propose(R2.qid, "Assembly", 10000)).body?.extra.id);
    await readyToComplete(R2.a.id);
    await call("POST", `/api/quotes/${R2.qid}/job-complete`, { token: owner.token });
    await call("POST", `/api/quotes/${R2.qid}/report`, { token: cust.token, body: { reason: "Nothing was done right" } });
    const repR2 = (await q(`SELECT * FROM quote_reports WHERE appointment_id = $1`, [R2.a.id]))[0];
    const rb2 = refunds.length;
    r = await call("PATCH", `/api/admin/refund-requests/${repR2.refund_request_id}`, { token: admin.token, body: { status: "approved", outcome: "full_refund" } });
    p = await payOf(R2.a.id);
    const jR2 = await jobOf(R2.a.id);
    const fr = refunds.slice(rb2);
    assert(r.status === 200 && fr.length === 3 && fr[0].payment_intent === p.stripe_payment_intent_id && fr[0].amount === 10000 && fr[1].payment_intent === jR2.stripe_payment_intent_id && fr[1].amount === BAL && fr[2].amount === DEP,
      "full refund: extras, then balance, then deposit, every business dollar and no fee", fr.map((x) => [x.payment_intent, x.amount]));
    assert(p.payout_status === "canceled" && extrasTransfers(R2.a.id).length === 0, "the extras share is never paid", p);

    console.log("\n── a vendor refund after Job complete reaches the extras ──");
    const V = await paidQuote();
    await approve(V.qid, (await propose(V.qid, "Assembly", 10000)).body?.extra.id);
    await readyToComplete(V.a.id);
    await call("POST", `/api/quotes/${V.qid}/job-complete`, { token: owner.token });
    await call("POST", `/api/quotes/${V.qid}/confirm`, { token: cust.token });
    const rb3 = refunds.length;
    r = await call("POST", `/api/bookings/appointments/${V.a.id}/refund`, { token: owner.token, body: { amountCents: 70000 } });
    const vr = refunds.slice(rb3);
    p = await payOf(V.a.id);
    assert(r.status === 200 && r.body?.extrasRefundedCents === 10000 && r.body?.balanceRefundedCents === 55000 && r.body?.depositRefundedCents === 5000 && vr.length === 3, "extras first, then balance, then deposit", r.body);
    r = await call("POST", `/api/bookings/appointments/${V.a.id}/refund`, { token: owner.token, body: { amountCents: 5001 } });
    assert(r.status === 400, "never more than the business was paid ($750)", r);

    console.log("\n── money elsewhere knows the extras payment ──");
    const { resolveBooking } = await import("../bookingRecoveries");
    const { findSaleForTest } = await import("../stripe/stripeSync");
    const pE = await payOf(E.a.id);
    const rbk = await resolveBooking(pE.stripe_payment_intent_id);
    assert(rbk?.id === E.a.id && rbk.group === `appointment_extras_${E.a.id}` && rbk.base === 17000 && rbk.intendedPayout === 16660, "refund recovery takes back only from the extras transfer", rbk);
    const sale = await findSaleForTest(pE.stripe_payment_intent_id);
    assert(sale.kind === "appointment" && sale.id === E.a.id && (sale as any).balance === true, "a dashboard refund or dispute finds the booking", sale);
    await qb.recordBalanceRefund(pE.stripe_payment_intent_id, 1000, "re_dash");
    assert((await payOf(E.a.id)).refunded_cents === 1000, "and is recorded on the extras payment");
    const { computeHeld } = await import("../bankPayout");
    const held: any = await computeHeld();
    assert(typeof held?.breakdown?.quoteExtrasUnpaid === "number", "the bank payout guard counts extras still held", held?.breakdown);

    console.log("\n── step 6a: an extra reaches the customer (calls 2 to 5) and the business hears back (call 6) ──");
    const fs = await import("fs");
    const EXPO = process.env.QB_TEST_EXPO_FILE || "";
    await q(`UPDATE users SET expo_push_token = $2 WHERE id = $1`, [cust.uid, `ExponentPushToken[qx6c${P}]`]);
    const pushMark = () => (EXPO && fs.existsSync(EXPO) ? fs.readFileSync(EXPO, "utf8").length : 0);
    const notesOf = async (uid: string, type: string) => q(`SELECT * FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [uid, type]);
    const actionsFor = async (qid: string, token = cust.token) => {
      const res = await call("GET", "/api/me/quote-actions", { token });
      return { status: res.status, all: res.body?.actions ?? [], mine: (res.body?.actions ?? []).filter((a: any) => a.quoteId === qid) };
    };
    /** The customer's row is added in the background after the send: wait for it (3 s at most). */
    const rowLanded = async (extraId: string) => {
      for (let i = 0; i < 30; i++) {
        if ((await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'quote_extra' AND reference_id = $2`, [cust.uid, extraId])).length) return true;
        await new Promise((res) => setTimeout(res, 100));
      }
      return false;
    };
    const N = await paidQuote();
    let paidRows = await notesOf(owner.uid, "quote_paid");
    paidRows = paidRows.filter((n: any) => n.reference_id === N.qid);
    assert(paidRows.length === 1 && paidRows[0].title === "Quote paid" && /^.+ paid for 2 Bedroom Move\. It's booked\.$/.test(paidRows[0].message) && paidRows[0].metadata?.conversationId === conv && paidRows[0].metadata?.quoteId === N.qid,
      "the business: Quote paid in Activity", paidRows);
    assert(!noticePushes.some((p) => p.userId === owner.uid && p.data?.quoteId === N.qid), "no extra push for paid (the paid card already pushed)", noticePushes.filter((p) => p.userId === owner.uid));
    let pm = pushMark();
    const n1 = (await propose(N.qid, "2 extra hours", 10000)).body?.extra;
    await new Promise((res) => setTimeout(res, 800));
    if (EXPO) {
      const pushed = fs.readFileSync(EXPO, "utf8").slice(pm);
      assert(pushed.includes("Needs your OK: 2 extra hours, $108.00 with the service fee. Nothing is charged unless you approve.") && pushed.includes('"type":"new_message"') && pushed.includes(conv),
        "the push: its own words, still a message push to the chat", pushed.slice(0, 500));
    } else assert(false, "the push words need QB_TEST_EXPO_FILE (the Expo stub file)");
    let cRows = (await notesOf(cust.uid, "quote_extra")).filter((n: any) => n.reference_id === n1.id);
    assert(cRows.length === 1 && cRows[0].reference_id === n1.id && cRows[0].title === "Movers a" && cRows[0].message === "Added 2 extra hours to 2 Bedroom Move. $108.00 with the service fee, only if you approve."
      && cRows[0].metadata?.quoteId === N.qid && cRows[0].metadata?.extraId === n1.id && cRows[0].metadata?.conversationId === conv && cRows[0].is_read === false,
      "the customer's Activity row", cRows);
    let A6 = await actionsFor(N.qid);
    assert(A6.status === 200 && A6.mine.length === 1 && A6.mine[0].kind === "approve_extra" && A6.mine[0].extraId === n1.id && A6.mine[0].totalCents === 10800 && A6.mine[0].serviceFeeCents === 800
      && A6.mine[0].businessName === "Movers a" && A6.mine[0].conversationId === conv && A6.mine[0].title === "2 Bedroom Move", "the pop-up list has it", A6);
    const strangerList = await actionsFor(N.qid, stranger.token);
    assert(strangerList.status === 200 && strangerList.all.length === 0, "someone else gets only their own (empty) list", strangerList);
    assert((await call("GET", "/api/me/quote-actions")).status === 401, "signed out: 401");
    let mq = (await call("GET", "/api/me/quotes", { token: cust.token })).body?.quotes?.find((x: any) => x.id === N.qid);
    assert(mq && mq.extras?.[0]?.id === n1.id && mq.extras[0].canApprove === true && mq.extras[0].canWithdraw === false && mq.balance?.holdCents > 0 && "window" in mq && "report" in mq && "extrasPayment" in mq && mq.payout == null && mq.business === undefined,
      "my quotes carry the balance, window, report and extras (customer view, no payout)", mq);
    const sentOnly = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72, minutes: 180 });
    mq = (await call("GET", "/api/me/quotes", { token: cust.token })).body?.quotes?.find((x: any) => x.id === sentOnly.qid);
    assert(mq && mq.status === "sent" && mq.balance === null && mq.window === null && Array.isArray(mq.extras) && mq.extras.length === 0, "an unpaid quote: the same fields, empty", mq);

    let r6 = await approve(N.qid, n1.id);
    assert(r6.status === 200, "approved", r6);
    assert((await notesOf(cust.uid, "quote_extra")).find((n: any) => n.reference_id === n1.id)?.is_read === true, "answered: the customer's row is done");
    let bRows = (await notesOf(owner.uid, "quote_extra_approved")).filter((n: any) => n.reference_id === n1.id);
    assert(bRows.length === 1 && / approved 2 extra hours, \$100\.00\.$/.test(bRows[0].message) && bRows[0].metadata?.conversationId === conv, "the business: Extra approved", bRows);
    assert((await actionsFor(N.qid)).mine.length === 0, "and it leaves the pop-up list");
    mq = (await call("GET", "/api/me/quotes", { token: cust.token })).body?.quotes?.find((x: any) => x.id === N.qid);
    assert(mq?.extrasPayment && mq.extrasPayment.approvedCents === 10000 && !("payout" in mq.extrasPayment), "the extras payment shows, with no payout for the customer", mq?.extrasPayment);
    const n2 = (await propose(N.qid, "Boxes", 1000)).body?.extra;
    assert(await rowLanded(n2.id), "Boxes: the row lands");
    r6 = await call("POST", `/api/quotes/${N.qid}/extras/${n2.id}/decline`, { token: cust.token });
    assert(r6.status === 200 && (await notesOf(cust.uid, "quote_extra")).find((n: any) => n.reference_id === n2.id)?.is_read === true, "declined: done", r6);
    bRows = (await notesOf(owner.uid, "quote_extra_declined")).filter((n: any) => n.reference_id === n2.id);
    assert(bRows.length === 1 && / declined Boxes\. Nothing was added\.$/.test(bRows[0].message), "the business: Extra declined", bRows);
    const n3 = (await propose(N.qid, "Tape", 500)).body?.extra;
    assert(await rowLanded(n3.id), "Tape: the row lands");
    r6 = await call("POST", `/api/quotes/${N.qid}/extras/${n3.id}/withdraw`, { token: owner.token });
    assert(r6.status === 200 && (await notesOf(cust.uid, "quote_extra")).find((n: any) => n.reference_id === n3.id)?.is_read === true, "withdrawn: done", r6);
    assert((await notesOf(owner.uid, "quote_extra_declined")).every((n: any) => n.reference_id !== n3.id), "a withdraw tells the business nothing (they did it)");
    const n4 = (await propose(N.qid, "Shelf", 700)).body?.extra;
    assert(await rowLanded(n4.id), "Shelf: the row lands");
    await q(`UPDATE quote_extras SET status = 'lapsed' WHERE id = $1`, [n4.id]);
    await qx.runQuoteExtrasJob(new Date());
    assert((await notesOf(cust.uid, "quote_extra")).find((n: any) => n.reference_id === n4.id)?.is_read === true, "closed some other way (lapsed): the job marks it done");
    const canceledRows = (await notesOf(cust.uid, "quote_extra")).filter((n: any) => n.reference_id === c1.id || n.reference_id === c2.id);
    assert(canceledRows.length === 2 && canceledRows.every((n: any) => n.is_read === true), "extras canceled with the booking: done too", canceledRows);

    console.log("\n── step 6a: the extra's email (call 3), once ──");
    const mkExtra = async (desc: string, cents: number) => (await q(`INSERT INTO quote_extras (appointment_id, quote_id, business_id, customer_id, proposed_by, description, amount_cents) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [N.a.id, N.qid, biz, cust.uid, owner.uid, desc, cents]))[0];
    const [Nq] = await q(`SELECT * FROM quotes WHERE id = $1`, [N.qid]);
    const quoteRow = { ...Nq, id: Nq.id, conversationId: Nq.conversation_id, customerId: Nq.customer_id, senderId: Nq.sender_id, businessId: Nq.business_id, title: Nq.title, totalCents: Nq.total_cents, linkCode: Nq.link_code, appointmentId: Nq.appointment_id } as any;
    const asExtra = (x: any) => ({ id: x.id, description: x.description, amountCents: x.amount_cents, appointmentId: x.appointment_id }) as any;
    const before = process.env.QUOTE_EMAILS_ENABLED;
    delete process.env.QUOTE_EMAILS_ENABLED;
    const e1 = await mkExtra("Ladder", 2000);
    await qnot.noticeExtraProposed(quoteRow, asExtra(e1));
    assert(noticeEmails.length === 0 && (await notesOf(cust.uid, "quote_extra")).some((n: any) => n.reference_id === e1.id), "quote emails off: the row, no email", noticeEmails.length);
    process.env.QUOTE_EMAILS_ENABLED = "true";
    const e2 = await mkExtra("Piano", 15000);
    await qnot.noticeExtraProposed(quoteRow, asExtra(e2));
    await qnot.noticeExtraProposed(quoteRow, asExtra(e2));
    assert(noticeEmails.length === 1 && noticeEmails[0].to === `${cust.uid}@qx.test` && noticeEmails[0].subject === "Movers a needs your OK for Piano" && noticeEmails[0].text.includes(`/q/${Nq.link_code}`)
      && noticeEmails[0].text.includes("$150.00") && noticeEmails[0].text.includes("New total before fees: $"), "on: one email with the link, never twice", noticeEmails);
    assert((await notesOf(cust.uid, "quote_extra")).filter((n: any) => n.reference_id === e2.id).length === 1, "and one row");
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [cust.uid, owner.uid]);
    const e3 = await mkExtra("Rug", 900);
    await qnot.noticeExtraProposed(quoteRow, asExtra(e3));
    assert(noticeEmails.length === 1 && !(await notesOf(cust.uid, "quote_extra")).some((n: any) => n.reference_id === e3.id), "blocked either way: nothing", noticeEmails.length);
    await q(`DELETE FROM user_blocks WHERE blocker_id = $1`, [cust.uid]);
    // Review I3: an extra answered before its notice ran never gets an "only if you approve" row or email.
    const e4 = await mkExtra("Dolly", 800);
    await q(`UPDATE quote_extras SET status = 'approved' WHERE id = $1`, [e4.id]);
    await qnot.noticeExtraProposed(quoteRow, asExtra(e4));
    assert(noticeEmails.length === 1 && !(await notesOf(cust.uid, "quote_extra")).some((n: any) => n.reference_id === e4.id), "already answered: no row, no email", noticeEmails.length);
    await q(`UPDATE quote_extras SET status = 'withdrawn' WHERE id = $1`, [e4.id]);
    // A sender that throws never throws into the money step.
    qnot.setQuoteNoticeDepsForTest({ sendPush: async () => { throw new Error("push down"); }, sendEmail: async () => { throw new Error("email down"); } });
    const e5 = await mkExtra("Hand truck", 600);
    let threw = false;
    try { await qnot.noticeExtraProposed(quoteRow, asExtra(e5)); await qnot.noticeBusiness(quoteRow, "card_failed", `t-${e5.id}`.slice(0, 36), { amountCents: 600 }); } catch { threw = true; }
    assert(!threw && (await notesOf(cust.uid, "quote_extra")).some((n: any) => n.reference_id === e5.id), "email and push failures are swallowed, the row still lands");
    qnot.setQuoteNoticeDepsForTest({ sendPush: async (p) => { noticePushes.push(p); return true; }, sendEmail: async (m) => { noticeEmails.push(m); return true; } });
    await q(`UPDATE quote_extras SET status = 'withdrawn' WHERE id = $1`, [e5.id]);
    // A staff member who no longer works there: the owner hears it instead.
    await q(`UPDATE staff_members SET status = 'removed' WHERE id = $1`, [staffId]);
    await qnot.noticeBusiness({ ...quoteRow, staffMemberId: staffId, senderId: staffUser.uid }, "problem_reported", `staffgone-${qn}`);
    assert((await notesOf(owner.uid, "quote_problem_reported")).some((n: any) => n.reference_id === `staffgone-${qn}`) && !(await notesOf(staffUser.uid, "quote_problem_reported")).some((n: any) => n.reference_id === `staffgone-${qn}`),
      "removed staff: the owner gets the row");
    await q(`UPDATE staff_members SET status = 'active' WHERE id = $1`, [staffId]);
    if (before === undefined) delete process.env.QUOTE_EMAILS_ENABLED; else process.env.QUOTE_EMAILS_ENABLED = before;
    await q(`UPDATE quote_extras SET status = 'withdrawn' WHERE id = ANY($1)`, [[e1.id, e2.id, e3.id]]);

    console.log("\n── step 6a: card couldn't be held (call 6), a push only here ──");
    const pG = await payOf(G.a.id);
    const failRows = (await notesOf(owner.uid, "quote_card_failed")).filter((n: any) => n.reference_id === pG.id);
    assert(failRows.length === 1 && /^We couldn't hold .+'s card for 2 Bedroom Move, \$[0-9.,]+\. We asked them to update it\.$/.test(failRows[0].message) && failRows[0].metadata?.conversationId === conv,
      "the business: card couldn't be held (extras), once", failRows);
    const failPush = noticePushes.filter((p) => p.userId === owner.uid && p.data?.quoteId === G.qid);
    assert(failPush.length === 1 && failPush[0].data?.type === "new_message" && failPush[0].data?.conversationId === conv && failPush[0].body === failRows[0].message, "and one push that opens the chat", failPush);

    console.log("\n── step 6a: a report tells the business in Activity (call 6) ──");
    // N's booking out of the way of the next jobs' times (as Job complete's set up does).
    await q(`UPDATE appointments SET appointment_date = $2 WHERE id = $1`, [N.a.id, ymdNY(new Date(Date.now() - 30 * 24 * H))]);
    await q(`UPDATE provider_blocks SET start_at = start_at - interval '30 days', end_at = end_at - interval '30 days' WHERE appointment_id = $1`, [N.a.id]);
    const Rp = await completed();
    r6 = await call("POST", `/api/quotes/${Rp.qid}/report`, { token: cust.token, body: { reason: "The crew scratched the floor" } });
    assert(r6.status === 200 || r6.status === 201, "reported", r6);
    const repRows = (await notesOf(owner.uid, "quote_problem_reported")).filter((n: any) => n.reference_id === Rp.qid);
    assert(repRows.length === 1 && / reported a problem with 2 Bedroom Move\. Your payout for this job is paused while Outsyde reviews it\.$/.test(repRows[0].message), "the business: Problem reported", repRows);
    A6 = await actionsFor(Rp.qid);
    assert(A6.mine.length === 0, "reported: Confirm or Report leaves the list", A6.mine);
    const Cf = await completed();
    A6 = await actionsFor(Cf.qid);
    assert(A6.mine.length === 1 && A6.mine[0].kind === "confirm_or_report" && !!A6.mine[0].endsAt, "a job just completed: Confirm or Report is waiting", A6.mine);
  } finally {
    await q(`DELETE FROM quote_extras_payments WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM quote_extras WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM quote_refunds WHERE appointment_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);

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
