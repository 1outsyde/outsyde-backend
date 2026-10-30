/**
 * Events & Ticketing Phase 2, PR 3: paid ticket checkout.
 *
 *   POST /api/events/:id/checkout        (auth)  hold paid tickets for 10 minutes + create the PaymentIntent
 *   GET  /api/events/orders/:orderId     (auth, buyer)  order status + tickets (the page polls this after paying)
 *
 * Money rules (vault: Handoffs/2026-10-18 Events & Ticketing — Audit & Design):
 *   - Price read from the database only. Fees from fees.ts calculateTicketFees, saved per ticket.
 *   - Platform-balance PaymentIntent (no transfer): the host is paid once per event, 3 days after it ends (later PR).
 *   - Deterministic Stripe idempotency key `ticket_pi_<orderId>`. Metadata uses `ticketOrderId`, never
 *     `orderId`/`bookingId` (those keys trigger product-order and booking handling in webhookHandlers.ts).
 *   - Tickets are issued once: the order moves pending -> completed in ONE statement that also writes
 *     the tickets, and only when the PaymentIntent id and amount match. Safe to run twice.
 *   - The Stripe webhook runs after its 200 and is never retried, so runTicketOrderJob (every minute)
 *     also settles pending orders whose PaymentIntent already succeeded, and expires abandoned holds
 *     (same rules as abandonedCheckouts.ts: never expire while the PaymentIntent is succeeded,
 *     processing or requires_capture; cancel it first when it could still be paid).
 *
 * Paid events still can't be published until payouts ship, so in production nothing reaches this yet.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { calculateTicketFees } from "../fees";
import { decideAbandoned } from "../abandonedCheckouts";
import { rows, pgError, iso, fail, zodError, loadActiveUser } from "./eventsRouter";
import { guardCode, withDeadlockRetry, orderWithTickets, whyNotClaimable } from "./ticketsRouter";
import { makeTicketCode } from "./eventRules";
import { paymentSheetFields } from "../payments/savedCards";
import { normalizeLinkCode, promoterLinkIdSql } from "./promoterLinks";

const router = Router();

export const TICKET_HOLD_MINUTES = 10;
/** Same window as abandoned booking checkouts: the hold is 10 minutes, plus 5 for a slow bank check. */
export const TICKET_ABANDON_AFTER_MS = 15 * 60 * 1000;
/** Pending orders older than this are checked with Stripe in case their webhook was lost. */
export const TICKET_RECONCILE_AFTER_MS = 2 * 60 * 1000;

type StripeLike = {
  getOrCreateStripeCustomer(p: { userId: string; email: string; name?: string; existingStripeCustomerId?: string | null }): Promise<string>;
  createPlatformPaymentIntent(p: {
    amountCents: number; customerId?: string; captureMethod: "automatic" | "manual";
    metadata: Record<string, string>; description?: string; idempotencyKey?: string;
  }): Promise<{ id: string; client_secret: string | null; status: string; customer?: string | { id: string } | null }>;
  getPaymentIntent(id: string): Promise<{ id: string; status: string; amount_received?: number; amount?: number; client_secret?: string | null; customer?: string | { id: string } | null }>;
  cancelPaymentIntent(id: string, reason?: "abandoned"): Promise<unknown>;
};

async function stripe(): Promise<StripeLike> {
  const { stripeService } = await import("../stripe/stripeService");
  return stripeService as unknown as StripeLike;
}

// ─── Release (expire / cancel an unpaid order) ──────────────────────────────

/**
 * Gives a pending order's held spots back, in ONE statement. Same reopen rule as a cancelled RSVP:
 * the event always gets the spots back; the ticket type only while no tier that opens after it has
 * sold. Returns false when the order wasn't pending (already settled or released).
 */
