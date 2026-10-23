/**
 * Events & Ticketing Phase 2, PR 4: refunds and host cancel.
 *
 *   POST /api/events/orders/:orderId/refund          (auth, buyer)  refund my paid order while the host's policy allows it
 *   GET  /api/events/:id/orders                      (auth, host)   orders for my event (to pick one to refund)
 *   POST /api/events/:id/orders/:orderId/refund      (auth, host)   refund one order, any time
 *   (host cancel with guests lives in eventsRouter POST /:id/cancel and calls queueCancelledEventOrders here)
 *
 * Amounts (Legend 2026-10-19): buyer or host refund of one order = the ticket price back, Outsyde keeps the
 * service fee. Host cancels the event = everything back, fees included (Outsyde absorbs the Stripe fee).
 *
 * Two steps, so a Stripe error can never lose a refund (migration 060):
 *   1. ONE statement records it: order -> 'refunding' with the amount and reason, seats back on sale (same
 *      reopen rule as a cancelled RSVP, only while the event is published and hasn't started), tickets -> 'refunded'.
 *   2. Stripe refund with the fixed key ticket_refund_<orderId>_<reason>. Before asking, Stripe's own record of
 *      what was already refunded is checked, so a refund that went through but wasn't saved is never sent twice.
 *      Success -> 'refunded'. An error waits and the every-minute job tries again; after 5 tries the order is
 *      flagged for review and the admin is emailed once.
 * Ticket money sits on Outsyde's Stripe balance until the host payout (no transfer yet), so nothing is clawed back.
 */
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { rows, iso, fail, loadActiveUser, loadEventForHost } from "./eventsRouter";
import { guardCode, withDeadlockRetry, orderWithTickets } from "./ticketsRouter";
import { flagForReview, releasePendingTicketOrder } from "./ticketCheckout";
import { HOST_PAYOUT_DELAY_DAYS } from "./payoutTiming";
import { payoutStatusFor } from "./payoutStatus";
import { notifyOrderRefunded, notifyFreeOrdersCancelled } from "./ticketNotices";

const router = Router();

export const REFUND_MAX_ATTEMPTS = 5;
export type RefundReason = "buyer" | "host" | "event_cancelled";

export type RefundStripe = {
  getPaymentIntentForRefund(id: string): Promise<{ status: string; amountReceived: number; amountRefunded: number }>;
  createBookingRefund(p: {
    paymentIntentId: string; amountCents?: number; reason?: "requested_by_customer";
    metadata?: Record<string, string>; idempotencyKey?: string;
  }): Promise<{ id: string; status?: string | null }>;
  cancelPaymentIntent(id: string, reason?: "abandoned"): Promise<unknown>;
};

async function realStripe(): Promise<RefundStripe> {
  const { stripeService } = await import("../stripe/stripeService");
  return stripeService as unknown as RefundStripe;
}

export const refundKey = (orderId: string, reason: RefundReason) => `ticket_refund_${orderId}_${reason}`;

/** Wait before try n+1: 1, 2, 4, 8 minutes, at most 60. */
export function refundBackoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

// ─── Step 1: record the refund (one statement) ──────────────────────────────

export type RequestResult = { ok: true; orderId: string } | { ok: false };

/**
 * completed paid order -> 'refunding'. Buyer: only the buyer, only while the host's policy allows it, never
 * after a ticket was checked in. Host: only the event's host, any time while the event isn't cancelled or paused.
 * Seats go back on sale only while the event is published and hasn't started.
 */
