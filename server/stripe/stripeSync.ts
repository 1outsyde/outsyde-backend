/**
 * Events Phase 5, p5-stripe-sync: refunds and disputes made in the Stripe dashboard reach Outsyde (Legend's calls S1 to S8,
 * 2026-11-01; audit https://claude.ai/artifact/DKqARTkbB3hzE69sTUpoKr, vault "p5-stripe-sync — Audit & Regression").
 *
 * Two ways in, both safe to run any number of times:
 *   - the webhook (charge.refunded, charge.dispute.created|updated|closed; WebhookHandlers.handleEvent), and
 *   - runStripeSyncJob, the backstop: the webhook answers 200 before it works and Stripe never retries, so every 15 minutes
 *     the job reads Stripe's own event list for those types (last 3 days) and handles them again. Every minute it also
 *     finishes closed disputes that couldn't be settled yet (payout not sent yet, a release transfer that failed).
 * Events from a connected account (event.account set) are ignored: every Outsyde charge is on the platform account.
 *
 * Refunds (charge.refunded). Each refund on the charge is read from Stripe (newer API versions leave the list off the
 * event). Skipped: failed or canceled refunds, refunds created before SYNC_START_UNIX, and refunds Outsyde made itself
 * (every code path sends metadata; also any refund id saved on the sale). The rest are dashboard refunds, applied once:
 * the stripe_dashboard_refunds row (refund_id unique) is written in the same statement that applies it to the sale.
 *   S1 appointment / shoot booking: refund_amount += amount, refunded_at; a full refund also moves confirmed, in progress
 *      or completed bookings to refunded. Then recordBookingRefund, so the recovery job (#350) takes the seller's share
 *      back and tells the seller. (If this process stops before that, the 15 minute booking backfill finds it, since
 *      refunded_at is now set.)
 *   S2 ticket order: full refund of a completed order -> order and its valid tickets refunded (seats not reopened); the
 *      payout then leaves them out, or after the payout openRecoveries takes the host share back. Partial (or any other
 *      order status) -> refunded_cents += amount and the order is flagged for review.
 *   S3 product order: full refund -> every paid, shipped or delivered order on the PaymentIntent becomes refunded. Never a
 *      transfer reversal (Stripe's own refund screen offers that for destination charges).
 *   Unknown sale: recorded only. S7: one admin email per applied refund.
 *
 * Disputes (charge.dispute.*). One stripe_disputes row per dispute (status, Stripe's fee, evidence due date). Outcome is
 * set once (won, or warning_closed with no money lost, = won; lost = lost) and never changes after. S7: one admin email
 * when it opens, one when it closes.
 *   S4 ticket order, open before the payout is created: createDuePayouts holds that order's host share (held_cents,
 *      event_payouts.dispute_held_cents) after Outsyde's debt and team pay. Lost before the payout: held the same way
 *      and never paid. Won after the hold: the held part goes to the host in one transfer once the payout is paid
 *      (claim + 10 minute lock, lookup by transfer group before every create, one key per claim).
 *   S5 ticket order lost: recoveries per ticket for the host share that was paid (share minus what was held) plus
 *      Stripe's dispute fee on the first ticket, once the payout is paid. They go through processRecovery like refunds.
 *   S6 booking lost: recordBookingRefund with refund id dispute_<id> for the dispute amount (seller share, no fee).
 *   Product orders and unknown charges: recorded and emailed only.
 */
import { sql } from "drizzle-orm";
import { rows } from "../events/eventsRouter";

/** 2026-11-01 00:00 UTC. Dashboard refunds Stripe created before this are never applied (same idea as #350's start date). */
export const SYNC_START_UNIX = 1793491200;
export const SYNC_EVENT_TYPES = ["charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"];
/** The backstop reads this far back (Stripe keeps events 30 days). */
export const SYNC_LOOKBACK_DAYS = 3;
export const SYNC_EVENTS_EVERY_MINUTES = 15;
const SYNC_MAX_PAGES = 10;
export const RELEASE_LOCK_MINUTES = 10;
export const RELEASE_MAX_ATTEMPTS = 5;
const STRIPE_CALL_BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };

