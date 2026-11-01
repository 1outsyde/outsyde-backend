/**
 * Events Phase 5, p5-stripe-sync: refunds and disputes made in the Stripe dashboard reach Outsyde.
 *
 * Calls (audit 2026-11-01, https://claude.ai/artifact/DKqARTkbB3hzE69sTUpoKr), as recommended:
 *   S1 bookings: a dashboard refund is saved on the booking (amount, time; full refund -> status refunded) and recorded in
 *      booking_refund_recoveries, so the existing recovery job takes the seller's share back.
 *   S2 tickets: full refund -> order and tickets refunded (seats not reopened), host share leaves the payout or is
 *      recovered after it. Partial -> refunded_cents saved, tickets stay valid, order flagged for review.
 *   S3 product orders: full refund -> order refunded (when its status allows); partial -> status unchanged. Never a
 *      transfer reversal.
 *   S4 (option A) event dispute before the payout: only that order's host share is held (event_payouts.dispute_held_cents);
 *      won -> the held part is sent to the host in one more transfer, once; lost -> never paid.
 *   S5 event dispute lost after the payout: recovery for the order's host share plus Stripe's dispute fee (on the first
 *      ticket's recovery). Won after payout -> nothing.
 *   S6 booking dispute lost: seller share recovered (booking_refund_recoveries, refund id dispute_<id>), no fee.
 *   S7 one admin email per dashboard refund, per dispute opened, per dispute closed.
 *   Plus: refunds Outsyde made itself (metadata set) are skipped; events from a connected account are ignored; the same
 *   event twice changes nothing more; refunds before SYNC_START_UNIX are ignored; the 15 minute backstop reads Stripe's
 *   event list and handles what the webhook missed; held dispute money stays in the bank payout's held total.
 *
 * Interface this test expects (built after Legend's OK; none of it exists on main b6ecf7d):
 *   server/stripe/stripeSync.ts: SYNC_START_UNIX, runStripeSyncJob(), setStripeSyncAlertForTest(fn)
 *   WebhookHandlers.handleEvent routes charge.refunded, charge.dispute.created|updated|closed (ignored when event.account is set)
 *   migration 094: stripe_dashboard_refunds (refund_id unique), stripe_disputes (dispute_id unique: status, outcome,
 *   kind, reference_id, amount_cents, fee_cents, evidence_due_by, release_transfer_id), event_payouts.dispute_held_cents
 *   computeHeld().breakdown.disputeHolds
 *
 * Run in process (local Postgres with every migration, neon local proxy on 4444):
 *   EV_TEST_PG_URL=<local> DATABASE_URL=<local> STRIPE_STUB_PORT=<free port> STRIPE_SECRET_KEY=sk_test_stub_only
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs" npx tsx server/stripe/stripeSync.http.test.ts
 * SCRATCH ONLY: refuses any non-local database and any key that isn't sk_test_. Nothing reaches real Stripe or Resend.
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

(async () => {
  if (!PG_URL) { console.log("⏭  skipped: set EV_TEST_PG_URL (+ DATABASE_URL via the shim) to run"); process.exit(0); }
  if (!isLocal(PG_URL)) throw new Error("refusing to run: PG_URL must be localhost");
  if (!process.env.DATABASE_URL || !isLocal(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, "http:"))) throw new Error("refusing to run: DATABASE_URL must be local");
  if (!STUB_PORT) throw new Error("refusing to run: set STRIPE_STUB_PORT and preload ./.dev/stripe-stub-preload.mjs");
  if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) throw new Error("refusing to run: STRIPE_SECRET_KEY must be a sk_test_ stub key");
  process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_stub_only";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";

  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  /** Reads a table added by migration 094: on main it doesn't exist yet, so the run reports a failure instead of stopping. */
  const q094 = async (t: string, p: unknown[] = []) => { try { return await q(t, p); } catch (e: any) { if (e?.code === "42P01") return []; throw e; } };

  // ── Stripe stub ────────────────────────────────────────────────────────────
  type Rec = { method: string; path: string; query: URLSearchParams; form: Record<string, string>; idem: string | null };
  const recs: Rec[] = [];
  /** Refunds Stripe lists for a charge (GET /v1/refunds?charge=). */
  const refundsByCharge = new Map<string, any[]>();
  /** Pages for GET /v1/events (the backstop). */
  let eventPages: any[][] = [];
  let transferSeq = 0;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const form: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body).entries()) form[k] = v;
      recs.push({ method: req.method || "", path: u.pathname, query: u.searchParams, form, idem: (req.headers["idempotency-key"] as string) ?? null });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const meta = () => { const m: Record<string, string> = {}; for (const [k, v] of Object.entries(form)) { const x = k.match(/^metadata\[(.+)\]$/); if (x) m[x[1]] = v; } return m; };
      if (req.method === "GET" && u.pathname === "/v1/refunds") {
        const ch = u.searchParams.get("charge") ?? "";
        const pi = u.searchParams.get("payment_intent") ?? "";
        const data = refundsByCharge.get(ch) ?? [...refundsByCharge.values()].flat().filter((r) => r.payment_intent === pi);
        return send(200, { object: "list", data, has_more: false, url: "/v1/refunds" });
      }
      if (req.method === "GET" && u.pathname === "/v1/events") {
        const page = eventPages.shift() ?? [];
        return send(200, { object: "list", data: page, has_more: false, url: "/v1/events" });
      }
      if (req.method === "GET" && u.pathname === "/v1/transfers") return send(200, { object: "list", data: [], has_more: false, url: "/v1/transfers" });
      if (req.method === "POST" && u.pathname === "/v1/transfers") {
        return send(200, { id: `tr_release_${++transferSeq}`, object: "transfer", amount: Number(form.amount), destination: form.destination, transfer_group: form.transfer_group ?? null, metadata: meta() });
      }
      return send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${u.pathname}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));
  const callsTo = (method: string, path: string) => recs.filter((r) => r.method === method && r.path === path);

  // ── Modules ────────────────────────────────────────────────────────────────
  const { WebhookHandlers } = await import("./webhookHandlers");
  const sync: any = await import("./stripeSync"); // fails on main: the module is part of the build
  const alerts: { subject: string; detail: string }[] = [];
  sync.setStripeSyncAlertForTest(async (subject: string, detail: string) => { alerts.push({ subject, detail }); });
  const ticketAlerts: string[] = [];
  (await import("../events/ticketCheckout")).setAdminAlertForTest(async (s: string) => { ticketAlerts.push(s); });
  const notices = await import("../events/ticketNotices");
  notices.setNoticeDepsForTest({
    sendReceipt: async () => {}, sendRefund: async () => {}, sendCancelled: async () => {}, sendAddressReveal: async () => {},
    sendPush: async () => true, createActivity: async () => {}, sendDoorInvite: async () => {}, sendOwedReminder: async () => {},
  } as any);
  const payouts = await import("../events/eventPayouts");
  const { computeHeld } = await import("../bankPayout");
  const START: number = sync.SYNC_START_UNIX;
  const NOW = Math.max(START + 60, Math.floor(Date.now() / 1000));

  // ── Fixtures ───────────────────────────────────────────────────────────────
  const P = `ss${Date.now().toString(36)}`;
  let seq = 0;
  const uid = (s: string) => `${P}_${s}_${++seq}`;
  const mkUser = async (s: string) => (await q(
    `INSERT INTO users (id, email, name, first_name, username, is_active) VALUES (gen_random_uuid(), $1, $2, $3, $4, true) RETURNING id`,
    [`${P}-${s}-${seq}@test.local`, `Person ${s}`, `First${s}`, `${P}${s}${++seq}`.slice(0, 24)],
  ))[0].id as string;
  const owner = await mkUser("owner");
  const client = await mkUser("client");
  const businessId = (await q(
    `INSERT INTO businesses (owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1, $2, 'Beauty', 'approved', $3, true) RETURNING id`,
    [owner, `${P} Salon`, `acct_${P}_biz`],
  ))[0].id as string;
  const mkAppointment = async (pi: string, totalCents = 10000) => (await q(
    `INSERT INTO appointments (business_id, client_id, appointment_date, appointment_time, total_price, status, stripe_payment_intent_id, vendor_net, settled_at)
     VALUES ($1, $2, '2026-12-01', $6, $3, 'confirmed', $4, $5, now() - interval '1 day') RETURNING id`,
    // unique slot per row (unique_staff_slot): this run's prefix + a counter
    [businessId, client, totalCents, pi, totalCents - Math.round(totalCents * 0.02), `${P}-${++seq}`],
  ))[0].id as string;
  const appt = async (id: string) => (await q(`SELECT status, refund_amount, refunded_at FROM appointments WHERE id = $1`, [id]))[0];
  const recoveriesFor = (pi: string) => q(`SELECT refund_id, refund_cents, status FROM booking_refund_recoveries WHERE payment_intent_id = $1 ORDER BY refund_id`, [pi]);
  const mkProductOrder = async (pi: string, status = "paid", total = 3000) => (await q(
    `INSERT INTO orders (business_id, customer_id, items, total_amount, status, stripe_payment_intent_id) VALUES ($1, $2, '[]'::jsonb, $3, $4, $5) RETURNING id`,
    [businessId, client, total, status, pi],
  ))[0].id as string;
  const orderStatus = async (id: string) => (await q(`SELECT status FROM orders WHERE id = $1`, [id]))[0]?.status;

  const FEE_HOST = 40; // 2% of $20
  const HOST_NET = 2000 - FEE_HOST;
  const allEvents: string[] = [];
  const mkHost = async (s: string) => {
    const id = await mkUser(s);
    await q(`INSERT INTO user_payout_accounts (user_id, stripe_account_id, onboarding_complete) VALUES ($1, $2, true)`, [id, `acct_${P}_${s}`]);
    return { id, acct: `acct_${P}_${s}` };
  };
  const mkEvent = async (hostId: string, slug: string, ended = "4 days") => {
    const e = (await q(
      `INSERT INTO events (host_user_id, slug, title, status, starts_at, ends_at, timezone, published_at)
       VALUES ($1, $2, $3, 'published', now() - ($4::interval + interval '5 hours'), now() - $4::interval, 'America/New_York', now() - interval '20 days')
       RETURNING id`, [hostId, `${P}-${slug}`, `${P} ${slug}`, ended],
    ))[0].id as string;
    allEvents.push(e);
    const typeId = (await q(`INSERT INTO ticket_types (event_id, name, price_cents, quantity, min_per_order, max_per_order) VALUES ($1, 'GA', 2000, 500, 1, 50) RETURNING id`, [e]))[0].id as string;
    return { id: e, typeId };
  };
  /** One completed order of `count` $20 tickets paid with PaymentIntent `pi` (no service fee, so total = subtotal). */
  const mkTicketOrder = async (ev: { id: string; typeId: string }, pi: string, count = 2) => {
    const sub = 2000 * count;
    const oid = (await q(
      `INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, platform_fee_cents, host_net_cents, total_cents,
         completed_at, paid_at, stripe_payment_intent_id)
       VALUES ($1, $2, 'completed', $3, $4, $5, $6, $4, now() - interval '6 days', now() - interval '6 days', $7) RETURNING id`,
      [ev.id, client, count, sub, FEE_HOST * count, sub - FEE_HOST * count, pi],
    ))[0].id as string;
    const iid = (await q(
      `INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 2000, 'issued', now() + interval '1 day') RETURNING id`, [oid, ev.id, ev.typeId, client, count],
    ))[0].id as string;
    const tickets: string[] = [];
    for (let i = 1; i <= count; i++) {
      tickets.push((await q(
        `INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, status, price_cents,
           service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid', 2000, 0, 0, $8, $9) RETURNING id`,
        [oid, iid, ev.id, ev.typeId, client, i, `${P}${Math.random().toString(36).slice(2, 12)}`, FEE_HOST, HOST_NET],
      ))[0].id);
    }
    return { orderId: oid, tickets, totalCents: sub };
  };
  const ticketOrder = async (id: string) => (await q(`SELECT status, refunded_cents, needs_review_at FROM ticket_orders WHERE id = $1`, [id]))[0];
  const ticketStatuses = async (orderId: string) => (await q(`SELECT status FROM tickets WHERE order_id = $1 ORDER BY item_index`, [orderId])).map((r: any) => r.status);
  const payoutOf = async (eventId: string) => (await q(`SELECT * FROM event_payouts WHERE event_id = $1`, [eventId]))[0];
  const runCreate = async () => { for (let i = 0; i < 5; i++) await payouts.createDuePayouts(); };
  /** A payout already sent: row 'paid' with a transfer, every valid ticket of completed orders stamped. */
  const markPaidPayout = async (eventId: string, acct: string) => {
    const [g] = await q(`SELECT COALESCE(SUM(t.host_net_cents),0)::int AS g FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
                         WHERE t.event_id = $1 AND t.status = 'valid' AND o.status = 'completed'`, [eventId]);
    const [p] = await q(`INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, team_cents, amount_cents, status, transfer_id, paid_at)
                         VALUES ($1, 'user', $2, $3, 0, 0, $3, 'paid', $4, now() - interval '1 hour') RETURNING id`, [eventId, acct, g.g, `tr_${P}_${eventId.slice(0, 6)}`]);
    await q(`UPDATE tickets t SET payout_id = $2 FROM ticket_orders o WHERE o.id = t.order_id AND t.event_id = $1 AND t.status = 'valid' AND o.status = 'completed'`, [eventId, p.id]);
    await q(`UPDATE events SET team_pay_fixed_at = now() WHERE id = $1`, [eventId]);
    return p.id as string;
  };
  const eventRecoveries = (orderId: string) => q(
    `SELECT r.ticket_id, r.amount_cents, r.status FROM event_payout_recoveries r JOIN tickets t ON t.id = r.ticket_id WHERE t.order_id = $1 ORDER BY t.item_index`, [orderId]);

  // ── Stripe objects ─────────────────────────────────────────────────────────
  let evSeq = 0;
  const evt = (type: string, object: any, extra: Record<string, unknown> = {}) => ({ id: `evt_${P}_${++evSeq}`, object: "event", type, created: NOW, data: { object }, ...extra });
  const charge = (pi: string, amount: number, refunded: number) => ({
    id: `ch_${pi}`, object: "charge", payment_intent: pi, amount, amount_captured: amount, amount_refunded: refunded, refunded: refunded >= amount,
  });
  const refund = (pi: string, id: string, amount: number, o: { metadata?: Record<string, string>; created?: number } = {}) => ({
    id, object: "refund", amount, status: "succeeded", created: o.created ?? NOW, charge: `ch_${pi}`, payment_intent: pi, metadata: o.metadata ?? {},
  });
  /** Stripe has these refunds on the charge; send charge.refunded for it through the live webhook entry point. */
  const dashboardRefund = async (pi: string, amount: number, refunds: any[], extra: Record<string, unknown> = {}) => {
    refundsByCharge.set(`ch_${pi}`, refunds);
    const refundedTotal = refunds.reduce((n, r) => n + r.amount, 0);
    const e = evt("charge.refunded", charge(pi, amount, refundedTotal), extra);
    await WebhookHandlers.handleEvent(e);
    return e;
  };
  const dispute = (pi: string, id: string, amount: number, status: string) => ({
    id, object: "dispute", charge: `ch_${pi}`, payment_intent: pi, amount, currency: "usd", status, reason: "fraudulent", created: NOW,
    evidence_details: { due_by: NOW + 7 * 86400 },
    balance_transactions: [{ id: `txn_${id}`, object: "balance_transaction", amount: -amount, fee: 1500, net: -(amount + 1500) }],
  });
  const sendDispute = (type: "created" | "updated" | "closed", d: any) => WebhookHandlers.handleEvent(evt(`charge.dispute.${type}`, d));
  const disputeRow = async (id: string) => (await q094(`SELECT * FROM stripe_disputes WHERE dispute_id = $1`, [id]))[0];
  const alertsAbout = (needle: string) => alerts.filter((a) => `${a.subject} ${a.detail}`.includes(needle));

  try {
    // ════ S1 bookings ════
    console.log("\nS1 bookings: a refund made in Stripe works like one made in the app");
    {
      const pi = `pi_${uid("apfull")}`;
      const id = await mkAppointment(pi);
      await dashboardRefund(pi, 10000, [refund(pi, `re_${pi}_1`, 10000)]);
      const a = await appt(id);
      assert(a.status === "refunded" && Number(a.refund_amount) === 10000 && !!a.refunded_at, "full refund: booking refunded, amount and time saved", a);
      const rec = await recoveriesFor(pi);
      assert(rec.length === 1 && rec[0].refund_id === `re_${pi}_1` && Number(rec[0].refund_cents) === 10000 && rec[0].status === "pending",
        "full refund: recorded for the seller share recovery", rec);
      assert(alertsAbout(pi).length === 1, "one admin email for the refund", alertsAbout(pi));
      const listCall = callsTo("GET", "/v1/refunds").find((r) => r.query.get("charge") === `ch_${pi}` || r.query.get("payment_intent") === pi);
      assert(!!listCall, "refunds listed from Stripe (the event may not carry them)", recs.slice(-3).map((r) => r.path));
      const row = (await q094(`SELECT kind, reference_id, amount_cents FROM stripe_dashboard_refunds WHERE refund_id = $1`, [`re_${pi}_1`]))[0];
      assert(row?.kind === "appointment" && row?.reference_id === id && Number(row?.amount_cents) === 10000, "refund saved once with the sale it belongs to", row);

      // same event again (Stripe resend, or webhook + backstop)
      await dashboardRefund(pi, 10000, [refund(pi, `re_${pi}_1`, 10000)]);
      const a2 = await appt(id);
      assert(Number(a2.refund_amount) === 10000 && (await recoveriesFor(pi)).length === 1 && alertsAbout(pi).length === 1,
        "same refund twice: nothing doubled, no second email", { a2, alerts: alertsAbout(pi).length });
    }
    {
      const pi = `pi_${uid("appart")}`;
      const id = await mkAppointment(pi);
      await dashboardRefund(pi, 10000, [refund(pi, `re_${pi}_1`, 2500)]);
      let a = await appt(id);
      assert(a.status === "confirmed" && Number(a.refund_amount) === 2500 && !!a.refunded_at, "partial refund: amount saved, booking stays confirmed", a);
      await dashboardRefund(pi, 10000, [refund(pi, `re_${pi}_1`, 2500), refund(pi, `re_${pi}_2`, 1500)]);
      a = await appt(id);
      assert(Number(a.refund_amount) === 4000 && a.status === "confirmed", "second partial refund adds up (2,500 + 1,500)", a);
      const rec = await recoveriesFor(pi);
      assert(rec.length === 2 && rec.map((r: any) => Number(r.refund_cents)).join(",") === "2500,1500", "each refund recorded for recovery", rec);
    }
    {
      // Refund Outsyde made itself (every code refund sends metadata; its hook already recorded it)
      const pi = `pi_${uid("apown")}`;
      const id = await mkAppointment(pi);
      await q(`UPDATE appointments SET status = 'refunded', refund_amount = 10000, refunded_at = now(), stripe_refund_id = $2 WHERE id = $1`, [id, `re_${pi}_own`]);
      await q(`INSERT INTO booking_refund_recoveries (refund_id, payment_intent_id, refund_cents, refund_created_at, status, next_attempt_at)
               VALUES ($1, $2, 10000, now(), 'pending', now())`, [`re_${pi}_own`, pi]);
      const before = alerts.length;
      await dashboardRefund(pi, 10000, [refund(pi, `re_${pi}_own`, 10000, { metadata: { appointmentId: id, initiatedBy: client } })]);
      const a = await appt(id);
      const dash = await q094(`SELECT 1 FROM stripe_dashboard_refunds WHERE refund_id = $1`, [`re_${pi}_own`]);
      assert(Number(a.refund_amount) === 10000 && dash.length === 0 && alerts.length === before && (await recoveriesFor(pi)).length === 1,
        "Outsyde's own refund (metadata set): skipped, nothing saved twice, no email", { a, dash, alerts: alerts.length - before });
    }
    {
      // Refund before the sync start date: ignored (like #350, only refunds from the day it goes live)
      const pi = `pi_${uid("apold")}`;
      const id = await mkAppointment(pi);
      await dashboardRefund(pi, 10000, [refund(pi, `re_${pi}_old`, 10000, { created: START - 100 })]);
      const a = await appt(id);
      assert(a.status === "confirmed" && !a.refund_amount && (await recoveriesFor(pi)).length === 0, "refund older than the sync start: ignored", a);
    }
    {
      // Event from a connected account (Connect endpoint): ignored, Stripe not called
      const pi = `pi_${uid("apacct")}`;
      const id = await mkAppointment(pi);
      const n = recs.length;
      await dashboardRefund(pi, 10000, [refund(pi, `re_${pi}_1`, 10000)], { account: "acct_someone_else" });
      const a = await appt(id);
      assert(a.status === "confirmed" && !a.refund_amount && recs.length === n, "connected account event: ignored, no Stripe call", { a, calls: recs.length - n });
    }

    // ════ S2 tickets ════
    console.log("\nS2 tickets: full refund cancels the tickets, partial is flagged");
    {
      const host = await mkHost("h_s2a");
      const ev = await mkEvent(host.id, "s2-before");
      const a = await mkTicketOrder(ev, `pi_${uid("tka")}`, 2);
      const b = await mkTicketOrder(ev, `pi_${uid("tkb")}`, 2);
      const reservedBefore = (await q(`SELECT reserved_count FROM events WHERE id = $1`, [ev.id]))[0].reserved_count;
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      await dashboardRefund(piA, a.totalCents, [refund(piA, `re_${piA}_1`, a.totalCents)]);
      const o = await ticketOrder(a.orderId);
      assert(o.status === "refunded" && Number(o.refunded_cents) === a.totalCents, "full refund: order refunded with the amount", o);
      assert((await ticketStatuses(a.orderId)).every((s) => s === "refunded"), "full refund: its tickets refunded (QR stops working)", await ticketStatuses(a.orderId));
      const reservedAfter = (await q(`SELECT reserved_count FROM events WHERE id = $1`, [ev.id]))[0].reserved_count;
      assert(reservedAfter === reservedBefore, "seats are not reopened", { reservedBefore, reservedAfter });
      assert(alertsAbout(piA).length === 1, "one admin email", alertsAbout(piA));
      await runCreate();
      const p = await payoutOf(ev.id);
      assert(p && Number(p.gross_cents) === HOST_NET * 2 && Number(p.amount_cents) === HOST_NET * 2, "payout only counts the order that wasn't refunded", p);
      void b;
    }
    {
      const host = await mkHost("h_s2b");
      const ev = await mkEvent(host.id, "s2-after");
      const a = await mkTicketOrder(ev, `pi_${uid("tkc")}`, 2);
      await markPaidPayout(ev.id, host.acct);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      await dashboardRefund(piA, a.totalCents, [refund(piA, `re_${piA}_1`, a.totalCents)]);
      assert((await ticketStatuses(a.orderId)).every((s) => s === "refunded"), "after the payout: tickets refunded", await ticketStatuses(a.orderId));
      // the step opens at most 50 per run, oldest first (other test data may be waiting too): run it until it is done
      for (let i = 0; i < 50; i++) if (!(await payouts.openRecoveries())) break;
      const r = await eventRecoveries(a.orderId);
      assert(r.length === 2 && r.every((x: any) => Number(x.amount_cents) === HOST_NET && x.status === "pending"),
        "after the payout: host share recovered per ticket (existing recovery step)", r);
    }
    {
      const host = await mkHost("h_s2c");
      const ev = await mkEvent(host.id, "s2-partial");
      const a = await mkTicketOrder(ev, `pi_${uid("tkd")}`, 2);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      await dashboardRefund(piA, a.totalCents, [refund(piA, `re_${piA}_1`, 1000)]);
      const o = await ticketOrder(a.orderId);
      assert(o.status === "completed" && Number(o.refunded_cents) === 1000 && !!o.needs_review_at, "partial refund: saved on the order, flagged for review", o);
      assert((await ticketStatuses(a.orderId)).every((s) => s === "valid"), "partial refund: tickets stay valid", await ticketStatuses(a.orderId));
      assert(alertsAbout(piA).length >= 1, "partial refund: admin emailed", alertsAbout(piA));
    }
    {
      // Outsyde's own ticket refund (ticketRefunds.ts metadata type event_ticket_refund): skipped
      const host = await mkHost("h_s2d");
      const ev = await mkEvent(host.id, "s2-own");
      const a = await mkTicketOrder(ev, `pi_${uid("tke")}`, 1);
      await q(`UPDATE ticket_orders SET status = 'refunded', refunded_cents = 2000, refund_reason = 'host', stripe_refund_id = 're_own_t' WHERE id = $1`, [a.orderId]);
      await q(`UPDATE tickets SET status = 'refunded', refunded_at = now() WHERE order_id = $1`, [a.orderId]);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      await dashboardRefund(piA, 2000, [refund(piA, "re_own_t", 2000, { metadata: { type: "event_ticket_refund", ticketOrderId: a.orderId, refundReason: "host" } })]);
      const o = await ticketOrder(a.orderId);
      assert(Number(o.refunded_cents) === 2000 && !o.needs_review_at && alertsAbout(piA).length === 0, "Outsyde's own ticket refund: skipped", o);
    }

    // ════ S3 product orders ════
    console.log("\nS3 product orders: record only, nothing taken from the vendor");
    {
      const pi = `pi_${uid("ordfull")}`;
      const id = await mkProductOrder(pi, "delivered");
      const before = recs.length;
      await dashboardRefund(pi, 3000, [refund(pi, `re_${pi}_1`, 3000)]);
      assert((await orderStatus(id)) === "refunded", "full refund: order refunded", await orderStatus(id));
      const reversals = recs.slice(before).filter((r) => r.method === "POST" && /reversals$/.test(r.path));
      assert(reversals.length === 0, "no transfer reversal", reversals.map((r) => r.path));
      assert(alertsAbout(pi).length === 1, "one admin email", alertsAbout(pi));
    }
    {
      const pi = `pi_${uid("ordpart")}`;
      const id = await mkProductOrder(pi, "paid");
      await dashboardRefund(pi, 3000, [refund(pi, `re_${pi}_1`, 500)]);
      assert((await orderStatus(id)) === "paid" && alertsAbout(pi).length === 1, "partial refund: order stays paid, admin emailed", await orderStatus(id));
    }
    {
      // Outsyde's own order cancel refund (stripeService.refundOrderCancellation): orders have no refund id column, so
      // the metadata is the only thing that marks it as Outsyde's.
      const pi = `pi_${uid("ordown")}`;
      const id = await mkProductOrder(pi, "paid");
      await dashboardRefund(pi, 3000, [refund(pi, `re_${pi}_own`, 3000, { metadata: { orderId: id, type: "order_cancellation" } })]);
      const dash = await q094(`SELECT 1 FROM stripe_dashboard_refunds WHERE refund_id = $1`, [`re_${pi}_own`]);
      assert((await orderStatus(id)) === "paid" && dash.length === 0 && alertsAbout(pi).length === 0,
        "Outsyde's own order refund (metadata only): skipped, no row, no email", { s: await orderStatus(id), dash, a: alertsAbout(pi).length });
    }
    {
      const pi = `pi_${uid("ordcanc")}`;
      const id = await mkProductOrder(pi, "cancelled");
      await dashboardRefund(pi, 3000, [refund(pi, `re_${pi}_1`, 3000)]);
      assert((await orderStatus(id)) === "cancelled", "cancelled order stays cancelled (status rules)", await orderStatus(id));
    }

    // ════ S4 + S5 event disputes ════
    console.log("\nS4 event dispute before the payout: only that order's share is held");
    {
      const host = await mkHost("h_s4w");
      const ev = await mkEvent(host.id, "s4-won");
      const a = await mkTicketOrder(ev, `pi_${uid("dwa")}`, 2);
      await mkTicketOrder(ev, `pi_${uid("dwb")}`, 2);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      const dId = `dp_${uid("won")}`;
      await sendDispute("created", dispute(piA, dId, a.totalCents, "needs_response"));
      let d = await disputeRow(dId);
      assert(d && d.kind === "ticket_order" && d.reference_id === a.orderId && d?.status === "needs_response" && Number(d.amount_cents) === a.totalCents
        && Number(d.fee_cents) === 1500 && !!d.evidence_due_by, "dispute saved with sale, amount, fee and evidence due date", d);
      assert(alertsAbout(dId).length === 1, "admin emailed when the dispute opens", alertsAbout(dId));
      await sendDispute("updated", dispute(piA, dId, a.totalCents, "under_review"));
      d = await disputeRow(dId);
      assert(d?.status === "under_review" && alertsAbout(dId).length === 1, "update saves the new status, no extra email", { status: d?.status, n: alertsAbout(dId).length });

      await runCreate();
      const p = await payoutOf(ev.id);
      assert(p && Number(p.gross_cents) === HOST_NET * 4 && Number(p.dispute_held_cents) === HOST_NET * 2 && Number(p.amount_cents) === HOST_NET * 2,
        "payout goes out without the disputed order's share (held 3,920)", p);
      const heldOpen = (await computeHeld()).breakdown as any;
      assert(Number(heldOpen.disputeHolds) >= HOST_NET * 2, "bank payout keeps the held share on Stripe", heldOpen);

      // payout sent, then the dispute is won: the held part goes to the host in one more transfer, once
      await q(`UPDATE event_payouts SET status = 'paid', transfer_id = $2, connected_account_id = $3, paid_at = now() WHERE id = $1`, [p.id, `tr_${P}_s4w`, host.acct]);
      const n = callsTo("POST", "/v1/transfers").length;
      await sendDispute("closed", dispute(piA, dId, a.totalCents, "won"));
      // the release may be sent by the closing handler or by the sync job; run the job once to cover both
      await sync.runStripeSyncJob();
      const sent = callsTo("POST", "/v1/transfers").slice(n);
      assert(sent.length === 1 && Number(sent[0].form.amount) === HOST_NET * 2 && sent[0].form.destination === host.acct && !!sent[0].idem,
        "won: held 3,920 sent to the host's account, with an idempotency key", sent.map((r) => r.form));
      d = await disputeRow(dId);
      assert(d?.outcome === "won" && !!d?.release_transfer_id, "won: outcome and release transfer saved", d);
      assert(alertsAbout(dId).length === 2, "admin emailed when the dispute closes", alertsAbout(dId).map((x) => x.subject));
      await sendDispute("closed", dispute(piA, dId, a.totalCents, "won"));
      await sync.runStripeSyncJob();
      assert(callsTo("POST", "/v1/transfers").length === n + 1, "closed again: never sent twice", callsTo("POST", "/v1/transfers").length - n);
      const heldDone = (await computeHeld()).breakdown as any;
      assert(Number(heldDone.disputeHolds) === Number(heldOpen.disputeHolds) - HOST_NET * 2, "nothing held for it any more", { heldOpen: heldOpen.disputeHolds, heldDone: heldDone.disputeHolds });
      assert((await eventRecoveries(a.orderId)).length === 0, "won: nothing taken back from the host", await eventRecoveries(a.orderId));
    }
    {
      const host = await mkHost("h_s4l");
      const ev = await mkEvent(host.id, "s4-lost");
      const a = await mkTicketOrder(ev, `pi_${uid("dla")}`, 2);
      await mkTicketOrder(ev, `pi_${uid("dlb")}`, 2);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      const dId = `dp_${uid("lost")}`;
      await sendDispute("created", dispute(piA, dId, a.totalCents, "needs_response"));
      await runCreate();
      const p = await payoutOf(ev.id);
      assert(Number(p.dispute_held_cents) === HOST_NET * 2, "held before the payout", p);
      await q(`UPDATE event_payouts SET status = 'paid', transfer_id = $2, connected_account_id = $3, paid_at = now() WHERE id = $1`, [p.id, `tr_${P}_s4l`, host.acct]);
      const n = callsTo("POST", "/v1/transfers").length;
      await sendDispute("closed", dispute(piA, dId, a.totalCents, "lost"));
      await sync.runStripeSyncJob();
      assert(callsTo("POST", "/v1/transfers").length === n, "lost while held: the share is never paid", callsTo("POST", "/v1/transfers").length - n);
      const r = await eventRecoveries(a.orderId);
      assert(r.length === 1 && Number(r[0].amount_cents) === 1500, "lost while held: only Stripe's 15.00 fee is owed by the host (first ticket)", r);
      assert((await disputeRow(dId))?.outcome === "lost", "outcome saved", await disputeRow(dId));
    }
    console.log("\nS5 event dispute after the payout: taken back from the host only when lost");
    {
      const host = await mkHost("h_s5");
      const ev = await mkEvent(host.id, "s5-lost");
      const a = await mkTicketOrder(ev, `pi_${uid("d5a")}`, 2);
      const payoutId = await markPaidPayout(ev.id, host.acct);
      const before = await payoutOf(ev.id);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      const dId = `dp_${uid("after")}`;
      await sendDispute("created", dispute(piA, dId, a.totalCents, "needs_response"));
      assert((await eventRecoveries(a.orderId)).length === 0, "opened: nothing taken back yet", await eventRecoveries(a.orderId));
      const after = await payoutOf(ev.id);
      assert(Number(after.amount_cents) === Number(before.amount_cents) && after.status === "paid", "the sent payout is not changed", after);
      await sendDispute("closed", dispute(piA, dId, a.totalCents, "lost"));
      await sync.runStripeSyncJob();
      const r = await eventRecoveries(a.orderId);
      assert(r.length === 2 && Number(r[0].amount_cents) === HOST_NET + 1500 && Number(r[1].amount_cents) === HOST_NET,
        "lost: host share per ticket + 15.00 fee on the first ticket", r);
      assert(r.length === 2 && r.every((x: any) => x.status === "pending"), "recoveries go through the normal reverse, negative balance, next payout steps", r);
      const team = await q(`SELECT 1 FROM event_team_payouts WHERE payout_id = $1`, [payoutId]);
      assert(team.length === 0, "team pay untouched", team);
    }
    {
      const host = await mkHost("h_s5w");
      const ev = await mkEvent(host.id, "s5-won");
      const a = await mkTicketOrder(ev, `pi_${uid("d5w")}`, 2);
      await markPaidPayout(ev.id, host.acct);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      const dId = `dp_${uid("afterwon")}`;
      const n = callsTo("POST", "/v1/transfers").length;
      await sendDispute("created", dispute(piA, dId, a.totalCents, "needs_response"));
      await sendDispute("closed", dispute(piA, dId, a.totalCents, "won"));
      await sync.runStripeSyncJob();
      assert((await eventRecoveries(a.orderId)).length === 0 && callsTo("POST", "/v1/transfers").length === n, "won after the payout: nothing happens", null);
    }

    // ════ S6 booking disputes ════
    console.log("\nS6 booking dispute: seller share taken back only when lost, no fee");
    {
      const pi = `pi_${uid("bdl")}`;
      const id = await mkAppointment(pi);
      const dId = `dp_${uid("blost")}`;
      await sendDispute("created", dispute(pi, dId, 10000, "needs_response"));
      const d = await disputeRow(dId);
      assert(d?.kind === "appointment" && d?.reference_id === id && alertsAbout(dId).length === 1, "opened: saved and admin emailed", d);
      assert((await recoveriesFor(pi)).length === 0, "opened: nothing taken back yet", await recoveriesFor(pi));
      await sendDispute("closed", dispute(pi, dId, 10000, "lost"));
      const r = await recoveriesFor(pi);
      assert(r.length === 1 && r[0].refund_id === `dispute_${dId}` && Number(r[0].refund_cents) === 10000, "lost: seller share recorded for recovery, no fee", r);
      assert((await appt(id)).status === "confirmed", "booking status unchanged", await appt(id));
      await sendDispute("closed", dispute(pi, dId, 10000, "lost"));
      assert((await recoveriesFor(pi)).length === 1 && alertsAbout(dId).length === 2, "closed twice: recorded once, one closing email", { r: (await recoveriesFor(pi)).length, a: alertsAbout(dId).length });
    }
    {
      const pi = `pi_${uid("bdw")}`;
      await mkAppointment(pi);
      const dId = `dp_${uid("bwon")}`;
      await sendDispute("created", dispute(pi, dId, 10000, "needs_response"));
      await sendDispute("closed", dispute(pi, dId, 10000, "won"));
      assert((await recoveriesFor(pi)).length === 0 && (await disputeRow(dId))?.outcome === "won", "won: nothing taken back", await disputeRow(dId));
    }
    {
      const pi = `pi_${uid("odl")}`;
      const id = await mkProductOrder(pi, "delivered");
      const dId = `dp_${uid("olost")}`;
      await sendDispute("created", dispute(pi, dId, 3000, "needs_response"));
      await sendDispute("closed", dispute(pi, dId, 3000, "lost"));
      assert((await orderStatus(id)) === "delivered" && alertsAbout(dId).length === 2 && (await disputeRow(dId))?.kind === "order",
        "product order dispute: recorded and emailed only", { s: await orderStatus(id), a: alertsAbout(dId).length });
    }
    {
      const dId = `dp_${uid("unknown")}`;
      await sendDispute("created", dispute(`pi_${uid("nobody")}`, dId, 4099, "needs_response"));
      const d = await disputeRow(dId);
      assert(d?.kind === "unknown" && alertsAbout(dId).length === 1, "dispute on a charge Outsyde can't match (e.g. a subscription): saved and emailed", d);
    }
    {
      const n = alerts.length;
      await WebhookHandlers.handleEvent(evt("charge.dispute.created", dispute(`pi_${uid("acctd")}`, `dp_${uid("acct")}`, 1000, "needs_response"), { account: "acct_someone_else" }));
      assert(alerts.length === n, "dispute on a connected account: ignored", alerts.length - n);
    }

    // ════ Review fixes (independent review 2026-11-01) ════
    console.log("\nreview fixes");
    {
      // 1. A lost booking dispute is actually taken back by the booking recovery job (it is not a Stripe refund to look up)
      const pi = `pi_${uid("bdrec")}`;
      const id = await mkAppointment(pi);
      const dId = `dp_${uid("brec")}`;
      await sendDispute("created", dispute(pi, dId, 10000, "needs_response"));
      await sendDispute("closed", dispute(pi, dId, 10000, "lost"));
      const [row] = await q(`SELECT id FROM booking_refund_recoveries WHERE refund_id = $1`, [`dispute_${dId}`]);
      const reversals: any[] = [];
      const fake: any = {
        listBookingTransfers: async (group: string) => (group === `appointment_${id}` ? [{ id: `tr_${pi}`, amount: 9800, amountReversed: 0, destination: `acct_${P}_biz` }] : []),
        listPaymentIntentRefunds: async () => { throw new Error("must not look a dispute up as a refund"); },
        findRecoveryReversals: async () => [],
        reverseForRecovery: async (p: any) => { reversals.push(p); return { id: `trr_${pi}` }; },
        getPaymentIntentAmountReceived: async () => 10000,
        isInsufficientFundsError: () => false,
      };
      const { processBookingRecovery } = await import("../bookingRecoveries");
      const res = await processBookingRecovery(row.id, fake);
      const after = (await q(`SELECT status, reference_id, reversed_cents FROM booking_refund_recoveries WHERE id = $1`, [row.id]))[0];
      assert(res === "reversed" && reversals.length === 1 && reversals[0].transferId === `tr_${pi}` && reversals[0].refundId === `dispute_${dId}` && Number(reversals[0].amountCents) > 0
        && after.reference_id === id && Number(after.reversed_cents) === Number(reversals[0].amountCents),
        "lost booking dispute: recovery job takes the seller share back from the booking transfer", { res, reversals, after });
    }
    {
      // 2. Full or partial comes from Stripe's live list, not the event's charge (events out of order)
      const pi = `pi_${uid("aporder")}`;
      const id = await mkAppointment(pi);
      const a = refund(pi, `re_${pi}_a`, 4000, { created: NOW - 10 });
      const b = refund(pi, `re_${pi}_b`, 6000, { created: NOW });
      refundsByCharge.set(`ch_${pi}`, [a, b]);
      await WebhookHandlers.handleEvent(evt("charge.refunded", charge(pi, 10000, 4000))); // A's event, handled after B happened
      const x = await appt(id);
      assert(x.status === "refunded" && Number(x.refund_amount) === 10000, "second refund completes the charge: booking refunded even from the older event", x);
      const tpi = `pi_${uid("tkorder")}`;
      const host = await mkHost("h_order");
      const ev = await mkEvent(host.id, "order-fix", "1 day");
      const o = await mkTicketOrder(ev, tpi, 2);
      refundsByCharge.set(`ch_${tpi}`, [refund(tpi, `re_${tpi}_a`, 1000, { created: NOW - 10 }), refund(tpi, `re_${tpi}_b`, 3000, { created: NOW })]);
      await WebhookHandlers.handleEvent(evt("charge.refunded", charge(tpi, 4000, 4000))); // newest charge state, both refunds listed
      const t = await ticketOrder(o.orderId);
      assert(t.status === "refunded" && Number(t.refunded_cents) === 4000 && (await ticketStatuses(o.orderId)).every((s) => s === "refunded"),
        "ticket order: partial then remainder ends refunded with tickets cancelled", { t, tickets: await ticketStatuses(o.orderId) });
    }
    {
      // 3. A cancelled card hold (uncaptured charge) is not a refund
      const pi = `pi_${uid("hold")}`;
      const id = await mkAppointment(pi);
      refundsByCharge.set(`ch_${pi}`, [refund(pi, `re_${pi}_hold`, 10000)]);
      const n = recs.length;
      await WebhookHandlers.handleEvent(evt("charge.refunded", { ...charge(pi, 10000, 10000), captured: false, amount_captured: 0 }));
      const x = await appt(id);
      assert(x.status === "confirmed" && !x.refund_amount && alertsAbout(pi).length === 0 && recs.length === n,
        "cancelled card hold: nothing applied, no email, Stripe not called", { x, calls: recs.length - n });
    }
    {
      // 6. Won while held on a $0 payout whose row has no account: released to the host's account now
      const host = await mkHost("h_zero");
      const ev = await mkEvent(host.id, "zero-held");
      const a = await mkTicketOrder(ev, `pi_${uid("zero")}`, 2);
      const share = HOST_NET * 2;
      const [p] = await q(`INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, team_cents, dispute_held_cents, amount_cents, status, paid_at)
                           VALUES ($1, 'user', NULL, $2, 0, 0, $2, 0, 'paid', now()) RETURNING id`, [ev.id, share]);
      const dId = `dp_${uid("zero")}`;
      await q(`INSERT INTO stripe_disputes (dispute_id, payment_intent_id, kind, reference_id, amount_cents, status, outcome, closed_at, held_cents, held_payout_id)
               VALUES ($1, $2, 'ticket_order', $3, $4, 'won', 'won', now(), $5, $6)`, [dId, `pi_${uid("zeropi")}`, a.orderId, a.totalCents, share, p.id]);
      const n = callsTo("POST", "/v1/transfers").length;
      await sync.settleDispute(dId);
      const sent = callsTo("POST", "/v1/transfers").slice(n);
      assert(sent.length === 1 && sent[0].form.destination === host.acct && Number(sent[0].form.amount) === share,
        "$0 payout with no account on the row: held share sent to the host's current account", sent.map((r) => r.form));
    }
    {
      // 7. Any closing status other than lost (for example prevented) is won
      const pi = `pi_${uid("prev")}`;
      await mkAppointment(pi);
      const dId = `dp_${uid("prev")}`;
      await sendDispute("created", dispute(pi, dId, 10000, "needs_response"));
      await sendDispute("closed", dispute(pi, dId, 10000, "prevented"));
      const d = await disputeRow(dId);
      assert(d?.outcome === "won" && !!d?.settled_at && (await recoveriesFor(pi)).length === 0, "closed as prevented: won, settled, nothing taken back", d);
    }
    {
      // 8. A lost ticket dispute waiting on its payout is snoozed so it never blocks the settle queue
      const host = await mkHost("h_wait");
      const ev = await mkEvent(host.id, "wait", "1 day"); // payout not due for 2 more days
      const a = await mkTicketOrder(ev, `pi_${uid("wait")}`, 2);
      const piA = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [a.orderId]))[0].pi;
      const dId = `dp_${uid("wait")}`;
      await sendDispute("created", dispute(piA, dId, a.totalCents, "needs_response"));
      await sendDispute("closed", dispute(piA, dId, a.totalCents, "lost"));
      const d = await disputeRow(dId);
      assert(!d?.settled_at && d?.release_next_at && new Date(d.release_next_at).getTime() > Date.now() + 10 * 60000,
        "lost before the payout exists: not settled, looked at again in 15 minutes", d);
      const due = await q094(`SELECT 1 FROM stripe_disputes WHERE dispute_id = $1 AND (release_next_at IS NULL OR release_next_at <= now())`, [dId]);
      assert(due.length === 0, "out of the settle queue until then", due);
    }
    {
      // 4. An event replay never changes updated_at (the release claim's ownership tag)
      const pi = `pi_${uid("tag")}`;
      await mkAppointment(pi);
      const dId = `dp_${uid("tag")}`;
      await sendDispute("created", dispute(pi, dId, 10000, "needs_response"));
      const t1 = (await q094(`SELECT (extract(epoch from updated_at) * 1000000)::bigint::text AS t FROM stripe_disputes WHERE dispute_id = $1`, [dId]))[0]?.t;
      await sendDispute("created", dispute(pi, dId, 10000, "needs_response"));
      const t2 = (await q094(`SELECT (extract(epoch from updated_at) * 1000000)::bigint::text AS t FROM stripe_disputes WHERE dispute_id = $1`, [dId]))[0]?.t;
      assert(!!t1 && String(t1) === String(t2), "replayed dispute event leaves updated_at alone", { t1, t2 });
    }

    {
      // Production check ticket_orders_refund_pending_valid: a dashboard refund while Outsyde's own refund is still being
      // sent must not break it (the statement would fail and retry forever). Saved, capped, flagged for review.
      const host = await mkHost("h_inflight");
      const ev = await mkEvent(host.id, "inflight", "1 day");
      const o = await mkTicketOrder(ev, `pi_${uid("inflight")}`, 2);
      await q(`UPDATE ticket_orders SET status = 'refunding', refund_reason = 'host', refund_amount_cents = 3920, refund_requested_at = now() WHERE id = $1`, [o.orderId]);
      const piO = (await q(`SELECT stripe_payment_intent_id AS pi FROM ticket_orders WHERE id = $1`, [o.orderId]))[0].pi;
      await dashboardRefund(piO, o.totalCents, [refund(piO, `re_${piO}_1`, 1000)]);
      const t = (await q(`SELECT status, refunded_cents, refund_amount_cents, needs_review_at FROM ticket_orders WHERE id = $1`, [o.orderId]))[0];
      const dash = await q094(`SELECT 1 FROM stripe_dashboard_refunds WHERE refund_id = $1`, [`re_${piO}_1`]);
      assert(t.status === "refunding" && Number(t.refunded_cents) + Number(t.refund_amount_cents) <= o.totalCents && !!t.needs_review_at && dash.length === 1 && alertsAbout(piO).length === 1,
        "dashboard refund during an in-app refund: saved, within the order total, flagged, emailed", { t, dash: dash.length, a: alertsAbout(piO).length });
    }

    // ════ Backstop ════
    console.log("\nbackstop: the sync job handles events the webhook missed");
    {
      const pi = `pi_${uid("missed")}`;
      const id = await mkProductOrder(pi, "paid");
      refundsByCharge.set(`ch_${pi}`, [refund(pi, `re_${pi}_1`, 3000)]);
      eventPages = [[evt("charge.refunded", charge(pi, 3000, 3000))]];
      const n = callsTo("GET", "/v1/events").length;
      await sync.runStripeSyncJob();
      const call = callsTo("GET", "/v1/events")[n];
      // stripe-node sends arrays as types[0]=..., types[1]=... (any index form is fine)
      const types = call ? [...call.query.entries()].filter(([k]) => /^types\[\d*\]$/.test(k)).map(([, v]) => v) : [];
      assert(!!call && ["charge.refunded", "charge.dispute.created", "charge.dispute.closed"].every((t) => types.includes(t)) && !!call.query.get("created[gte]"),
        "asks Stripe for refund and dispute events in a recent window", call ? Object.fromEntries(call.query.entries()) : null);
      assert((await orderStatus(id)) === "refunded", "missed refund handled by the job", await orderStatus(id));
      eventPages = [[evt("charge.refunded", charge(pi, 3000, 3000))]];
      const a = alertsAbout(pi).length;
      await sync.runStripeSyncJob();
      assert(alertsAbout(pi).length === a, "job sees it again: nothing more happens", alertsAbout(pi).length);
    }
  } finally {
    // keep other suites' payout runs away from these events
    if (allEvents.length) await q(`UPDATE events SET status = 'draft' WHERE id = ANY($1::varchar[])`, [allEvents]).catch(() => {});
    // and their "every due row" checks away from this run's rows (booking recovery job, backfill, settle queue)
    const like = `pi_${P}%`;
    await q(`DELETE FROM booking_refund_recoveries WHERE payment_intent_id LIKE $1`, [like]).catch(() => {});
    await q(`DELETE FROM event_payout_recoveries WHERE ticket_id IN (SELECT t.id FROM tickets t JOIN ticket_orders o ON o.id = t.order_id WHERE o.stripe_payment_intent_id LIKE $1)`, [like]).catch(() => {});
    await q094(`DELETE FROM stripe_disputes WHERE payment_intent_id LIKE $1 OR dispute_id LIKE $2`, [like, `dp_${P}%`]);
    await q094(`DELETE FROM stripe_dashboard_refunds WHERE payment_intent_id LIKE $1`, [like]);
    await q(`DELETE FROM appointments WHERE stripe_payment_intent_id LIKE $1`, [like]).catch(() => {});
    await q(`UPDATE orders SET status = 'cancelled' WHERE stripe_payment_intent_id LIKE $1`, [like]).catch(() => {});
    sync.setStripeSyncAlertForTest?.(null);
    await db.end().catch(() => {});
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