export async function requestOrderRefund(orderId: string, actorUserId: string, by: "buyer" | "host"): Promise<RequestResult> {
  const who = by === "buyer"
    ? sql`o.buyer_user_id = ${actorUserId} AND e.status = 'published'
          AND e.refund_policy = 'until_cutoff' AND e.refund_cutoff_hours IS NOT NULL
          AND now() < e.starts_at - make_interval(hours => e.refund_cutoff_hours)
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id AND t.checked_in_at IS NOT NULL)`
    : sql`e.host_user_id = ${actorUserId} AND e.status = 'published'`;
  const [r] = await withDeadlockRetry(() => rows<any>(sql`
    WITH o AS (
      UPDATE ticket_orders o SET status = 'refunding', refund_reason = ${by},
             refund_amount_cents = LEAST(o.total_cents - o.refunded_cents, GREATEST(0, o.subtotal_cents + o.tax_cents - o.discount_cents)),
             refund_requested_at = now(), refund_requested_by = ${actorUserId}, refund_attempts = 0,
             refund_next_attempt_at = now() + interval '2 minutes', refund_last_error = NULL, updated_at = now()
      FROM events e
      WHERE o.id = ${orderId} AND e.id = o.event_id AND o.status = 'completed' AND o.total_cents > 0
        AND o.subtotal_cents + o.tax_cents - o.discount_cents > 0 AND ${who}
      RETURNING o.id, o.event_id, o.buyer_user_id, o.ticket_count, (e.starts_at > now()) AS live
    ),
    it AS (
      UPDATE ticket_order_items i SET status = 'released', updated_at = now()
      FROM o WHERE o.live AND i.order_id = o.id AND i.status = 'issued'
      RETURNING i.ticket_type_id, i.quantity
    ),
    kids AS (
      SELECT n.unlock_after_ticket_type_id AS parent_id, n.reserved_count FROM ticket_types n
      WHERE n.unlock_after_ticket_type_id IN (SELECT ticket_type_id FROM it)
      FOR UPDATE
    ),
    tt AS (
      UPDATE ticket_types t SET reserved_count = t.reserved_count - it.quantity, updated_at = now()
      FROM it WHERE t.id = it.ticket_type_id
        AND NOT EXISTS (SELECT 1 FROM kids WHERE kids.parent_id = t.id AND kids.reserved_count > 0)
      RETURNING t.id
    ),
    ev AS (
      UPDATE events e SET reserved_count = e.reserved_count - o.ticket_count, updated_at = now()
      FROM o WHERE o.live AND e.id = o.event_id AND e.status = 'published' AND e.starts_at > now()
      RETURNING e.id
    ),
    ac AS (
      UPDATE ticket_account_counts a SET count = a.count - it.quantity, updated_at = now()
      FROM it, o WHERE a.ticket_type_id = it.ticket_type_id AND a.user_id = o.buyer_user_id
      RETURNING 1
    ),
    tk AS (
      UPDATE tickets t SET status = 'refunded', refunded_at = now()
      FROM o WHERE t.order_id = o.id AND t.status = 'valid'
      RETURNING t.id
    )
    SELECT (SELECT id FROM o) AS order_id,
           CASE WHEN EXISTS (SELECT 1 FROM o WHERE o.live) AND (
                  NOT EXISTS (SELECT 1 FROM ev)
               OR (SELECT count(*) FROM ac) <> (SELECT count(*) FROM it)
               OR (SELECT COALESCE(sum(quantity), 0) FROM it) <> (SELECT ticket_count FROM o))
             THEN ('GUARD_REFUND_SEATS:' || (SELECT count(*) FROM it))::int END AS guard_seats,
           CASE WHEN EXISTS (SELECT 1 FROM o) AND (SELECT count(*) FROM tk) <> (SELECT ticket_count FROM o)
             THEN ('GUARD_REFUND_TICKETS:' || (SELECT count(*) FROM tk))::int END AS guard_tickets`));
  return r?.order_id ? { ok: true, orderId: r.order_id } : { ok: false };
}

// ─── Host cancels the event ─────────────────────────────────────────────────

/**
 * For a cancelled event (or every cancelled event when eventId is null, used by the job as a backstop):
 * free RSVPs -> cancelled; paid orders -> 'refunding' for everything not yet refunded, fees included. That
 * also tops up an earlier buyer or host refund (which kept the service fee). Orders already 'refunding' are
 * left alone until they finish, then the next run tops them up. Seat counts aren't touched: the event is closed.
 */