type StripeServiceT = typeof import("./stripeService").stripeService;
export type SyncStripe = Pick<StripeServiceT, "listChargeRefunds" | "listSyncEvents" | "findDisputeReleaseTransfer" | "createDisputeReleaseTransfer">;
async function realStripe(): Promise<SyncStripe> {
  const { stripeService } = await import("./stripeService");
  return stripeService;
}

type Kind = "appointment" | "shoot_booking" | "ticket_order" | "order" | "unknown";
const KIND_TEXT: Record<Kind, string> = {
  appointment: "booking", shoot_booking: "photo shoot booking", ticket_order: "event ticket order", order: "product order", unknown: "a charge Outsyde can't match (for example a subscription)",
};

let alertForTest: ((subject: string, detail: string) => Promise<void>) | null = null;
/** Test seam only: records admin emails instead of sending them. Never set in production. */
export function setStripeSyncAlertForTest(fn: ((subject: string, detail: string) => Promise<void>) | null): void { alertForTest = fn; }

/** Internal [Payouts] email (no log tag, like every admin alert). Never throws. */
async function alert(subject: string, detail: string): Promise<void> {
  try {
    if (alertForTest) return await alertForTest(subject, detail);
    const { sendAdminEmail, ADMIN_NOTIFICATION_EMAIL } = await import("../emailService");
    await sendAdminEmail({ to: ADMIN_NOTIFICATION_EMAIL, subject: `[Payouts] ${subject}`, html: `<p>${detail.replace(/[<>&]/g, "")}</p>` });
  } catch (err) {
    console.error("[StripeSync] admin alert failed:", err);
  }
}

const usd = (cents: number) => `$${(Number(cents) / 100).toFixed(2)}`;
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).id === "string" ? (v as any).id : null);
const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300);

/** The sale behind a PaymentIntent: bookings first, then ticket orders, then product orders (first one on a shared cart PaymentIntent). */
async function findSale(pi: string | null): Promise<{ kind: Kind; id: string | null }> {
  if (!pi) return { kind: "unknown", id: null };
  const [r] = await rows<any>(sql`
    SELECT kind, id FROM (
      SELECT 'appointment' AS kind, id::text AS id, 1 AS o FROM appointments WHERE stripe_payment_intent_id = ${pi}
      UNION ALL SELECT 'shoot_booking', id::text, 2 FROM shoot_bookings WHERE stripe_payment_intent_id = ${pi}
      UNION ALL SELECT 'ticket_order', id::text, 3 FROM ticket_orders WHERE stripe_payment_intent_id = ${pi}
      UNION ALL SELECT 'order', id::text, 4 FROM orders WHERE stripe_payment_intent_id = ${pi}
    ) s ORDER BY o, id LIMIT 1`);
  return r ? { kind: r.kind as Kind, id: r.id as string } : { kind: "unknown", id: null };
}

export function isSyncEventType(type: unknown): boolean {
  return typeof type === "string" && SYNC_EVENT_TYPES.includes(type);
}

/** Webhook and backstop entry point for one Stripe event of SYNC_EVENT_TYPES. */
export async function handleSyncEvent(event: any, s?: SyncStripe): Promise<void> {
  if (!event || !isSyncEventType(event.type)) return;
  if (event.account) return; // a connected account's own event, never an Outsyde sale
  const obj = event.data?.object;
  if (!obj) return;
  if (event.type === "charge.refunded") await syncChargeRefunds(obj, s);
  else await syncDispute(obj, s);
}

// ─── Refunds ────────────────────────────────────────────────────────────────

async function isOwnRefundId(refundId: string): Promise<boolean> {
  const [r] = await rows<any>(sql`
    SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM appointments WHERE stripe_refund_id = ${refundId})
       OR EXISTS (SELECT 1 FROM shoot_bookings WHERE stripe_refund_id = ${refundId})
       OR EXISTS (SELECT 1 FROM ticket_orders WHERE stripe_refund_id = ${refundId})`);
  return !!r;
}

