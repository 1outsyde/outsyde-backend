/**
 * Quotes step 4a (migration 099): balance hold, Job complete, cancels and refunds of both payments, recovery,
 * Stripe sync, held money and revenue. HTTP + webhook + job integration tests.
 *
 * Legend 2026-11-04 (final): each payment carries the service fee and the 2% on its own amount; the balance + its
 * fee is held off session on the saved card 24 h before (right after payment when sooner), retried 12 h before,
 * then an "Update your card" card; Job complete by the owner or the sending staff member, or 2 h after the end;
 * capture at Job complete, the vendor's share held by Outsyde (paid in 4b); every cancel releases the hold (or
 * takes only what is owed) and every refund can reach the balance payment too.
 *
 * Run with: npx tsx server/quotes/quoteBalance.http.test.ts
 *
 * SCRATCH ONLY. Same setup as quotePayments.http.test.ts (migrations through 099):
 *   QB_TEST_BASE_URL, QB_TEST_PG_URL, QB_TEST_STRIPE_PORT, JWT_SECRET, plus DATABASE_URL and
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" for this process too.
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
  let declineNextOffSession = 0;
  let loseNextBalanceReply = false;
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
        const pi = piStore[flat.payment_intent || ""];
        const amount = Number(flat.amount || (pi ? pi.amount_received - (pi._refunded || 0) : 0));
        if (pi) pi._refunded = (pi._refunded || 0) + amount;
        const r = { id: `re_qb_${refunds.length + 1}`, object: "refund", amount, payment_intent: flat.payment_intent, status: "succeeded", metadata: meta(), created: Math.floor(Date.now() / 1000) };
        refunds.push(r);
        return send(200, r);
      }
      if (req.method === "GET" && url.pathname === "/v1/refunds") return send(200, { object: "list", data: refunds.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
      if (req.method === "POST" && url.pathname === "/v1/transfers") {
        const t = { id: `tr_qb_${transfers.length + 1}`, object: "transfer", amount: Number(flat.amount), destination: flat.destination, transfer_group: flat.transfer_group, metadata: meta(), amount_reversed: 0, reversals: { data: [] } };
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
  const balancePis = () => piCreates.filter((c) => c.metadata.type === "quote_balance");

  const { WebhookHandlers } = await import("../stripe/webhookHandlers");
  const qb = await import("./quoteBalance");
  const { resolveBooking } = await import("../bookingRecoveries");
  const { findSaleForTest } = await import("../stripe/stripeSync");
  const { computeHeld } = await import("../bankPayout");

  const P = `qb${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const bizs: string[] = [];
  const mkUser = async (key: string, first = "Ana", admin = false) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, first_name, last_name, name, stripe_customer_id, is_admin) VALUES ($1::varchar, $1::text, $2, $3, 'Tester', $3, $4, $5)`, [uid, `${uid}@qb.test`, first, `cus_${uid}`, admin]);
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

  try {
    console.log("\n── paying a deposit quote schedules the balance (split rule) ──");
    const A = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72, minutes: 180 });
    const a1 = await payQuote(A.qid, cust.token);
    let j1 = await jobOf(a1.id);
    assert(a1.status === "confirmed" && !!j1, "a paid service quote gets a job record", { a1: a1?.status, j1 });
    assert(j1?.balance_cents === 55000 && j1?.service_fee_cents === 4400 && j1?.platform_fee_cents === 1100 && j1?.vendor_net_cents === 53900 && j1?.hold_cents === 59400,
      "balance $550 + $44 service fee held, the vendor gets $539", j1);
    assert(j1?.balance_status === "scheduled" && Math.abs(new Date(j1.hold_at).getTime() - (A.startsAt.getTime() - 24 * H)) < 1000, "held 24 h before the job, not yet", j1);
    assert(Math.abs(new Date(j1.retry_at).getTime() - (A.startsAt.getTime() - 12 * H)) < 1000, "retry 12 h before", j1?.retry_at);
    assert(Math.abs(new Date(j1.auto_complete_at).getTime() - (A.startsAt.getTime() + 5 * H)) < 1000, "auto complete 2 h after the scheduled end", j1?.auto_complete_at);
    assert(balancePis().length === 0, "nothing held yet");
    let r = await call("GET", `/api/quotes/${A.qid}`, { token: cust.token });
    assert(r.body?.quote?.balance?.status === "scheduled" && r.body.quote.balance.holdCents === 59400, "the quote shows the balance and when it is held", r.body?.quote?.balance);
    assert(r.body?.quote?.amounts?.balanceServiceFeeCents === 4400 && r.body.quote.amounts.balanceTotalCents === 59400, "quote amounts show the balance fee (additive)", r.body?.quote?.amounts);
    r = await call("GET", `/api/business/appointments`, { token: owner.token });
    const row = (r.body?.appointments ?? r.body ?? []).find?.((x: any) => x.id === a1.id);
    assert(row && row.inPersonDueCents === 0 && row.dueAtAppointmentCents === 0, "no pay at appointment line for quote bookings", row && { in: row.inPersonDueCents, due: row.dueAtAppointmentCents });

    console.log("\n── the hold, 24 h before ──");
    await qb.runQuoteBalanceJob(new Date());
    assert(balancePis().length === 0, "not due: the job does nothing");
    await shiftJob(a1.id, 49);
    await Promise.all([qb.runQuoteBalanceJob(new Date()), qb.runQuoteBalanceJob(new Date())]);
    j1 = await jobOf(a1.id);
    const bp = balancePis();
    assert(bp.length === 1, "two job runs at once make one hold", bp.length);
    assert(bp[0]?.amount === 59400 && bp[0].form.capture_method === "manual" && bp[0].form.off_session === "true" && bp[0].form.confirm === "true", "manual capture, off session, balance + fee", bp[0]?.form);
    assert(bp[0]?.metadata.appointmentId === a1.id && bp[0].metadata.quoteId === A.qid && !("orderId" in bp[0].metadata), "own metadata type, never appointment, no order id", bp[0]?.metadata);
    assert(bp[0]?.form.payment_method === piStore[a1.stripe_payment_intent_id]?.payment_method && bp[0]?.form.customer === `cus_${cust.uid}`, "the card saved at the deposit", bp[0]?.form);
    assert(!!bp[0]?.key && bp[0].key.includes(a1.id), "key per try", bp[0]?.key);
    assert(j1.balance_status === "held" && j1.stripe_payment_intent_id === Object.keys(piStore).find((k) => piStore[k]._key === bp[0].key), "balance held, payment recorded", j1);
    assert((await cardsOf(conv, "balance_held")).length === 1, "a balance held card in Messages");
    await qb.runQuoteBalanceJob(new Date());
    assert(balancePis().length === 1 && (await cardsOf(conv, "balance_held")).length === 1, "a later run does nothing more");
    const [heldNow] = [await computeHeld()];
    assert(typeof heldNow?.breakdown === "object", "held money still computes", heldNow);

    console.log("\n── Job complete ──");
    r = await call("POST", `/api/quotes/${A.qid}/job-complete`, { token: stranger.token });
    assert(r.status === 404, "a stranger can't", r);
    r = await call("POST", `/api/quotes/${A.qid}/job-complete`, { token: cust.token });
    assert(r.status === 404, "the customer can't", r);
    r = await call("POST", `/api/quotes/${A.qid}/job-complete`, { token: owner.token });
    assert(r.status === 409 && r.body?.code === "NOT_STARTED", "not before the job starts", r);
    await shiftJob(a1.id, 24);
    await q(`UPDATE appointments SET appointment_date = $2 WHERE id = $1`, [a1.id, ymdNY(new Date(Date.now() - 2 * H))]);
    r = await call("POST", `/api/quotes/${A.qid}/job-complete`, { token: owner.token });
    j1 = await jobOf(a1.id);
    const a1c = await apptOf(A.qid);
    assert(r.status === 200 && r.body?.status === "completed", "the owner marks it complete", r);
    assert(a1c.status === "completed", "booking completed (no new status)", a1c.status);
    const cap = captures.find((c) => c.id === j1.stripe_payment_intent_id);
    assert(!!cap && (cap.amount_to_capture === null || cap.amount_to_capture === 59400) && !!cap.key, "balance + fee captured with a key", cap);
    assert(j1.balance_status === "captured" && j1.captured_cents === 59400 && j1.payout_status === "held" && j1.completed_via === "owner", "captured, the vendor's share held for 4b", j1);
    assert(!transfers.some((t) => t.transfer_group === `appointment_balance_${a1.id}`), "no balance payout in 4a");
    r = await call("POST", `/api/quotes/${A.qid}/job-complete`, { token: owner.token });
    assert(r.status === 409 && r.body?.code === "ALREADY_COMPLETE" && captures.length === 1, "a second tap does nothing", r);
    const held = await computeHeld();
    assert(held.breakdown.quoteBalanceUnpaid >= 59400, "captured, unpaid balance money counts as held", held.breakdown);
    const rb = await resolveBooking(j1.stripe_payment_intent_id);
    assert(rb?.type === "appointment" && rb.id === a1.id && rb.base === 55000 && rb.intendedPayout === 53900 && rb.group === `appointment_balance_${a1.id}`, "refund recovery finds the booking by its balance payment", rb);
    const sale = await findSaleForTest(j1.stripe_payment_intent_id);
    assert(sale?.kind === "appointment" && sale.id === a1.id && sale.balance === true, "Stripe sync and disputes find it too", sale);
    const { db: appDb } = await import("../db");
    const { sql: dsql } = await import("drizzle-orm");
    const { appointmentRevenueAmountSql: bookingRevenueAmountSql } = await import("../revenue");
    const revRes: any = await appDb.execute(dsql`SELECT ${bookingRevenueAmountSql} AS v FROM appointments WHERE id = ${a1.id}`);
    const rev = (revRes?.rows ?? revRes)[0];
    assert(Number(rev?.v) === 65000, "revenue counts the deposit and the captured balance", rev);

    console.log("\n── refunds after Job complete reach the balance payment ──");
    r = await call("POST", `/api/bookings/appointments/${a1.id}/refund`, { token: owner.token, body: { amountCents: 60000, reason: "Damaged a lamp" } });
    j1 = await jobOf(a1.id);
    const balRefund = refunds.find((x) => x.payment_intent === j1.stripe_payment_intent_id);
    const depRefund = refunds.find((x) => x.payment_intent === a1.stripe_payment_intent_id);
    assert(r.status === 200 && balRefund?.amount === 55000 && depRefund?.amount === 5000, "a $600 refund: $550 from the balance, $50 from the deposit", { r, balRefund, depRefund });
    const a1r = await apptOf(A.qid);
    assert(a1r.status === "completed" && a1r.refund_amount === 60000, "stays completed, refund recorded (no silent failed cancel)", { s: a1r.status, ra: a1r.refund_amount });
    assert(j1.refunded_cents === 55000, "balance refund recorded on the job", j1.refunded_cents);
    r = await call("POST", `/api/bookings/appointments/${a1.id}/refund`, { token: owner.token, body: { amountCents: 10000 } });
    assert(r.status === 400 && r.body?.code === "REFUND_TOO_LARGE", "never more than was paid", r);

    console.log("\n── staff Job complete, and PATCH complete routes quote bookings ──");
    const S = await mkQuote({ biz, sender: staffUser.uid, customer: cust.uid, conv: convStaff, hoursOut: 10, staffId });
    const aS = await payQuote(S.qid, cust.token);
    let jS = await jobOf(aS.id);
    assert(jS?.balance_status === "held", "job less than 24 h away: held right after payment", jS);
    await shiftJob(aS.id, 11);
    r = await call("PATCH", `/api/bookings/appointments/${aS.id}/complete`, { token: staffUser.token });
    assert(r.status === 403, "PATCH complete stays owner only", r);
    r = await call("POST", `/api/quotes/${S.qid}/job-complete`, { token: staffUser.token });
    jS = await jobOf(aS.id);
    assert(r.status === 200 && jS.completed_via === "staff" && jS.balance_status === "captured", "the staff member who sent it can mark it complete", { r, jS });

    const PQ = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 9 });
    const aP = await payQuote(PQ.qid, cust.token);
    await shiftJob(aP.id, 10);
    r = await call("PATCH", `/api/bookings/appointments/${aP.id}/complete`, { token: owner.token });
    const jP = await jobOf(aP.id);
    assert(r.status === 200 && r.body?.success === true && r.body?.status === "completed" && jP.balance_status === "captured", "the site dashboards' Mark Complete charges the balance for quote bookings", { r, jP });

    console.log("\n── auto complete 2 h after the end ──");
    const AU = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 8, deposit: null, total: 30000 });
    const aAU = await payQuote(AU.qid, cust.token);
    let jAU = await jobOf(aAU.id);
    assert(jAU?.balance_status === "none" && jAU.hold_cents === 0, "paid in full: nothing to hold", jAU);
    await qb.runQuoteBalanceJob(new Date());
    assert((await apptOf(AU.qid)).status === "confirmed", "not before the time");
    await shiftJob(aAU.id, 14);
    await qb.runQuoteBalanceJob(new Date());
    jAU = await jobOf(aAU.id);
    assert((await apptOf(AU.qid)).status === "completed" && jAU.completed_via === "auto", "completed on its own 2 h after the end", jAU);

    console.log("\n── a hold that fails: retry, then Update your card ──");
    const F = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72 });
    const aF = await payQuote(F.qid, cust.token);
    await shiftJob(aF.id, 51);
    declineNextOffSession = 1;
    await qb.runQuoteBalanceJob(new Date());
    let jF = await jobOf(aF.id);
    assert(jF.balance_status === "hold_failed" && jF.retry_at && (await cardsOf(conv, "balance_failed")).length === 0, "first decline: waits for the retry, no card yet", jF);
    await qb.runQuoteBalanceJob(new Date());
    assert(balancePis().filter((c) => c.metadata.appointmentId === aF.id).length === 1, "no retry before 12 h before");
    await shiftJob(aF.id, 12);
    declineNextOffSession = 1;
    await qb.runQuoteBalanceJob(new Date());
    jF = await jobOf(aF.id);
    const failCards = await cardsOf(conv, "balance_failed");
    assert(jF.balance_status === "hold_failed" && jF.retry_at === null && failCards.length === 1, "retry declines too: one Update your card card", { jF, n: failCards.length });
    assert(failCards[0] && !/ - | — | – |8%/.test(failCards[0].content), "card text reads plainly, no fee rate", failCards[0]?.content);
    await qb.runQuoteBalanceJob(new Date());
    assert((await cardsOf(conv, "balance_failed")).length === 1, "posted once");
    await shiftJob(aF.id, 12);
    r = await call("POST", `/api/quotes/${F.qid}/job-complete`, { token: owner.token });
    assert(r.status === 409 && r.body?.code === "BALANCE_NOT_HELD", "the balance isn't held: can't be completed", r);
    await shiftJob(aF.id, 6);
    await qb.runQuoteBalanceJob(new Date());
    assert((await apptOf(F.qid)).status === "confirmed", "auto complete skips it too");
    r = await call("POST", `/api/quotes/${F.qid}/balance/card`, { token: stranger.token });
    assert(r.status === 404, "only the customer updates the card", r);
    r = await call("POST", `/api/quotes/${F.qid}/balance/card`, { token: cust.token, body: { paymentSheet: true } });
    const cardPi = piStore[r.body?.paymentIntentId];
    assert(r.status === 200 && typeof r.body?.clientSecret === "string" && cardPi?.capture_method === "manual" && cardPi.amount === 59400 && cardPi.metadata.type === "quote_balance" && cardPi.setup_future_usage === "off_session",
      "Update your card: a manual capture payment for the balance with a new card", { r, cardPi });
    cardPi.status = "requires_capture"; cardPi.amount_capturable = cardPi.amount;
    await WebhookHandlers.handlePaymentIntentCapturableUpdated({ ...cardPi });
    jF = await jobOf(aF.id);
    assert(jF.balance_status === "held" && jF.stripe_payment_intent_id === cardPi.id, "the new card holds the balance", jF);

    console.log("\n── a lost Stripe reply never holds twice ──");
    const L = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 72 });
    const aL = await payQuote(L.qid, cust.token);
    await shiftJob(aL.id, 51);
    loseNextBalanceReply = true;
    await qb.runQuoteBalanceJob(new Date());
    let jL = await jobOf(aL.id);
    assert(jL.balance_status === "holding", "outcome unknown: left for the lookup", jL);
    await q(`UPDATE quote_jobs SET updated_at = now() - interval '11 minutes' WHERE id = $1`, [jL.id]);
    await qb.runQuoteBalanceJob(new Date());
    jL = await jobOf(aL.id);
    assert(jL.balance_status === "held" && balancePis().filter((c) => c.metadata.appointmentId === aL.id).length === 1, "found at Stripe: recorded, never held twice", jL);

    console.log("\n── cancels release the hold ──");
    // Customer cancel after the hold: deposit kept, nothing owed, hold released.
    let r2 = await call("POST", `/api/bookings/appointments/${aL.id}/cancel`, { token: cust.token });
    jL = await jobOf(aL.id);
    assert(r2.status === 200 && jL.balance_status === "released" && piStore[jL.stripe_payment_intent_id].status === "canceled", "customer cancel: hold released", { r2, jL });
    assert((await apptOf(L.qid)).status === "canceled" && !refunds.some((x) => x.payment_intent === aL.stripe_payment_intent_id), "deposit kept", null);

    // Vendor refund on a confirmed, held booking: everything back, hold released.
    const V = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 20 });
    const aV = await payQuote(V.qid, cust.token);
    r2 = await call("POST", `/api/bookings/appointments/${aV.id}/refund`, { token: owner.token, body: {} });
    const jV = await jobOf(aV.id);
    assert(r2.status === 200 && jV.balance_status === "released" && (await apptOf(V.qid)).status === "canceled", "vendor refund before the job: hold released, booking canceled", { r2, jV });

    // No show (both routes) and late cancel.
    for (const [path, body] of [["cancel-no-refund", { reason: "No show" }], ["status", { status: "no_show" }], ["status", { status: "late_cancel" }]] as const) {
      const N = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 20 });
      const aN = await payQuote(N.qid, cust.token);
      const method = path === "status" ? "PATCH" : "POST";
      r2 = await call(method, `/api/bookings/appointments/${aN.id}/${path}`, { token: owner.token, body });
      const jN = await jobOf(aN.id);
      assert(r2.status === 200 && jN.balance_status === "released", `${path} ${JSON.stringify(body)}: hold released`, { r2, jN });
    }

    // Bulk cancel of the day.
    const B = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 20 });
    const aB = await payQuote(B.qid, cust.token);
    r2 = await call("POST", `/api/vendor/bookings/bulk-cancel-by-date`, { token: owner.token, body: { date: aB.appointment_date, reason: "Truck broke down" } });
    const jB = await jobOf(aB.id);
    assert(r2.status === 200 && jB.balance_status === "released", "bulk cancel: hold released", { r2, jB });

    // Admin approves a refund request on a completed quote booking larger than the deposit.
    const AD = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 9 });
    const aAD = await payQuote(AD.qid, cust.token);
    await shiftJob(aAD.id, 13);
    await call("POST", `/api/quotes/${AD.qid}/job-complete`, { token: owner.token });
    const [rr] = await q(`INSERT INTO refund_requests (id, requester_id, requester_type, target_type, target_id, reason, amount, status) VALUES ($1, $2, 'customer', 'appointment', $3, 'Movers late', 30000, 'pending') RETURNING id`, [id("rr1"), cust.uid, aAD.id]);
    r2 = await call("PATCH", `/api/admin/refund-requests/${rr.id}`, { token: admin.token, body: { status: "approved" } });
    const jAD = await jobOf(aAD.id);
    assert(r2.status === 200 && refunds.some((x) => x.payment_intent === jAD.stripe_payment_intent_id && x.amount === 30000), "admin refund of a completed quote comes from the balance payment", { r2, jAD });

    // Orphan sweep: a held balance on a booking that ended by a path that skipped the release.
    const O = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 20 });
    const aO = await payQuote(O.qid, cust.token);
    await q(`UPDATE appointments SET status = 'canceled' WHERE id = $1`, [aO.id]);
    await qb.runQuoteBalanceJob(new Date());
    const jO = await jobOf(aO.id);
    assert(jO.balance_status === "released" && piStore[jO.stripe_payment_intent_id].status === "canceled", "a hold on an ended booking is released by the job", jO);

    // Stripe cancels a hold (expired authorization or dashboard).
    const X = await mkQuote({ biz, sender: owner.uid, customer: cust.uid, conv, hoursOut: 20 });
    const aX = await payQuote(X.qid, cust.token);
    let jX = await jobOf(aX.id);
    piStore[jX.stripe_payment_intent_id].status = "canceled";
    await WebhookHandlers.handlePaymentIntentCanceled({ ...piStore[jX.stripe_payment_intent_id] });
    jX = await jobOf(aX.id);
    assert(jX.balance_status === "hold_failed" && (await apptOf(X.qid)).status === "confirmed", "a hold Stripe let go reads as not held (Update your card)", jX);

    console.log("\n── a dashboard refund of the balance payment ──");
    const { applyRefundForTest } = await import("../stripe/stripeSync") as any;
    const jDs = await jobOf(aS.id);
    await applyRefundForTest({ refundId: `re_dash_${P}`, amount: 10000, pi: jDs.stripe_payment_intent_id, chargeId: `ch_${jDs.stripe_payment_intent_id}`, full: false, createdUnix: Math.floor(Date.now() / 1000) });
    const jDs2 = await jobOf(aS.id);
    const aSr = await apptOf(S.qid);
    assert(jDs2.refunded_cents === 10000 && aSr.status === "completed" && aSr.refund_amount === 10000, "recorded on the balance and the booking, status untouched", { jDs2, s: aSr.status });
  } finally {
    const ids = users;
    await q(`DELETE FROM quote_jobs WHERE business_id = ANY($1)`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM refund_requests WHERE requester_id = ANY($1)`, [ids]).catch(() => undefined);
    await q(`DELETE FROM pending_points_transactions WHERE reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
    await q(`DELETE FROM booking_payout_issues WHERE reference_id IN (SELECT id FROM appointments WHERE business_id = ANY($1))`, [bizs]).catch(() => undefined);
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
    await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]).catch((e) => console.error("cleanup users", e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