export async function queueCancelledEventOrders(eventId: string | null): Promise<{ freeCancelled: string[]; refunding: string[] }> {
  const [r] = await withDeadlockRetry(() => rows<any>(sql`
    WITH ce AS (
      SELECT id FROM events WHERE status = 'cancelled' AND (${eventId}::text IS NULL OR id = ${eventId}::text)
    ),
    fo AS (
      UPDATE ticket_orders o SET status = 'cancelled', cancelled_at = now(), updated_at = now()
      FROM ce WHERE o.event_id = ce.id AND o.status = 'completed' AND o.total_cents = 0
      RETURNING o.id
    ),
    ftk AS (
      UPDATE tickets t SET status = 'cancelled', cancelled_at = now()
      FROM fo WHERE t.order_id = fo.id AND t.status = 'valid'
      RETURNING 1
    ),
    po AS (
      UPDATE ticket_orders o SET status = 'refunding', refund_reason = 'event_cancelled',
             refund_amount_cents = o.total_cents - o.refunded_cents, refund_requested_at = now(),
             refund_requested_by = NULL, refund_attempts = 0,
             -- From the cancel request: that request sends these right away, so the job waits 2 minutes.
             -- From the job's own sweep: nobody else will, so they're due now.
             refund_next_attempt_at = CASE WHEN ${eventId}::text IS NULL THEN now() ELSE now() + interval '2 minutes' END,
             refund_last_error = NULL, updated_at = now()
      FROM ce WHERE o.event_id = ce.id AND o.total_cents > o.refunded_cents AND o.needs_review_at IS NULL
        AND (o.status = 'completed' OR (o.status = 'refunded' AND o.refund_reason IS DISTINCT FROM 'event_cancelled'))
      RETURNING o.id
    ),
    ptk AS (
      UPDATE tickets t SET status = 'refunded', refunded_at = now()
      FROM po WHERE t.order_id = po.id AND t.status = 'valid'
      RETURNING 1
    )
    SELECT (SELECT string_agg(id, ',') FROM fo) AS free_ids, (SELECT string_agg(id, ',') FROM po) AS paid_ids,
           (SELECT count(*) FROM ftk) AS free_tickets, (SELECT count(*) FROM ptk) AS paid_tickets`));
  // Plain text, not a Postgres array: array results don't come back reliably through every driver.
  const ids = (v: unknown) => (typeof v === "string" && v ? v.split(",") : []);
  return { freeCancelled: ids(r?.free_ids), refunding: ids(r?.paid_ids) };
}

/** Unpaid checkouts on a cancelled event: stop their payments and give the holds back. A payment that still lands is settled and then refunded by the job. */
export async function closePendingCheckouts(eventId: string, s?: Pick<RefundStripe, "cancelPaymentIntent">): Promise<number> {
  const pending = await rows<any>(sql`SELECT id, stripe_payment_intent_id FROM ticket_orders WHERE event_id = ${eventId} AND status = 'pending'`);
  let closed = 0;
  for (const p of pending) {
    try {
      if (p.stripe_payment_intent_id) await (s ?? (await realStripe())).cancelPaymentIntent(p.stripe_payment_intent_id, "abandoned");
      if (await releasePendingTicketOrder(p.id, "cancelled", p.stripe_payment_intent_id ?? null)) closed++;
    } catch (err) {
      // Already paid or Stripe unreachable: the every-minute job settles or expires it.
      console.error(`[Tickets] couldn't close checkout ${p.id} on cancelled event ${eventId}:`, (err as Error)?.message ?? err);
    }
  }
  return closed;
}

// ─── Step 2: send the refund to Stripe ──────────────────────────────────────

export type ProcessResult = "refunded" | "not_due" | "retry" | "review";

/**
 * Sends one recorded refund. Claims the order first (pushes refund_next_attempt_at out), so two runs at the
 * same time can't both call Stripe. Safe to run any number of times.
 */