export async function releasePendingTicketOrder(orderId: string, status: "expired" | "cancelled", paymentIntentId?: string | null): Promise<boolean> {
  const [r] = await withDeadlockRetry(() => rows<any>(sql`
    WITH o AS (
      UPDATE ticket_orders SET status = ${status}, cancelled_at = now(), updated_at = now()
      WHERE id = ${orderId} AND status = 'pending'
        AND (${paymentIntentId ?? null}::text IS NULL OR stripe_payment_intent_id = ${paymentIntentId ?? null}::text)
      RETURNING id, event_id, buyer_user_id, ticket_count
    ),
    it AS (
      UPDATE ticket_order_items i SET status = 'expired', updated_at = now()
      FROM o WHERE i.order_id = o.id AND i.status = 'held'
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
      FROM o WHERE e.id = o.event_id
      RETURNING e.id
    ),
    ac AS (
      UPDATE ticket_account_counts a SET count = a.count - it.quantity, updated_at = now()
      FROM it, o WHERE a.ticket_type_id = it.ticket_type_id AND a.user_id = o.buyer_user_id
      RETURNING 1
    )
    SELECT (SELECT id FROM o) AS order_id,
           CASE WHEN EXISTS (SELECT 1 FROM o) AND (
                  NOT EXISTS (SELECT 1 FROM ev)
               OR (SELECT count(*) FROM ac) <> (SELECT count(*) FROM it)
               OR (SELECT COALESCE(sum(quantity), 0) FROM it) <> (SELECT ticket_count FROM o))
             THEN ('GUARD_RELEASE:' || (SELECT count(*) FROM it))::int END AS guard`));
  return !!r?.order_id;
}

// ─── Settle (issue tickets once) ────────────────────────────────────────────

export type SettleResult = "settled" | "already" | "mismatch" | "not_found";

/**
 * pending -> completed and one ticket per seat, in ONE statement. Only when the PaymentIntent id
 * matches the order and Stripe received exactly the order total. Running it twice is a no-op.
 */
export async function settleTicketOrder(orderId: string, paymentIntentId: string, amountReceivedCents: number): Promise<SettleResult> {
  const [o] = await rows<any>(sql`
    SELECT o.status, o.stripe_payment_intent_id, o.total_cents, o.ticket_count, o.subtotal_cents, o.service_fee_cents,
           o.per_ticket_fee_cents, o.platform_fee_cents, o.host_net_cents, i.unit_price_cents
    FROM ticket_orders o JOIN ticket_order_items i ON i.order_id = o.id
    WHERE o.id = ${orderId}`);
  if (!o) return "not_found";
  // Already settled (and maybe refunded since): a late or repeated webhook changes nothing and flags nothing.
  if (["completed", "refunding", "refunded"].includes(o.status) && o.stripe_payment_intent_id === paymentIntentId) return "already";
  if (o.stripe_payment_intent_id !== paymentIntentId || Number(o.total_cents) !== amountReceivedCents || o.status !== "pending") {
    return "mismatch";
  }
  // Per-ticket money comes from what the order saved at checkout (order = unit x quantity), so a fee
  // change deployed while the order was pending can't make the tickets disagree with the charge.
  const n = Number(o.ticket_count);
  const per = (col: string) => Number(o[col]) / n;
  const unit = {
    price: per("subtotal_cents"), service: per("service_fee_cents"), perTicket: per("per_ticket_fee_cents"),
    platform: per("platform_fee_cents"), hostNet: per("host_net_cents"),
  };
  if (!Object.values(unit).every(Number.isInteger) || unit.price !== Number(o.unit_price_cents)) return "mismatch";
  const codes = Array.from({ length: n }, () => makeTicketCode());
  const codesLiteral = `{${codes.join(",")}}`; // A-Z and 2-9 only
  try {
    const [r] = await rows<any>(sql`
      WITH o AS (
        UPDATE ticket_orders SET status = 'completed', paid_at = now(), completed_at = now(), updated_at = now()
        WHERE id = ${orderId} AND status = 'pending' AND stripe_payment_intent_id = ${paymentIntentId}
          AND total_cents = ${amountReceivedCents}
        RETURNING id, event_id, buyer_user_id, ticket_count
      ),
      it AS (
        UPDATE ticket_order_items i SET status = 'issued', updated_at = now()
        FROM o WHERE i.order_id = o.id AND i.status = 'held'
        RETURNING i.id, i.order_id, i.ticket_type_id, i.quantity
      ),
      tk AS (
        INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code,
                             price_cents, service_fee_cents, per_ticket_fee_cents, platform_fee_cents, host_net_cents)
        SELECT it.order_id, it.id, o.event_id, it.ticket_type_id, o.buyer_user_id, c.ord, c.code,
               ${unit.price}, ${unit.service}, ${unit.perTicket}, ${unit.platform}, ${unit.hostNet}
        FROM it, o, unnest(${codesLiteral}::text[]) WITH ORDINALITY AS c(code, ord)
        RETURNING id
      )
      SELECT (SELECT id FROM o) AS order_id,
             CASE WHEN EXISTS (SELECT 1 FROM o) AND (
                    (SELECT count(*) FROM tk) <> (SELECT ticket_count FROM o)
                 OR (SELECT COALESCE(sum(quantity), 0) FROM it) <> (SELECT ticket_count FROM o))
               THEN ('GUARD_SETTLE:' || (SELECT count(*) FROM tk))::int END AS guard`);
    if (!r?.order_id) return "already";
    // First settle only: receipt to the buyer, push to the host. Never throws, never blocks the settle.
    void import("./ticketNotices").then((m) => m.notifyOrderSettled(orderId)).catch(() => {});
    return "settled";
  } catch (err) {
    if (guardCode(err) === "SETTLE") {
      console.error(`[Tickets] settle guard fired for order ${orderId}; nothing written`);
      return "mismatch";
    }
    throw err;
  }
}

