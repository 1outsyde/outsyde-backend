/**
 * Unpaid product order cleanup (app payment methods follow up, Legend 2026-11-07).
 *
 * POST /api/cart/payment-intent makes the order (or one order per shop plus an order group) and its
 * PaymentIntent before the customer pays. A customer who leaves (closes Klarna, Afterpay or Cash App, backs out
 * of a bank check, or the app stops a total that changed) leaves a `pending` order that vendors see under
 * Pending and that blocks account deletion (accountDeletionService.ts:50). This job closes those, the same way
 * the booking hold job (abandonedCheckouts.ts) and the quote payment job (quoteOrders.ts:105) already do.
 *
 * Rules (never touch money that is moving):
 *  - Only product orders (quote_id IS NULL: the quote job owns those) still `pending` 6 hours after they were
 *    made. Afterpay gives a customer up to 3 hours to approve; stock isn't held, so waiting costs nothing.
 *  - Orders sharing a PaymentIntent (a multi shop cart) are settled together, with one Stripe read.
 *  - No PaymentIntent, or `canceled` → close.
 *  - `succeeded` → the paid message never arrived: run the normal paid steps (receipts, stock, payouts).
 *  - `processing`, `requires_capture` → leave it; the payment webhook settles it.
 *  - Anything else → cancel the PaymentIntent FIRST (the paid step marks any non paid order paid,
 *    webhookHandlers.ts:155), then close. A refused cancel (paid meanwhile) or any Stripe error → retry later.
 *  - Close = status `cancelled` (what vendors and customers already see for failed payments), give back any
 *    points code the order held, and close its order group once every order in it is cancelled.
 *  - No email, no push: the customer walked away themselves.
 */
import { db } from "./db";
import { sql } from "drizzle-orm";
import { releasePromoReservation } from "./loyaltyLedger";

export const ORDER_ABANDON_AFTER_MS = 6 * 60 * 60 * 1000;
const BATCH = 100;

const MONEY_MOVING = new Set(["processing", "requires_capture"]);

export type OrderDecision = "close" | "cancel_then_close" | "confirm_paid" | "skip";

/** What to do with an abandoned order, given its PaymentIntent status (null = no PaymentIntent). */
export function decideAbandonedOrder(piStatus: string | null): OrderDecision {
  if (piStatus === null || piStatus === "canceled") return "close";
  if (piStatus === "succeeded") return "confirm_paid";
  if (MONEY_MOVING.has(piStatus)) return "skip";
  return "cancel_then_close";
}

export interface AbandonedOrderDeps {
  getPaymentIntent: (id: string) => Promise<{ id: string; status: string }>;
  cancelPaymentIntent: (id: string) => Promise<unknown>;
  /** Runs the payment_intent.succeeded steps for a PaymentIntent whose webhook never came. */
  confirmPaid: (paymentIntent: any) => Promise<unknown>;
}

async function defaultDeps(): Promise<AbandonedOrderDeps> {
  const { stripeService } = await import("./stripe/stripeService");
  return {
    getPaymentIntent: (id) => stripeService.getPaymentIntent(id) as Promise<{ id: string; status: string }>,
    cancelPaymentIntent: (id) => stripeService.cancelPaymentIntent(id, "abandoned"),
    confirmPaid: async (pi) => {
      const { WebhookHandlers } = await import("./stripe/webhookHandlers");
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
    },
  };
}

type Row = { id: string; pi: string | null; group_id: string | null };

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r: any = await db.execute(q);
  return (r?.rows ?? r) as T[];
}