export async function processTicketRefund(orderId: string, s?: RefundStripe, force = false): Promise<ProcessResult> {
  const [o] = await rows<any>(sql`
    UPDATE ticket_orders SET refund_attempts = refund_attempts + 1,
           refund_next_attempt_at = now() + make_interval(mins => LEAST(60, power(2, LEAST(refund_attempts, 6)))::int), updated_at = now()
    WHERE id = ${orderId} AND status = 'refunding' AND needs_review_at IS NULL
      AND ((${force} AND refund_attempts = 0) OR refund_next_attempt_at IS NULL OR refund_next_attempt_at <= now())
    RETURNING id, stripe_payment_intent_id, refund_reason, refund_amount_cents, refunded_cents, total_cents, refund_attempts`);
  if (!o) return "not_due";
  const amount = Number(o.refund_amount_cents);
  const already = Number(o.refunded_cents);
  const reason = o.refund_reason as RefundReason;
  try {
    if (!o.stripe_payment_intent_id) {
      await flagForReview(orderId, "refund recorded but the order has no PaymentIntent");
      return "review";
    }
    const st = s ?? (await realStripe());
    const state = await st.getPaymentIntentForRefund(o.stripe_payment_intent_id);
    let refundId: string | null = null;
    if (state.amountRefunded === already + amount) {
      // Stripe already refunded this (an earlier try went through but wasn't saved): just record it.
    } else if (state.amountRefunded !== already) {
      // Includes Stripe showing MORE refunded than expected: never record or send blind.
      await flagForReview(orderId, `Stripe shows ${state.amountRefunded} cents refunded but the order shows ${already} (refunded outside Outsyde?)`);
      return "review";
    } else if (state.status !== "succeeded" || state.amountReceived < already + amount) {
      await flagForReview(orderId, `can't refund ${amount} cents: PaymentIntent is ${state.status} with ${state.amountReceived} cents received`);
      return "review";
    } else {
      const refund = await st.createBookingRefund({
        paymentIntentId: o.stripe_payment_intent_id, amountCents: amount, reason: "requested_by_customer",
        metadata: { type: "event_ticket_refund", ticketOrderId: orderId, refundReason: reason },
        idempotencyKey: refundKey(orderId, reason),
      });
      refundId = refund.id;
    }
    const [done] = await rows<any>(sql`
      UPDATE ticket_orders SET status = 'refunded', refunded_cents = refunded_cents + refund_amount_cents, refund_amount_cents = 0,
             stripe_refund_id = COALESCE(${refundId}, stripe_refund_id), refunded_at = now(),
             refund_next_attempt_at = NULL, refund_last_error = NULL, updated_at = now()
      WHERE id = ${orderId} AND status = 'refunding' AND refund_amount_cents = ${amount}
        AND refund_reason = ${reason} AND refunded_cents = ${already}
      RETURNING id, refunded_cents`);
    // A top-up after an earlier refund shows the total now refunded, so "your full payment" reads right.
    if (done) void notifyOrderRefunded(orderId, reason, reason === "event_cancelled" ? Number(done.refunded_cents) : amount);
    return "refunded";
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    const [still] = await rows<any>(sql`
      UPDATE ticket_orders SET refund_last_error = ${msg} WHERE id = ${orderId} AND status = 'refunding' AND refund_reason = ${reason}
      RETURNING id`).catch(() => [] as any[]);
    console.error(`[Tickets] refund try ${o.refund_attempts} failed for order ${orderId}: ${msg}`);
    if (!still) return "not_due"; // finished by someone else meanwhile
    if (Number(o.refund_attempts) >= REFUND_MAX_ATTEMPTS) {
      await flagForReview(orderId, `refund failed ${o.refund_attempts} times, last error: ${msg}`);
      return "review";
    }
    return "retry";
  }
}