/** Applies every dashboard refund on this charge that isn't applied yet. Returns how many were applied now. */
export async function syncChargeRefunds(charge: any, s?: SyncStripe): Promise<number> {
  const chargeId = idOf(charge);
  if (!chargeId) return 0;
  const pi = idOf(charge.payment_intent);
  const captured = Number(charge.amount_captured ?? charge.amount ?? 0);
  const full = captured > 0 && Number(charge.amount_refunded ?? 0) >= captured;
  const st = s ?? (await realStripe());
  const refunds = await st.listChargeRefunds(chargeId, STRIPE_CALL_BOUND);
  const candidates = refunds
    .filter((r) => r.status !== "failed" && r.status !== "canceled" && r.amount > 0 && r.created >= SYNC_START_UNIX)
    .filter((r) => Object.keys(r.metadata ?? {}).length === 0)
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  if (!candidates.length) return 0;
  const sale = await findSale(pi);
  let applied = 0;
  for (const r of candidates) {
    if (await isOwnRefundId(r.id)) continue;
    const did = await applyRefund({ refundId: r.id, chargeId, pi, amount: r.amount, createdUnix: r.created, full }, sale);
    if (did) {
      applied++;
      await alert(`Refund made in Stripe: ${usd(r.amount)}`,
        `Refund ${r.id} of ${usd(r.amount)} on PaymentIntent ${pi ?? "none"} (charge ${chargeId}) was made in the Stripe dashboard. ` +
        `Sale: ${KIND_TEXT[sale.kind]}${sale.id ? ` ${sale.id}` : ""}. ${did}`);
    }
  }
  return applied;
}

type RefundInput = { refundId: string; chargeId: string; pi: string | null; amount: number; createdUnix: number; full: boolean };

/** One statement per sale type: records the refund and applies it, or does nothing when already recorded. Returns what Outsyde did, or null. */
async function applyRefund(r: RefundInput, sale: { kind: Kind; id: string | null }): Promise<string | null> {
  const ins = sql`
    INSERT INTO stripe_dashboard_refunds (refund_id, charge_id, payment_intent_id, amount_cents, full_refund, kind, reference_id, refund_created_at)
    VALUES (${r.refundId}, ${r.chargeId}, ${r.pi}, ${r.amount}, ${r.full}, ${sale.kind}, ${sale.id}, to_timestamp(${r.createdUnix}))
    ON CONFLICT (refund_id) DO NOTHING
    RETURNING id`;
  if (sale.kind === "appointment" || sale.kind === "shoot_booking") {
    const table = sale.kind === "appointment" ? sql`appointments` : sql`shoot_bookings`;
    const [x] = await rows<any>(sql`
      WITH ins AS (${ins}),
      upd AS (
        UPDATE ${table} SET refund_amount = COALESCE(refund_amount, 0) + ${r.amount}, refunded_at = now(),
               status = CASE WHEN ${r.full} AND status IN ('confirmed', 'in_progress', 'completed') THEN 'refunded' ELSE status END,
               updated_at = now()
        WHERE id = ${sale.id} AND EXISTS (SELECT 1 FROM ins)
        RETURNING id, status
      )
      SELECT (SELECT id FROM ins) AS ins_id, (SELECT status FROM upd) AS status`);
    if (!x?.ins_id) return null;
    if (r.pi) {
      const { recordBookingRefund } = await import("../bookingRecoveries");
      await recordBookingRefund({ refundId: r.refundId, paymentIntentId: r.pi, refundCents: r.amount, createdUnix: r.createdUnix });
    }
    return `Saved on the booking (now ${x.status ?? "unchanged"}); the seller's share will be taken back like an in-app refund.`;
  }
  if (sale.kind === "ticket_order") {
    const reason = `refund of ${usd(r.amount)} made in the Stripe dashboard (${r.refundId})`;
    const [x] = await rows<any>(sql`
      WITH ins AS (${ins}),
      o AS (
        UPDATE ticket_orders SET
               status = CASE WHEN ${r.full} AND status = 'completed' THEN 'refunded' ELSE status END,
               refunded_cents = LEAST(total_cents, refunded_cents + ${r.amount}),
               refunded_at = CASE WHEN ${r.full} AND status = 'completed' THEN now() ELSE refunded_at END,
               needs_review_at = CASE WHEN ${r.full} AND status = 'completed' THEN needs_review_at ELSE COALESCE(needs_review_at, now()) END,
               review_reason = CASE WHEN ${r.full} AND status = 'completed' THEN review_reason ELSE COALESCE(review_reason, ${reason}) END,
               updated_at = now()
        WHERE id = ${sale.id} AND EXISTS (SELECT 1 FROM ins)
        RETURNING id, status, needs_review_at
      ),
      tk AS (
        UPDATE tickets t SET status = 'refunded', refunded_at = now()
        FROM o WHERE ${r.full} AND o.status = 'refunded' AND t.order_id = o.id AND t.status = 'valid'
        RETURNING t.id
      )
      SELECT (SELECT id FROM ins) AS ins_id, (SELECT status FROM o) AS status, (SELECT needs_review_at FROM o) AS review,
             (SELECT count(*) FROM tk)::int AS tickets`);
    if (!x?.ins_id) return null;
    return x.status === "refunded" && !x.review
      ? `Order refunded and its ${x.tickets} ticket(s) cancelled. The host share leaves the payout, or is taken back if the payout was sent.`
      : "Partial refund saved on the order. Tickets stay valid and the order is flagged for review; Outsyde covers it unless you act.";
  }
  if (sale.kind === "order") {
    const [x] = await rows<any>(sql`
      WITH ins AS (${ins}),
      upd AS (
        UPDATE orders SET status = 'refunded', updated_at = now()
        WHERE stripe_payment_intent_id = ${r.pi} AND ${r.full} AND status IN ('paid', 'shipped', 'delivered') AND EXISTS (SELECT 1 FROM ins)
        RETURNING id
      )
      SELECT (SELECT id FROM ins) AS ins_id, (SELECT count(*) FROM upd)::int AS orders`);
    if (!x?.ins_id) return null;
    return x.orders > 0
      ? `${x.orders} order(s) marked refunded. Nothing was taken back from the vendor.`
      : "Order status not changed (partial refund, or the order is already closed). Nothing was taken back from the vendor.";
  }
  const [x] = await rows<any>(sql`${ins}`);
  return x?.id ? "Recorded only." : null;
}