async function closeOrders(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const closed = await rows<{ id: string; group_id: string | null }>(sql`
    UPDATE orders SET status = 'cancelled', updated_at = now()
    WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND status = 'pending' AND quote_id IS NULL
    RETURNING id, order_group_id AS group_id
  `);
  for (const o of closed) {
    await releasePromoReservation({ type: "order", id: o.id }).catch((err) =>
      console.error(`[AbandonedOrders] order ${o.id}: could not give back its points code`, err),
    );
  }
  const groups = Array.from(new Set(closed.map((o) => o.group_id).filter((g): g is string => !!g)));
  for (const g of groups) {
    await db.execute(sql`
      UPDATE order_groups SET status = 'cancelled'
      WHERE id = ${g} AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM orders WHERE order_group_id = ${g} AND status IS DISTINCT FROM 'cancelled')
    `);
  }
  return closed.map((o) => o.id);
}

export async function cleanupAbandonedOrders(
  now: Date = new Date(),
  deps?: AbandonedOrderDeps,
): Promise<{ closed: number; confirmed: number; skipped: number }> {
  const d = deps ?? (await defaultDeps());
  // created_at is a UTC time without a zone. Sent as UTC text, the same way drizzle sends dates (a raw Date
  // would carry the server's local offset, which Postgres drops when comparing, putting the cutoff hours off).
  const cutoff = new Date(now.getTime() - ORDER_ABANDON_AFTER_MS);
  const found = await rows<Row>(sql`
    SELECT id, stripe_payment_intent_id AS pi, order_group_id AS group_id FROM orders
    WHERE status = 'pending' AND quote_id IS NULL AND created_at < ${cutoff.toISOString()}::timestamp
    ORDER BY created_at LIMIT ${BATCH}
  `);

  // One settlement per payment: a multi shop cart's orders share one PaymentIntent.
  const byPayment = new Map<string, { pi: string | null; ids: string[] }>();
  for (const r of found) {
    const key = r.pi ? `pi:${r.pi}` : r.group_id ? `group:${r.group_id}` : `order:${r.id}`;
    const entry = byPayment.get(key) ?? { pi: r.pi, ids: [] };
    entry.ids.push(r.id);
    byPayment.set(key, entry);
  }

  let closed = 0;
  let confirmed = 0;
  let skipped = 0;
  for (const { pi, ids } of Array.from(byPayment.values())) {
    const label = `orders ${ids.join(",")}`;
    try {
      let payment: { id: string; status: string } | null = null;
      if (pi) {
        try {
          payment = await d.getPaymentIntent(pi);
        } catch (err) {
          skipped += ids.length;
          console.error(`[AbandonedOrders] ${label}: could not read PaymentIntent ${pi}, will retry`, err);
          continue;
        }
      }
      const decision = decideAbandonedOrder(payment?.status ?? null);
      if (decision === "skip") {
        skipped += ids.length;
        continue;
      }
      if (decision === "confirm_paid") {
        await d.confirmPaid(payment);
        confirmed++;
        console.log(`[AbandonedOrders] ${label}: PaymentIntent ${pi} was paid; ran the paid steps`);
        continue;
      }
      if (decision === "cancel_then_close") {
        try {
          await d.cancelPaymentIntent(pi!);
        } catch (err) {
          skipped += ids.length;
          console.error(`[AbandonedOrders] ${label}: could not cancel PaymentIntent ${pi}, will retry`, err);
          continue;
        }
      }
      closed += (await closeOrders(ids)).length;
    } catch (err) {
      skipped += ids.length;
      console.error(`[AbandonedOrders] ${label} failed:`, err);
    }
  }

  if (closed || confirmed || skipped) {
    console.log(`[AbandonedOrders] Closed ${closed} unpaid orders, confirmed ${confirmed} paid; ${skipped} left for a later run`);
  }
  return { closed, confirmed, skipped };
}

/** Every 15 minutes, first run a minute after boot. */
export function startAbandonedOrderJob(intervalMs = 15 * 60 * 1000): NodeJS.Timeout {
  const run = () => {
    cleanupAbandonedOrders().catch((err) => console.error("[AbandonedOrders] run failed:", err));
  };
  setTimeout(run, 60 * 1000);
  return setInterval(run, intervalMs);
}