/** Every minute: backstop for cancelled events, then send refunds that are due (oldest due first). */
export async function runTicketRefundJob(s?: RefundStripe): Promise<{ refunded: number; retry: number; review: number }> {
  const out = { refunded: 0, retry: 0, review: 0 };
  try {
    const q = await queueCancelledEventOrders(null);
    if (q.freeCancelled.length) void notifyFreeOrdersCancelled(q.freeCancelled);
  } catch (err) {
    console.error("[Tickets] cancelled event sweep failed:", (err as Error)?.message ?? err);
  }
  try {
    // Open checkouts on cancelled events (the cancel request closes them; this repeats it if that failed).
    const open = await rows<any>(sql`
      SELECT DISTINCT o.event_id FROM ticket_orders o JOIN events e ON e.id = o.event_id
      WHERE o.status = 'pending' AND e.status = 'cancelled' LIMIT 10`);
    for (const e of open) await closePendingCheckouts(e.event_id, s);
  } catch (err) {
    console.error("[Tickets] closing checkouts on cancelled events failed:", (err as Error)?.message ?? err);
  }
  const due = await rows<any>(sql`
    SELECT id FROM ticket_orders
    WHERE status = 'refunding' AND needs_review_at IS NULL AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= now())
    ORDER BY refund_next_attempt_at NULLS FIRST LIMIT 25`);
  for (const d of due) {
    const r = await processTicketRefund(d.id, s);
    if (r === "refunded") out.refunded++;
    else if (r === "retry") out.retry++;
    else if (r === "review") out.review++;
  }
  if (out.refunded || out.retry || out.review) console.log(`[Tickets] refund job: refunded ${out.refunded}, retry ${out.retry}, review ${out.review}`);
  return out;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

function refundGuardMessage(res: Response, err: unknown): boolean {
  const g = guardCode(err);
  if (g !== "REFUND_SEATS" && g !== "REFUND_TICKETS") return false;
  fail(res, 409, "TRY_AGAIN", "Something changed. Try again.");
  return true;
}

async function orderForResponse(orderId: string, buyerId: string) {
  const order = await orderWithTickets(orderId, buyerId);
  const [m] = await rows<any>(sql`SELECT refunded_cents, refund_amount_cents, refund_reason FROM ticket_orders WHERE id = ${orderId}`);
  return order && m ? { ...order, refundedCents: Number(m.refunded_cents), refundPendingCents: Number(m.refund_amount_cents), refundReason: m.refund_reason } : order;
}

router.post("/orders/:orderId/refund", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to ask for a refund.");
  const orderId = String(req.params.orderId);
  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't change orders.");
    const r = await requestOrderRefund(orderId, userId, "buyer");
    if (r.ok) {
      // Recorded: whatever happens next, the job finishes it, so answer with the saved state.
      await processTicketRefund(orderId, undefined, true).catch((err) => console.error(`[Tickets] refund ${orderId} left for the job:`, err));
      return res.json({ success: true, order: await orderForResponse(orderId, userId) });
    }
    const [o] = await rows<any>(sql`
      SELECT o.status, o.total_cents, o.subtotal_cents + o.tax_cents - o.discount_cents AS price_paid,
             e.status AS event_status, e.starts_at, e.refund_policy, e.refund_cutoff_hours,
             EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id AND t.checked_in_at IS NOT NULL) AS checked_in
      FROM ticket_orders o JOIN events e ON e.id = o.event_id WHERE o.id = ${orderId} AND o.buyer_user_id = ${userId}`);
    if (!o) return fail(res, 404, "ORDER_NOT_FOUND", "Order not found.");
    if (o.status === "refunding" || o.status === "refunded") return fail(res, 409, "ALREADY_REFUNDED", "This order was already refunded.");
    if (Number(o.total_cents) === 0) return fail(res, 409, "FREE_ORDER", "This is a free RSVP. Cancel it instead.");
    if (o.status !== "completed") return fail(res, 409, "ORDER_NOT_REFUNDABLE", "This order can't be refunded.");
    if (o.event_status === "cancelled") return fail(res, 409, "EVENT_CANCELLED", "This event was cancelled, so your full refund is already on its way.");
    if (o.event_status !== "published") return fail(res, 409, "EVENT_PAUSED", "This event is paused. Contact Outsyde support.");
    if (Number(o.price_paid) <= 0) return fail(res, 409, "NOTHING_TO_REFUND", "Only the service fee was paid on this order, and it isn't refundable.");
    if (o.checked_in) return fail(res, 409, "CHECKED_IN", "You've already checked in.");
    if (o.refund_policy !== "until_cutoff") return fail(res, 409, "NO_REFUNDS", "The host doesn't offer refunds for this event. You can contact the host.");
    return fail(res, 409, "REFUND_WINDOW_CLOSED", `Refunds closed ${o.refund_cutoff_hours} hours before the event. You can contact the host.`);
  } catch (err) {
    if (refundGuardMessage(res, err)) return;
    console.error("[Tickets] buyer refund failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't refund this order.");
  }
});

