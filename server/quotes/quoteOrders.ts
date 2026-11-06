/**
 * Deliverables D1b (Legend 2026-11-06, D1b plan v2 calls 1 to 12, "just like selling a product"): a paid deliverable
 * quote becomes a normal product order. POST /api/quotes/:id/pay (routes.ts) creates the pending order and a
 * destination charge PaymentIntent of type quote_order; the webhook (webhookHandlers.ts) calls these helpers.
 * The order is finished with Mark picked up or Mark delivered, and cancelled with the normal order cancel.
 */
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { estimateRequests, orders, quotes, type Order, type Quote } from "@shared/schema";
import { storage } from "../storage";
import { stripeService } from "../stripe/stripeService";
import { postCardMessage } from "../messaging/postCard";
import { quoteAmounts, quoteMessageText } from "./quoteRules";
import { noticeBusiness } from "./quoteNotices";
import { PAY_LOCK_MINUTES, unlockQuote } from "./quotePaid";

/**
 * Marks the quote paid by this order when it is still sent at the paid version. fresh = this call marked it.
 * Called by the webhook before the order is marked paid.
 */
export async function claimDeliverablePaid(order: Order, paidVersion: number | null): Promise<{ ok: true; fresh: boolean; quote: Quote } | { ok: false; quote: Quote | null }> {
  if (!order.quoteId) return { ok: false, quote: null };
  const now = new Date();
  const conds = [eq(quotes.id, order.quoteId), eq(quotes.status, "sent"), eq(quotes.kind, "product")];
  if (paidVersion !== null) conds.push(eq(quotes.version, paidVersion));
  const [claimed] = await db.update(quotes)
    .set({ status: "paid", paidAt: now, orderId: order.id, payingUntil: null, updatedAt: now })
    .where(and(...conds)).returning();
  if (claimed) return { ok: true, fresh: true, quote: claimed };
  const [cur] = await db.select().from(quotes).where(eq(quotes.id, order.quoteId));
  if (cur && cur.status === "paid" && cur.orderId === order.id) return { ok: true, fresh: false, quote: cur };
  return { ok: false, quote: cur ?? null };
}

/**
 * The quote changed or closed before Stripe confirmed the payment: everything goes back. Full refund (with the
 * service fee) and the business's share taken back from the destination charge; the order is cancelled.
 */
export async function refundUnpayableDeliverable(order: Order, paymentIntentId: string, chargedCents: number): Promise<boolean> {
  try {
    // The whole charge, service fee included, and the business's share taken back. Both Stripe calls use fixed keys
    // per order (order_cancel_refund_<id>, order_cancel_reversal_<id>), so a retry never refunds twice.
    await stripeService.refundOrderCancellation({
      paymentIntentId,
      refundAmountCents: chargedCents,
      vendorReclaimCents: order.vendorNet ?? 0,
      metadata: { orderId: order.id, quoteId: order.quoteId ?? "", reason: "Quote changed or closed before payment finished" },
      orderId: order.id,
    });
  } catch (err) {
    // Review D1b 1: the order stays pending, so the quote job's backstop retries this with the same keys.
    console.error(`[quotes] refund of unpayable deliverable order ${order.id} failed; the backstop retries:`, err);
    return false;
  }
  await db.update(orders).set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(orders.id, order.id), sql`${orders.status} IN ('pending', 'paid')`));
  // Review D1b 2: everything came back, so the points code does too (as for any full refund).
  try {
    const { restorePromoForReference } = await import("../loyaltyLedger");
    await restorePromoForReference({ type: "order", id: order.id });
  } catch (err) {
    console.error(`[quotes] could not give back the points code of order ${order.id}:`, err);
  }
  return true;
}