// ─── Disputes ───────────────────────────────────────────────────────────────

function outcomeOf(status: string): "won" | "lost" | null {
  if (status === "won" || status === "warning_closed") return "won";
  if (status === "lost") return "lost";
  return null;
}

/** Saves or updates the dispute, sends the opened and closed emails once each, then settles it if it is closed. */
export async function syncDispute(d: any, s?: SyncStripe): Promise<void> {
  const disputeId = idOf(d);
  if (!disputeId) return;
  const pi = idOf(d.payment_intent);
  const chargeId = idOf(d.charge);
  const status = String(d.status ?? "unknown");
  const outcome = outcomeOf(status);
  const fee = Math.max(0, ...((d.balance_transactions ?? []) as any[]).filter((t) => Number(t?.amount) < 0).map((t) => Number(t?.fee ?? 0)));
  const due = Number(d.evidence_details?.due_by ?? 0) || null;
  const sale = await findSale(pi);
  const [row] = await rows<any>(sql`
    INSERT INTO stripe_disputes (dispute_id, charge_id, payment_intent_id, kind, reference_id, amount_cents, fee_cents, reason, status, outcome,
      evidence_due_by, opened_at, closed_at)
    VALUES (${disputeId}, ${chargeId}, ${pi}, ${sale.kind}, ${sale.id}, ${Number(d.amount ?? 0)}, ${fee}, ${d.reason ?? null}, ${status}, ${outcome},
      CASE WHEN ${due}::bigint IS NULL THEN NULL ELSE to_timestamp(${due}::bigint) END, to_timestamp(${Number(d.created ?? Math.floor(Date.now() / 1000))}),
      CASE WHEN ${outcome}::text IS NULL THEN NULL ELSE now() END)
    ON CONFLICT (dispute_id) DO UPDATE SET
      status = CASE WHEN stripe_disputes.outcome IS NOT NULL THEN stripe_disputes.status ELSE EXCLUDED.status END,
      outcome = COALESCE(stripe_disputes.outcome, EXCLUDED.outcome),
      closed_at = COALESCE(stripe_disputes.closed_at, EXCLUDED.closed_at),
      fee_cents = GREATEST(stripe_disputes.fee_cents, EXCLUDED.fee_cents),
      evidence_due_by = COALESCE(EXCLUDED.evidence_due_by, stripe_disputes.evidence_due_by),
      updated_at = now()
    RETURNING id, kind, reference_id, amount_cents, fee_cents, outcome, evidence_due_by`);
  if (!row) return;
  const what = `${KIND_TEXT[row.kind as Kind]}${row.reference_id ? ` ${row.reference_id}` : ""}`;
  const [opened] = await rows<any>(sql`UPDATE stripe_disputes SET opened_alerted_at = now() WHERE id = ${row.id} AND opened_alerted_at IS NULL RETURNING id`);
  if (opened) {
    const dueText = row.evidence_due_by ? new Date(row.evidence_due_by).toLocaleString("en-US", { timeZone: "America/New_York" }) : "not given";
    await alert(`Dispute opened: ${usd(row.amount_cents)}`,
      `Dispute ${disputeId} of ${usd(row.amount_cents)} (reason: ${d.reason ?? "not given"}) on PaymentIntent ${pi ?? "none"}. Sale: ${what}. ` +
      `Evidence is due by ${dueText} New York time. Respond in the Stripe dashboard. Nothing is taken from the seller or host unless it is lost.`);
  }
  if (row.outcome) {
    const [closed] = await rows<any>(sql`UPDATE stripe_disputes SET closed_alerted_at = now() WHERE id = ${row.id} AND closed_alerted_at IS NULL RETURNING id`);
    if (closed) {
      const after = row.outcome === "won" ? "Nothing is taken back. Any host share held for it is sent to the host."
        : row.kind === "ticket_order" ? `The host pays back their share plus Stripe's ${usd(row.fee_cents)} fee.`
        : row.kind === "appointment" || row.kind === "shoot_booking" ? "The seller's share is taken back (Outsyde keeps Stripe's fee)."
        : "Recorded only.";
      await alert(`Dispute ${row.outcome}: ${usd(row.amount_cents)}`, `Dispute ${disputeId} on PaymentIntent ${pi ?? "none"} was ${row.outcome}. Sale: ${what}. ${after}`);
    }
    await settleDispute(disputeId, s);
  }
}