router.get("/:id/orders", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to see orders.");
  try {
    const e = await loadEventForHost(String(req.params.id), userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const list = await rows<any>(sql`
      SELECT o.id, o.status, o.ticket_count, o.subtotal_cents, o.tax_cents, o.discount_cents, o.host_net_cents,
             o.refunded_cents, o.refund_reason, o.created_at, o.completed_at, u.first_name, u.username
      FROM ticket_orders o JOIN users u ON u.id = o.buyer_user_id
      WHERE o.event_id = ${e.id} AND o.status IN ('completed', 'refunding', 'refunded', 'cancelled')
      ORDER BY o.created_at DESC LIMIT 1000`);
    // Hosts see the guest's first name and @username, not their email; ticket price only (fees are Outsyde's).
    return res.json({
      success: true,
      orders: list.map((o) => ({
        id: o.id, status: o.status, ticketCount: Number(o.ticket_count),
        ticketPriceCents: Number(o.subtotal_cents) + Number(o.tax_cents) - Number(o.discount_cents),
        hostNetCents: Number(o.host_net_cents), refunded: o.status === "refunding" || o.status === "refunded",
        refundReason: o.refund_reason, guest: { firstName: o.first_name ?? null, username: o.username ?? null },
        createdAt: iso(o.created_at), completedAt: iso(o.completed_at),
      })),
    });
  } catch (err) {
    console.error("[Tickets] host orders read failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load orders.");
  }
});

/**
 * Host sales summary. Counts and ticket price only: no buyer fees, no fee rates, no payout internals.
 * Sold = valid tickets on completed orders (same rule as the payout job). Refunded = tickets marked 'refunded'
 * (set when the refund is requested), summed at ticket price, so an event cancellation's fee refunds are left out.
 */
