/**
 * Booking refund recovery (P1 #5): after a booking refund, the seller's share is later taken back from their
 * Stripe transfer. This file records each Stripe refund (the hook in stripeService.createBookingRefund calls
 * recordBookingRefund); later tasks add the rest.
 */
import { sql } from "drizzle-orm";
import { rows } from "./events/eventsRouter";

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