let adminAlertForTest: ((subject: string, detail: string) => Promise<void>) | null = null;
/** Tests only: record admin alerts instead of emailing them (null restores the real sender). */
export function setAdminAlertForTest(fn: ((subject: string, detail: string) => Promise<void>) | null) { adminAlertForTest = fn; }

/** Emails the admin. Never throws. */
export async function alertAdmin(subject: string, detail: string) {
  try {
    if (adminAlertForTest) return await adminAlertForTest(subject, detail);
    const { sendAdminEmail, ADMIN_NOTIFICATION_EMAIL } = await import("../emailService");
    // Internal alert: no log tag, so it stays out of the customer email History (same as other admin alerts).
    await sendAdminEmail({
      to: ADMIN_NOTIFICATION_EMAIL,
      subject: `[Tickets] ${subject}`,
      html: `<p>${detail.replace(/[<>&]/g, "")}</p>`,
    });
  } catch (err) {
    console.error("[Tickets] admin alert failed:", err);
  }
}

/**
 * A paid order that can't be settled automatically: flag it once (the job then skips it) and email
 * the admin once. A repeat call for an order already flagged does nothing.
 */
export async function flagForReview(orderId: string, reason: string) {
  const [flagged] = await rows<any>(sql`
    UPDATE ticket_orders SET needs_review_at = now(), review_reason = ${reason.slice(0, 300)}, updated_at = now()
    WHERE id = ${orderId} AND needs_review_at IS NULL
    RETURNING id`);
  if (flagged) await alertAdmin("Paid order needs a look", `Ticket order ${orderId}: ${reason}. Check the order and refund if needed.`);
}

/** Called by the Stripe webhook (payment_intent.succeeded, metadata.type = 'event_ticket'). */
export async function handleTicketPaymentSucceeded(pi: { id: string; amount_received?: number | null; amount?: number; metadata?: Record<string, string> }) {
  const orderId = pi.metadata?.ticketOrderId;
  if (!orderId) return;
  const result = await settleTicketOrder(orderId, pi.id, Number(pi.amount_received ?? pi.amount ?? 0));
  console.log(`[Tickets] payment ${pi.id} for order ${orderId}: ${result}`);
  if (result === "mismatch") await flagForReview(orderId, `PaymentIntent ${pi.id} succeeded but the order could not be settled`);
  if (result === "not_found") await alertAdmin("Paid order needs a look", `PaymentIntent ${pi.id} succeeded for unknown ticket order ${orderId}. Refund it in Stripe.`);
}

/** Called by the Stripe webhook (payment_intent.canceled, metadata.type = 'event_ticket'). */
export async function handleTicketPaymentCanceled(pi: { id: string; metadata?: Record<string, string> }) {
  const orderId = pi.metadata?.ticketOrderId;
  if (!orderId) return;
  const released = await releasePendingTicketOrder(orderId, "cancelled", pi.id);
  console.log(`[Tickets] payment ${pi.id} cancelled; order ${orderId} ${released ? "released" : "unchanged"}`);
}

// ─── Every-minute job: recover lost webhooks, expire abandoned holds ────────