router.get("/:id/summary", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to see sales.");
  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events.");
    const e = await loadEventForHost(String(req.params.id), userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const types = await rows<any>(sql`
      SELECT tt.id, tt.name, tt.price_cents, (tt.status = 'archived') AS archived,
             count(t.id) FILTER (WHERE t.status = 'valid' AND o.status = 'completed')::int AS sold,
             COALESCE(sum(t.price_cents) FILTER (WHERE t.status = 'valid' AND o.status = 'completed'), 0)::int AS gross
      FROM ticket_types tt
      LEFT JOIN tickets t ON t.ticket_type_id = tt.id
      LEFT JOIN ticket_orders o ON o.id = t.order_id
      WHERE tt.event_id = ${e.id}
        AND (tt.status <> 'archived'
             OR EXISTS (SELECT 1 FROM tickets x WHERE x.ticket_type_id = tt.id AND x.status IN ('valid', 'refunded')))
      GROUP BY tt.id ORDER BY tt.sort_order, tt.created_at`);
    // Totals cover every ticket of the event. A removed (archived) type is listed only while it has sales or refunds,
    // so the listed rows add up to the totals.
    const [tot] = await rows<any>(sql`
      SELECT count(*) FILTER (WHERE t.status = 'valid' AND o.status = 'completed')::int AS sold,
             COALESCE(sum(t.price_cents) FILTER (WHERE t.status = 'valid' AND o.status = 'completed'), 0)::int AS gross,
             COALESCE(sum(t.host_net_cents) FILTER (WHERE t.status = 'valid' AND o.status = 'completed'), 0)::int AS host_net,
             count(*) FILTER (WHERE t.status = 'refunded')::int AS refunded,
             COALESCE(sum(t.price_cents) FILTER (WHERE t.status = 'refunded'), 0)::int AS refunded_cents,
             count(*) FILTER (WHERE t.status = 'refunded' AND o.status = 'refunding')::int AS refund_pending
      FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
      WHERE t.event_id = ${e.id}`);
    const [p] = await rows<any>(sql`
      SELECT status, hold_reason, amount_cents, deducted_cents, paid_at FROM event_payouts WHERE event_id = ${e.id}`);
    // Same as the payout job: published events only, paying valid tickets of completed orders with host_net_cents > 0.
    const payable = Number(tot?.host_net ?? 0) > 0;
    const expectedAt = e.status === "published" && payable && e.ends_at
      ? new Date(new Date(e.ends_at).getTime() + HOST_PAYOUT_DELAY_DAYS * 86400000).toISOString() : null;
    return res.json({
      success: true,
      ticketTypes: types.map((t) => ({
        ticketTypeId: t.id, name: t.name, priceCents: Number(t.price_cents), archived: t.archived === true, sold: Number(t.sold), grossCents: Number(t.gross),
      })),
      totals: {
        sold: Number(tot?.sold ?? 0), grossCents: Number(tot?.gross ?? 0), hostEarningsCents: Number(tot?.host_net ?? 0),
        refundedTickets: Number(tot?.refunded ?? 0), refundedCents: Number(tot?.refunded_cents ?? 0),
        refundPendingTickets: Number(tot?.refund_pending ?? 0),
      },
      payout: {
        expectedAt, status: payoutStatusFor(p, { eventStatus: e.status, payable, expectedAt }),
        amountCents: p ? Number(p.amount_cents) : null, deductedCents: p ? Number(p.deducted_cents) : null,
        paidAt: p ? iso(p.paid_at) : null,
      },
    });
  } catch (err) {
    console.error("[Tickets] host summary read failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load sales.");
  }
});

router.post("/:id/orders/:orderId/refund", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to refund an order.");
  const orderId = String(req.params.orderId);
  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't change orders.");
    const e = await loadEventForHost(String(req.params.id), userId);
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const [belongs] = await rows<any>(sql`SELECT buyer_user_id, status, total_cents FROM ticket_orders WHERE id = ${orderId} AND event_id = ${e.id}`);
    if (!belongs) return fail(res, 404, "ORDER_NOT_FOUND", "Order not found.");
    const r = await requestOrderRefund(orderId, userId, "host");
    if (r.ok) {
      await processTicketRefund(orderId, undefined, true).catch((err) => console.error(`[Tickets] refund ${orderId} left for the job:`, err));
      const [o] = await rows<any>(sql`SELECT status, refunded_cents, refund_amount_cents FROM ticket_orders WHERE id = ${orderId}`);
      return res.json({ success: true, order: { id: orderId, status: o.status, refundedCents: Number(o.refunded_cents), refundPendingCents: Number(o.refund_amount_cents) } });
    }
    if (belongs.status === "refunding" || belongs.status === "refunded") return fail(res, 409, "ALREADY_REFUNDED", "This order was already refunded.");
    if (Number(belongs.total_cents) === 0) return fail(res, 409, "FREE_ORDER", "This is a free RSVP, so there's nothing to refund.");
    if (e.status === "cancelled") return fail(res, 409, "EVENT_CANCELLED", "This event is cancelled. Everyone is refunded automatically.");
    if (e.status === "paused") return fail(res, 409, "EVENT_PAUSED", "This event is paused by Outsyde. Contact support.");
    if (e.status !== "published") return fail(res, 409, "EVENT_NOT_PUBLISHED", "This event isn't live.");
    return fail(res, 409, "ORDER_NOT_REFUNDABLE", "This order can't be refunded.");
  } catch (err) {
    if (refundGuardMessage(res, err)) return;
    console.error("[Tickets] host refund failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't refund this order.");
  }
});

export default router;