/** The Paid card in the chat (once), the business's Activity row, and the request moved to booked. */
export async function afterDeliverablePaid(q: Quote, order: Order): Promise<void> {
  try {
    const [first] = await db.update(quotes).set({ paidNoticeAt: new Date() })
      .where(and(eq(quotes.id, q.id), sql`${quotes.paidNoticeAt} IS NULL`)).returning({ id: quotes.id });
    if (first && !(await storage.isUserBlockedEitherWay(q.senderId, q.customerId))) {
      const a = quoteAmounts(q.totalCents, q.depositCents ?? null, q.restPaid ?? "outsyde");
      await postCardMessage({
        conversationId: q.conversationId,
        senderId: q.customerId,
        recipientId: q.senderId,
        kind: "quote",
        card: {
          type: "quote", event: "paid", quoteId: q.id, version: q.version, businessId: q.businessId, orderId: order.id,
          kind: q.kind, dueDate: q.dueDate ?? null, fulfillment: q.fulfillment ?? null, deliveryFeeCents: q.deliveryFeeCents ?? null,
          title: q.title, totalCents: q.totalCents, paymentMode: q.paymentMode, depositOrTotalCents: a.depositOrTotalCents,
          payNowCents: a.payNowCents, balanceCents: a.balanceCents, restPaid: a.restPaid, paidDirectlyCents: a.paidDirectlyCents,
          jobDate: null, startTime: null, durationMinutes: null, timeZone: q.timeZone,
        },
        content: quoteMessageText("paid", q.title, q.totalCents, q.paymentMode),
      });
      await noticeBusiness(q, "paid", q.id);
    }
  } catch (err) {
    console.error(`[quotes] paid card failed for deliverable ${q.id}:`, err);
  }
  if (q.requestId) {
    await db.update(estimateRequests).set({ status: "booked", updatedAt: new Date() })
      .where(and(eq(estimateRequests.id, q.requestId), sql`${estimateRequests.status} IN ('new', 'called', 'quoted')`))
      .catch((err) => console.error(`[quotes] request booked failed for ${q.requestId}:`, err));
  }
}

/**
 * Backstop (the quote job, every 5 minutes): a paid deliverable whose webhook never came is confirmed; an order whose
 * payment lock ran out unpaid is retired (PaymentIntent canceled, order cancelled, quote unlocked) so the quote is
 * never stuck as paying.
 */
export async function settleStaleDeliverableOrders(now = new Date()): Promise<{ confirmed: number; retired: number }> {
  const rows = await db.select().from(orders).where(and(
    isNotNull(orders.quoteId), eq(orders.status, "pending"),
    lt(orders.createdAt, new Date(now.getTime() - 2 * 60_000)),
    sql`${orders.createdAt} > ${new Date(now.getTime() - 3 * 24 * 3600_000)}`,
  )).limit(50);
  let confirmed = 0;
  let retired = 0;
  for (const o of rows) {
    try {
      const pi: any = o.stripePaymentIntentId ? await stripeService.getPaymentIntent(o.stripePaymentIntentId) : null;
      if (pi?.status === "succeeded") {
        const { WebhookHandlers } = await import("../stripe/webhookHandlers");
        await WebhookHandlers.handlePaymentIntentSucceeded(pi);
        confirmed++;
        continue;
      }
      if (pi && pi.status === "processing") continue;
      const expired = new Date(o.createdAt).getTime() + (PAY_LOCK_MINUTES + 1) * 60_000 <= now.getTime();
      if (!expired) continue;
      if (pi && pi.status !== "canceled") {
        try {
          await stripeService.cancelPaymentIntent(pi.id, "abandoned");
        } catch (err) {
          console.error(`[quotes] could not retire deliverable payment ${pi.id}:`, err);
          continue; // paid meanwhile: the webhook or the next run settles it
        }
      }
      const [done] = await db.update(orders).set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(orders.id, o.id), eq(orders.status, "pending"))).returning({ id: orders.id });
      if (done && o.quoteId) await unlockQuote(o.quoteId);
      if (done) retired++;
    } catch (err) {
      console.error(`[quotes] deliverable backstop failed for order ${o.id}:`, err);
    }
  }
  return { confirmed, retired };
}

/** Orders that can be finished with Mark picked up or Mark delivered (not shipped with a carrier). */
export const LOCAL_FULFILLMENTS = ["pickup", "delivery"] as const;
export function canMarkHandedOver(o: Pick<Order, "status" | "fulfillment">): boolean {
  return o.status === "paid" && !!o.fulfillment && (LOCAL_FULFILLMENTS as readonly string[]).includes(o.fulfillment);
}