export async function runTicketOrderJob(now = new Date(), deps?: Pick<StripeLike, "getPaymentIntent" | "cancelPaymentIntent">): Promise<{ settled: number; expired: number; skipped: number }> {
  const s = deps ?? (await stripe());
  const reconcileBefore = new Date(now.getTime() - TICKET_RECONCILE_AFTER_MS).toISOString();
  // Least recently checked first, so a few orders Stripe keeps erroring on can't block newer ones.
  const pending = await rows<any>(sql`
    UPDATE ticket_orders SET last_checked_at = ${now.toISOString()}
    WHERE id IN (
      SELECT id FROM ticket_orders
      WHERE status = 'pending' AND needs_review_at IS NULL AND created_at < ${reconcileBefore}
      ORDER BY last_checked_at NULLS FIRST, created_at LIMIT 50)
    RETURNING id, stripe_payment_intent_id, created_at`);
  const out = { settled: 0, expired: 0, skipped: 0 };
  for (const o of pending) {
    try {
      const abandoned = now.getTime() - new Date(o.created_at).getTime() >= TICKET_ABANDON_AFTER_MS;
      if (!o.stripe_payment_intent_id) {
        if (abandoned && (await releasePendingTicketOrder(o.id, "expired"))) out.expired++;
        else out.skipped++;
        continue;
      }
      const pi = await s.getPaymentIntent(o.stripe_payment_intent_id);
      if (pi.status === "succeeded") {
        const r = await settleTicketOrder(o.id, pi.id, Number(pi.amount_received ?? 0));
        if (r === "settled") out.settled++;
        else {
          out.skipped++;
          if (r === "mismatch") await flagForReview(o.id, `PaymentIntent ${pi.id} succeeded but the order could not be settled`);
        }
        continue;
      }
      if (!abandoned) { out.skipped++; continue; }
      const decision = decideAbandoned(pi.status);
      if (decision === "skip") { out.skipped++; continue; }
      if (decision === "cancel_then_expire") await s.cancelPaymentIntent(pi.id, "abandoned");
      if (await releasePendingTicketOrder(o.id, "expired", pi.id)) out.expired++;
      else out.skipped++;
    } catch (err) {
      // A Stripe error leaves the order for the next run; never expire on an unknown state.
      out.skipped++;
      console.error(`[Tickets] job failed for order ${o.id}:`, (err as Error)?.message ?? err);
    }
  }
  if (out.settled || out.expired) console.log(`[Tickets] job: settled ${out.settled}, expired ${out.expired}, skipped ${out.skipped}`);
  return out;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  ticketTypeId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(20).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  // The app opens Stripe's payment sheet: answer with a customer session too (p4-applepay).
  paymentSheet: z.boolean().optional(),
  // p4-team step 3: the promoter link the buyer came through. Anything that isn't a live link is ignored, never refused.
  linkCode: z.unknown().optional(),
}).strict();

function moneyJson(o: any) {
  return {
    subtotalCents: Number(o.subtotal_cents), serviceFeeCents: Number(o.service_fee_cents) + Number(o.per_ticket_fee_cents),
    totalCents: Number(o.total_cents),
  };
}

