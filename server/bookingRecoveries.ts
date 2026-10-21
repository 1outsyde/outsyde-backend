/**
 * Booking refund recovery (P1 #5): after a booking refund, the seller's share is later taken back from their
 * Stripe transfer. This file records each Stripe refund (the hook in stripeService.createBookingRefund calls
 * recordBookingRefund); later code works out and takes back the share.
 */
import { sql } from "drizzle-orm";
import { rows } from "./events/eventsRouter";
import { calculateBookingFees } from "./fees";

/** 2026-10-21 00:00 UTC. Refunds Stripe created before this are never recorded. */
export const RECOVERY_START_UNIX = 1792540800;

/** Record one Stripe refund as a pending recovery. Same refund twice is a no-op; older refunds are skipped. */
export async function recordBookingRefund(p: { refundId: string; paymentIntentId: string; refundCents: number; createdUnix: number }): Promise<void> {
  if (p.createdUnix < RECOVERY_START_UNIX) return;
  await rows(sql`
    INSERT INTO booking_refund_recoveries (refund_id, payment_intent_id, refund_cents, refund_created_at, status, next_attempt_at)
    VALUES (${p.refundId}, ${p.paymentIntentId}, ${p.refundCents}, to_timestamp(${p.createdUnix}), 'pending', now())
    ON CONFLICT (refund_id) DO NOTHING`);
}

export type ResolvedBooking = {
  type: "appointment" | "shoot_booking";
  id: string;
  base: number;
  intendedPayout: number;
  recipient: "business" | "staff" | "photographer";
};

/**
 * The booking behind a PaymentIntent, or null when it is on neither appointments nor shoot_bookings (ticket
 * refunds also reach createBookingRefund; those rows are closed as not_booking and never reversed).
 * base is what the payout was figured on: the deposit when there is one, else the total price.
 */
export async function resolveBooking(paymentIntentId: string): Promise<ResolvedBooking | null> {
  const [r] = await rows<any>(sql`
    SELECT 'appointment' AS type, id, total_price, deposit_amount_cents, vendor_net, staff_member_id
    FROM appointments WHERE stripe_payment_intent_id = ${paymentIntentId}
    UNION ALL
    SELECT 'shoot_booking' AS type, id, total_price, deposit_amount_cents, vendor_net, NULL AS staff_member_id
    FROM shoot_bookings WHERE stripe_payment_intent_id = ${paymentIntentId}
    ORDER BY type LIMIT 1`);
  if (!r) return null;
  const base = Number(r.deposit_amount_cents ?? r.total_price);
  if (r.type === "shoot_booking") {
    return { type: "shoot_booking", id: r.id, base, intendedPayout: Number(r.vendor_net ?? 0), recipient: "photographer" };
  }
  return {
    type: "appointment", id: r.id, base,
    intendedPayout: calculateBookingFees(base).vendorNetCents,
    recipient: r.staff_member_id ? "staff" : "business",
  };
}

/**
 * The seller's share of one refund, in cents. intendedPayout x min(1, refund / min(base, amountReceived)),
 * rounded, then capped at what the seller still holds (sentNet minus alreadyTaken). Never negative.
 */
export function computeShare(input: { intendedPayout: number; base: number; amountReceived: number; refundCents: number; sentNet: number; alreadyTaken: number }): number {
  const { intendedPayout, base, amountReceived, refundCents, sentNet, alreadyTaken } = input;
  if (!(refundCents > 0) || !(intendedPayout > 0)) return 0;
  const denom = Math.min(base, amountReceived);
  const ratio = denom > 0 ? Math.min(1, refundCents / denom) : 1;
  const share = Math.round(intendedPayout * ratio);
  const left = Math.max(0, sentNet - alreadyTaken);
  return Math.max(0, Math.min(share, left));
}

type StripeServiceT = typeof import("./stripe/stripeService").stripeService;
export type RecoveryBackfillStripe = Pick<StripeServiceT, "listPaymentIntentRefunds">;

async function realStripe(): Promise<RecoveryBackfillStripe> {
  const { stripeService } = await import("./stripe/stripeService");
  return stripeService;
}

/**
 * Record Stripe refunds the hook missed. Looks at bookings with a PaymentIntent that were refunded, or went to
 * refunded/canceled, in the last 30 days (up to limit PaymentIntents, newest first), lists each one's Stripe
 * refunds and records every succeeded or pending one (start date and duplicates are handled by
 * recordBookingRefund). Computes and reverses nothing. A Stripe failure on one PaymentIntent is skipped.
 * Returns how many refunds were passed to recordBookingRefund.
 */
export async function backfillRefunds(limit = 50, s?: RecoveryBackfillStripe): Promise<number> {
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const pis = await rows<{ pi: string }>(sql`
    SELECT pi FROM (
      SELECT stripe_payment_intent_id AS pi, updated_at AS ts FROM appointments
      WHERE stripe_payment_intent_id IS NOT NULL
        AND (refunded_at >= now() - interval '30 days' OR (status IN ('refunded', 'canceled') AND updated_at >= now() - interval '30 days'))
      UNION ALL
      SELECT stripe_payment_intent_id AS pi, updated_at AS ts FROM shoot_bookings
      WHERE stripe_payment_intent_id IS NOT NULL
        AND (refunded_at >= now() - interval '30 days' OR (status IN ('refunded', 'canceled') AND updated_at >= now() - interval '30 days'))
    ) b GROUP BY pi ORDER BY max(ts) DESC LIMIT ${lim}`);
  if (!pis.length) return 0;
  const st = s ?? (await realStripe());
  let recorded = 0;
  for (const { pi } of pis) {
    try {
      const refunds = await st.listPaymentIntentRefunds(pi);
      for (const r of refunds) {
        if (r.status === "failed" || r.status === "canceled") continue;
        await recordBookingRefund({ refundId: r.id, paymentIntentId: pi, refundCents: r.amount, createdUnix: r.created });
        recorded++;
      }
    } catch (err) {
      console.error(`[bookingRecoveries] backfill skipped ${pi}:`, String((err as Error)?.message ?? err).slice(0, 200));
    }
  }
  return recorded;
}