/** Finishes a closed dispute: recovery for a lost one, release for a won one that was held. Safe to run any number of times. */
export async function settleDispute(disputeId: string, s?: SyncStripe): Promise<"settled" | "waiting" | "released" | "retry" | "none"> {
  const [d] = await rows<any>(sql`SELECT * FROM stripe_disputes WHERE dispute_id = ${disputeId}`);
  if (!d || !d.outcome || d.settled_at) return "none";
  const settle = async () => { await rows<any>(sql`UPDATE stripe_disputes SET settled_at = now(), updated_at = now() WHERE id = ${d.id} AND settled_at IS NULL RETURNING id`); return "settled" as const; };

  if (d.kind === "appointment" || d.kind === "shoot_booking") {
    if (d.outcome === "lost" && d.payment_intent_id && Number(d.amount_cents) > 0) {
      const { recordBookingRefund } = await import("../bookingRecoveries");
      const closed = Math.floor(new Date(d.closed_at ?? Date.now()).getTime() / 1000);
      await recordBookingRefund({ refundId: `dispute_${disputeId}`, paymentIntentId: d.payment_intent_id, refundCents: Number(d.amount_cents), createdUnix: closed });
    }
    return settle();
  }
  if (d.kind !== "ticket_order" || !d.reference_id) return settle();

  if (d.outcome === "won") {
    if (Number(d.held_cents) <= 0 || d.release_transfer_id) return settle();
    return releaseHeld(d, s);
  }

  // Lost: the paid part of the host share plus Stripe's fee, once the event's payout has been sent (or was $0).
  const [made] = await rows<any>(sql`
    WITH dd AS (
      SELECT id, reference_id, held_cents, fee_cents FROM stripe_disputes
      WHERE id = ${d.id} AND outcome = 'lost' AND settled_at IS NULL
      FOR UPDATE
    ),
    p AS (
      SELECT p.id, p.transfer_id, p.amount_cents,
             COALESCE(p.connected_account_id,
               CASE WHEN e.host_type = 'business' AND e.host_business_id IS NOT NULL THEN (SELECT b.stripe_account_id FROM businesses b WHERE b.id = e.host_business_id)
                    WHEN e.host_type = 'photographer' AND e.host_photographer_id IS NOT NULL THEN (SELECT ph.stripe_account_id FROM photographers ph WHERE ph.id = e.host_photographer_id)
                    ELSE (SELECT u.stripe_account_id FROM user_payout_accounts u WHERE u.user_id = e.host_user_id) END) AS acct
      FROM event_payouts p JOIN ticket_orders o ON o.event_id = p.event_id JOIN events e ON e.id = p.event_id
      WHERE o.id = (SELECT reference_id FROM dd) AND p.status = 'paid'
    ),
    tk AS (
      SELECT t.id, t.host_net_cents, row_number() OVER (ORDER BY t.item_index, t.id) AS n,
             sum(t.host_net_cents) OVER (ORDER BY t.item_index, t.id) AS cum
      FROM tickets t WHERE t.order_id = (SELECT reference_id FROM dd) AND t.payout_id = (SELECT id FROM p)
    ),
    paid AS (SELECT GREATEST(0, COALESCE(sum(host_net_cents), 0) - (SELECT held_cents FROM dd))::int AS amt FROM tk),
    amt AS (
      SELECT tk.id, (GREATEST(0, LEAST(tk.host_net_cents, paid.amt - (tk.cum - tk.host_net_cents)))
                     + CASE WHEN tk.n = 1 THEN (SELECT fee_cents FROM dd) ELSE 0 END)::int AS amount
      FROM tk, paid
    ),
    ins AS (
      INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, last_error)
      SELECT amt.id, p.id, p.acct, amt.amount,
             CASE WHEN p.transfer_id IS NULL THEN 'owed' ELSE 'pending' END,
             CASE WHEN p.transfer_id IS NULL THEN 'dispute lost; the payout was $0, so there is no transfer to take it back from' END
      FROM amt, p WHERE amt.amount > 0 AND p.acct IS NOT NULL
      ON CONFLICT (ticket_id) DO NOTHING
      RETURNING id
    ),
    st AS (
      UPDATE stripe_disputes SET settled_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM dd) AND EXISTS (SELECT 1 FROM p WHERE p.acct IS NOT NULL)
      RETURNING id
    )
    SELECT (SELECT count(*) FROM ins)::int AS opened, EXISTS (SELECT 1 FROM st) AS settled`);
  return made?.settled ? "settled" : "waiting";
}