router.post("/:id/checkout", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to buy tickets.");
  const parsed = checkoutSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodError(res, parsed.error);
  const eventId = String(req.params.id);
  const { ticketTypeId } = parsed.data;
  const quantity = parsed.data.quantity ?? 1;
  const headerKey = req.get("Idempotency-Key");
  const idempotencyKey = parsed.data.idempotencyKey ?? (headerKey && headerKey.length >= 8 && headerKey.length <= 100 ? headerKey : null);

  try {
    const user = await loadActiveUser(userId);
    if (!user) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't buy tickets.");
    const s = await stripe();

    // Same request again: hand back the same checkout while it's still open.
    if (idempotencyKey) {
      const [prev] = await rows<any>(sql`
        SELECT o.*, i.ticket_type_id FROM ticket_orders o JOIN ticket_order_items i ON i.order_id = o.id
        WHERE o.buyer_user_id = ${userId} AND o.idempotency_key = ${idempotencyKey}`);
      if (prev) {
        if (prev.event_id !== eventId || prev.ticket_type_id !== ticketTypeId || Number(prev.ticket_count) !== quantity) {
          return fail(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different order. Send a new key.");
        }
        if (prev.status === "completed" || prev.status === "refunding" || prev.status === "refunded") {
          return res.json({ success: true, order: await orderWithTickets(prev.id, userId), repeated: true });
        }
        if (prev.status !== "pending") return fail(res, 409, "CHECKOUT_CLOSED", "That checkout has closed. Start a new one.");
        if (!prev.stripe_payment_intent_id) return fail(res, 409, "TRY_AGAIN", "This checkout is already being set up. Try again in a moment.");
        const pi = await s.getPaymentIntent(prev.stripe_payment_intent_id);
        if (pi.status === "succeeded") {
          // Paid already (its webhook may not have arrived yet): issue the tickets now.
          const r = await settleTicketOrder(prev.id, pi.id, Number(pi.amount_received ?? 0));
          if (r === "mismatch") await flagForReview(prev.id, `PaymentIntent ${pi.id} succeeded but the order could not be settled`);
          return res.json({ success: true, order: await orderWithTickets(prev.id, userId), repeated: true });
        }
        if (pi.status === "canceled") return fail(res, 409, "CHECKOUT_CLOSED", "That checkout has closed. Start a new one.");
        return res.json({
          success: true, repeated: true, orderId: prev.id, paymentIntentId: pi.id, clientSecret: pi.client_secret ?? null,
          holdExpiresAt: iso(prev.expires_at), ...moneyJson(prev),
          ...(await paymentSheetFields(pi.customer, parsed.data.paymentSheet === true)),
        });
      }
    }

    // Price from the database; the hold statement re-checks it so a price edit in between fails safely.
    const [t] = await rows<any>(sql`SELECT price_cents FROM ticket_types WHERE id = ${ticketTypeId} AND event_id = ${eventId}`);
    if (!t || Number(t.price_cents) <= 0) {
      const why = await whyNotClaimable(eventId, ticketTypeId, quantity, "paid");
      return fail(res, why.status, why.code, why.message);
    }
    const fees = calculateTicketFees(Number(t.price_cents), quantity);
    const promoterLink = promoterLinkIdSql(normalizeLinkCode(parsed.data.linkCode), eventId, userId);

    let orderId: string | null = null;
    try {
      // One statement: hold seats (CHECKs stop overselling; held seats count toward the per-person
      // limit), then the pending order and its held line. Same guards and tier lock as a free RSVP.
      const [r] = await withDeadlockRetry(() => rows<any>(sql`
        WITH par AS (
          SELECT p.id, p.status, p.reserved_count, p.quantity FROM ticket_types p
          WHERE p.id = (SELECT x.unlock_after_ticket_type_id FROM ticket_types x WHERE x.id = ${ticketTypeId})
          FOR UPDATE
        ),
        tt AS (
          UPDATE ticket_types t SET reserved_count = t.reserved_count + ${quantity}, updated_at = now()
          WHERE t.id = ${ticketTypeId} AND t.event_id = ${eventId} AND t.status = 'active' AND t.hidden = false
            AND t.price_cents = ${fees.unitPriceCents} AND t.price_cents > 0
            AND ${quantity} BETWEEN t.min_per_order AND t.max_per_order
            AND (t.sales_start_at IS NULL OR t.sales_start_at <= now())
            AND (t.sales_end_at IS NULL OR t.sales_end_at > now())
            AND (t.unlock_after_ticket_type_id IS NULL OR EXISTS (
              SELECT 1 FROM par WHERE par.id = t.unlock_after_ticket_type_id
                AND (par.status <> 'active' OR par.reserved_count >= par.quantity)))
          RETURNING t.id, t.per_account_limit
        ),
        ev AS (
          UPDATE events e SET reserved_count = e.reserved_count + ${quantity}, updated_at = now()
          WHERE e.id = ${eventId} AND e.status = 'published' AND e.starts_at > now() AND EXISTS (SELECT 1 FROM tt)
          RETURNING e.id
        ),
        ac AS (
          INSERT INTO ticket_account_counts (ticket_type_id, user_id, count, max_count)
          SELECT tt.id, ${userId}, ${quantity}, tt.per_account_limit FROM tt, ev
          ON CONFLICT (ticket_type_id, user_id) DO UPDATE
            SET count = ticket_account_counts.count + EXCLUDED.count, max_count = EXCLUDED.max_count, updated_at = now()
          RETURNING 1
        ),
        o AS (
          INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, subtotal_cents, service_fee_cents,
                                     per_ticket_fee_cents, platform_fee_cents, host_net_cents, total_cents,
                                     fee_model_version, idempotency_key, expires_at, promoter_link_id)
          SELECT ${eventId}, ${userId}, 'pending', ${quantity}, ${fees.subtotalCents}, ${fees.serviceFeeCents},
                 ${fees.perTicketFeeCents}, ${fees.platformFeeCents}, ${fees.hostNetCents}, ${fees.totalCents},
                 ${fees.feeModelVersion}, ${idempotencyKey}, now() + make_interval(mins => ${TICKET_HOLD_MINUTES}), ${promoterLink}
          FROM ac
          RETURNING id
        ),
        it AS (
          INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
          SELECT o.id, ${eventId}, ${ticketTypeId}, ${userId}, ${quantity}, ${fees.unitPriceCents}, 'held',
                 now() + make_interval(mins => ${TICKET_HOLD_MINUTES})
          FROM o
          RETURNING id
        )
        SELECT (SELECT id FROM o) AS order_id,
               CASE WHEN EXISTS (SELECT 1 FROM tt) AND NOT EXISTS (SELECT 1 FROM it)
                 THEN ('GUARD_NOT_OPEN:' || (SELECT count(*) FROM it))::int END AS guard`));
      orderId = r?.order_id ?? null;
    } catch (err) {
      const pe = pgError(err);
      if (pe.code === "23514") {
        if (pe.constraint === "ticket_types_quantity_not_exceeded") return fail(res, 409, "SOLD_OUT", "Sold out.");
        if (pe.constraint === "events_capacity_not_exceeded") return fail(res, 409, "EVENT_FULL", "This event is full.");
        if (pe.constraint === "ticket_account_counts_limit") return fail(res, 409, "LIMIT_REACHED", "You already have the most tickets allowed for this.");
      }
      if (pe.code === "23505" && pe.constraint === "uq_ticket_orders_idempotency") {
        return fail(res, 409, "TRY_AGAIN", "This checkout is already being set up. Try again in a moment.");
      }
      if (!guardCode(err)) throw err;
    }
    if (!orderId) {
      const why = await whyNotClaimable(eventId, ticketTypeId, quantity, "paid");
      return fail(res, why.status, why.code, why.message);
    }

    // Stripe: customer + PaymentIntent. Any failure gives the seats back straight away.
    let pi: { id: string; client_secret: string | null; customer?: string | { id: string } | null };
    try {
      const [u] = await rows<any>(sql`SELECT email, stripe_customer_id FROM users WHERE id = ${userId}`);
      let customerId: string | undefined;
      if (u?.email) {
        customerId = await s.getOrCreateStripeCustomer({ userId, email: u.email, existingStripeCustomerId: u.stripe_customer_id ?? null });
        if (customerId !== u.stripe_customer_id) await rows(sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${userId}`);
      }
      const [ev] = await rows<any>(sql`SELECT title FROM events WHERE id = ${eventId}`);
      pi = await s.createPlatformPaymentIntent({
        amountCents: fees.totalCents,
        customerId,
        captureMethod: "automatic",
        description: `Tickets: ${String(ev?.title ?? "event").slice(0, 80)}`,
        metadata: { type: "event_ticket", ticketOrderId: orderId, eventId, ticketTypeId, buyerUserId: userId, quantity: String(quantity) },
        idempotencyKey: `ticket_pi_${orderId}`,
      });
    } catch (err) {
      console.error(`[Tickets] PaymentIntent failed for order ${orderId}:`, err);
      await releasePendingTicketOrder(orderId, "cancelled").catch((e) => console.error("[Tickets] release after Stripe failure failed:", e));
      // Free the request key so the buyer's retry (the message says "Try again") isn't refused.
      await rows(sql`UPDATE ticket_orders SET idempotency_key = NULL WHERE id = ${orderId} AND status = 'cancelled'`).catch(() => {});
      return fail(res, 502, "PAYMENT_SETUP_FAILED", "Couldn't start the payment. Your seats were released. Try again.");
    }

    const [saved] = await rows<any>(sql`
      UPDATE ticket_orders SET stripe_payment_intent_id = ${pi.id}, updated_at = now()
      WHERE id = ${orderId} AND status = 'pending' AND stripe_payment_intent_id IS NULL
      RETURNING *`);
    if (!saved) {
      // The order closed while Stripe was answering (very rare): make sure this PaymentIntent can't be paid.
      await s.cancelPaymentIntent(pi.id, "abandoned").catch(() => {});
      return fail(res, 409, "CHECKOUT_CLOSED", "That checkout has closed. Start a new one.");
    }
    return res.status(201).json({
      success: true, orderId, paymentIntentId: pi.id, clientSecret: pi.client_secret,
      holdExpiresAt: iso(saved.expires_at), ...moneyJson(saved),
      ...(await paymentSheetFields(pi.customer, parsed.data.paymentSheet === true)),
    });
  } catch (err) {
    console.error("[Tickets] checkout failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't start checkout.");
  }
});

router.get("/orders/:orderId", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to see your order.");
  try {
    const order = await orderWithTickets(String(req.params.orderId), userId);
    if (!order) return fail(res, 404, "ORDER_NOT_FOUND", "Order not found.");
    return res.json({ success: true, order });
  } catch (err) {
    console.error("[Tickets] order read failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load the order.");
  }
});

export default router;