const OWNER_TAG = sql`(extract(epoch from updated_at) * 1000000)::bigint::text`;

/**
 * S4 won: send the held host share to the host once the event payout is paid. Claim first (attempts + 1, 10 minute lock),
 * look the transfer up by its group before every create (a timed out create may still land), one key per claim, and save
 * only while the claim still owns the row. Never decides "it didn't happen" in the try whose call failed.
 */
async function releaseHeld(d: any, s?: SyncStripe): Promise<"released" | "waiting" | "retry"> {
  const [c] = await rows<any>(sql`
    UPDATE stripe_disputes sd SET release_attempts = release_attempts + 1,
           release_next_at = now() + make_interval(mins => ${RELEASE_LOCK_MINUTES}::int), updated_at = now()
    FROM event_payouts p
    WHERE sd.id = ${d.id} AND sd.outcome = 'won' AND sd.held_cents > 0 AND sd.release_transfer_id IS NULL AND sd.settled_at IS NULL
      AND (sd.release_next_at IS NULL OR sd.release_next_at <= now())
      AND p.id = sd.held_payout_id AND p.status = 'paid' AND p.connected_account_id IS NOT NULL
    RETURNING sd.id, sd.dispute_id, sd.held_cents, sd.release_attempts, p.id AS payout_id, p.event_id, p.connected_account_id,
              (extract(epoch from sd.updated_at) * 1000000)::bigint::text AS tag`);
  if (!c) return "waiting"; // payout not sent yet, another run holds the lock, or already released
  const st = s ?? (await realStripe());
  try {
    let transferId: string | null = (await st.findDisputeReleaseTransfer(c.dispute_id, STRIPE_CALL_BOUND))?.id ?? null;
    if (!transferId) {
      const t = await st.createDisputeReleaseTransfer({
        disputeId: c.dispute_id, eventId: c.event_id, payoutId: c.payout_id, destination: c.connected_account_id,
        amountCents: Number(c.held_cents), idempotencyKey: `dispute_release_${c.dispute_id}_${c.tag}`, ...STRIPE_CALL_BOUND,
      });
      transferId = t.id;
    }
    await rows<any>(sql`
      UPDATE stripe_disputes SET release_transfer_id = ${transferId}, settled_at = now(), release_next_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${c.id} AND release_transfer_id IS NULL AND ${OWNER_TAG} = ${c.tag}
      RETURNING id`);
    return "released";
  } catch (err) {
    const msg = errText(err);
    console.error(`[StripeSync] release for dispute ${c.dispute_id} failed (try ${c.release_attempts}):`, msg);
    await rows<any>(sql`UPDATE stripe_disputes SET last_error = ${msg}, updated_at = now() WHERE id = ${c.id} AND ${OWNER_TAG} = ${c.tag} RETURNING id`).catch(() => []);
    if (Number(c.release_attempts) === RELEASE_MAX_ATTEMPTS) {
      await alert("Held dispute money not sent", `Sending ${usd(c.held_cents)} held for won dispute ${c.dispute_id} to ${c.connected_account_id} failed ${c.release_attempts} times. Last error: ${msg}. It keeps retrying every ${RELEASE_LOCK_MINUTES} minutes.`);
    }
    return "retry";
  }
}

// ─── The job ────────────────────────────────────────────────────────────────

/**
 * listEvents (every 15 minutes from the every-minute job, always when called with no options): reads Stripe's own
 * refund and dispute events of the last 3 days and handles each one again (each is a no-op once handled). Then, every
 * run: settles closed disputes that are still open on Outsyde's side.
 */
export async function runStripeSyncJob(s?: SyncStripe, opts: { listEvents?: boolean } = {}): Promise<{ events: number; settled: number }> {
  const out = { events: 0, settled: 0 };
  if (opts.listEvents !== false) {
    try {
      const st = s ?? (await realStripe());
      const createdGte = Math.max(SYNC_START_UNIX, Math.floor(Date.now() / 1000) - SYNC_LOOKBACK_DAYS * 86400);
      let startingAfter: string | undefined;
      for (let page = 0; page < SYNC_MAX_PAGES; page++) {
        const res = await st.listSyncEvents({ types: SYNC_EVENT_TYPES, createdGte, startingAfter }, STRIPE_CALL_BOUND);
        for (const ev of res.data) {
          try { await handleSyncEvent(ev, st); out.events++; }
          catch (err) { console.error(`[StripeSync] event ${ev?.id} failed:`, errText(err)); }
        }
        if (!res.hasMore || !res.data.length) break;
        startingAfter = res.data[res.data.length - 1].id;
      }
    } catch (err) {
      console.error("[StripeSync] event list step failed:", errText(err));
    }
  }
  try {
    const due = await rows<{ dispute_id: string }>(sql`
      SELECT dispute_id FROM stripe_disputes
      WHERE outcome IS NOT NULL AND settled_at IS NULL AND (release_next_at IS NULL OR release_next_at <= now())
      ORDER BY closed_at NULLS FIRST, dispute_id LIMIT 50`);
    for (const { dispute_id } of due) {
      try { if ((await settleDispute(dispute_id, s)) !== "waiting") out.settled++; }
      catch (err) { console.error(`[StripeSync] settle ${dispute_id} failed:`, errText(err)); }
    }
  } catch (err) {
    console.error("[StripeSync] settle step failed:", errText(err));
  }
  return out;
}
