/**
 * Abandoned checkouts (Part B, 2026-10-17).
 *
 * A customer gets 10 minutes on the payment screen (the booking hold). Clients close the payment
 * form and show a pop-up when the hold runs out. This job is the backend side: it expires bookings
 * left in `pending_payment` and cancels their unpaid PaymentIntent, so a payment screen left open
 * somewhere can never charge for a booking that no longer exists.
 *
 * Rules (never touch money that is moving):
 *  - Only rows in `pending_payment` whose `updated_at` is older than ABANDON_AFTER_MS. `updated_at`
 *    (not `created_at`) because draft-path rows are created before they become `pending_payment`.
 *  - No PaymentIntent → expire.
 *  - PaymentIntent `canceled` → expire (cancel already happened, e.g. via webhook or an earlier run).
 *  - `succeeded`, `processing`, `requires_capture` → skip; the payment webhook confirms the booking.
 *  - Anything else (`requires_payment_method`, `requires_confirmation`, `requires_action`) → cancel,
 *    then expire.
 *  - Any Stripe error (retrieve or cancel) → skip this run; the row is retried next minute.
 *  - Expire through the state machine (audit log, conditional update). A row that changed state in
 *    the meantime (BOOKING_EXPIRED / CONCURRENT_TRANSITION) is treated as done.
 *  - Shoot bookings: release the photographer's reserved slot whenever the row ended terminal
 *    (the `payment_intent.canceled` webhook moves shoots to `canceled` without releasing it).
 *  - No email, no push, no notification of any kind (the customer walked away themselves).
 */
import { db } from "./db";
import { appointments, shootBookings, BOOKING_STATES } from "@shared/schema";
import { and, eq, lt } from "drizzle-orm";
import type { StateTransitionResult } from "./bookingStateMachine";

/** Hold is 10 minutes; 5 more for a slow bank check before the backend cleans up. */
export const ABANDON_AFTER_MS = 15 * 60 * 1000;

/** PaymentIntent states where money is (or may be) moving: never cancel these. */
const MONEY_MOVING = new Set(["succeeded", "processing", "requires_capture"]);

const TERMINAL = new Set<string>([
  BOOKING_STATES.EXPIRED, BOOKING_STATES.CANCELED, BOOKING_STATES.DECLINED,
  BOOKING_STATES.COMPLETED, BOOKING_STATES.NO_SHOW,
]);

export type AbandonedDecision = "expire" | "cancel_then_expire" | "skip";

/** What to do with an abandoned row, given its PaymentIntent status (null = no PaymentIntent). */
export function decideAbandoned(piStatus: string | null): AbandonedDecision {
  if (piStatus === null) return "expire";
  if (piStatus === "canceled") return "expire";
  if (MONEY_MOVING.has(piStatus)) return "skip";
  return "cancel_then_expire";
}

export interface AbandonedDeps {
  getPaymentIntentStatus: (paymentIntentId: string) => Promise<string>;
  cancelPaymentIntent: (paymentIntentId: string) => Promise<unknown>;
  transitionAppointment: (id: string) => Promise<StateTransitionResult>;
  transitionShoot: (id: string) => Promise<StateTransitionResult>;
  getShootStatus: (id: string) => Promise<string | null>;
  releasePhotographerSlot: (shootBookingId: string) => Promise<unknown>;
}

async function defaultDeps(): Promise<AbandonedDeps> {
  const { stripeService } = await import("./stripe/stripeService");
  const { transitionAppointmentState, transitionShootBookingState } = await import("./bookingStateMachine");
  const { storage } = await import("./storage");
  const ctx = { triggeredBy: "system", triggerSource: "cron" as const, metadata: { action: "abandoned_checkout" } };
  return {
    getPaymentIntentStatus: async (id) => (await stripeService.getPaymentIntent(id)).status,
    cancelPaymentIntent: (id) => stripeService.cancelPaymentIntent(id, "abandoned"),
    transitionAppointment: (id) => transitionAppointmentState(id, BOOKING_STATES.EXPIRED, ctx),
    transitionShoot: (id) => transitionShootBookingState(id, BOOKING_STATES.EXPIRED, ctx),
    getShootStatus: async (id) => {
      const [row] = await db.select({ status: shootBookings.status }).from(shootBookings).where(eq(shootBookings.id, id));
      return row?.status ?? null;
    },
    releasePhotographerSlot: (id) => storage.releasePhotographerSlot(id),
  };
}

/** Returns true when the row's PaymentIntent is safe to treat as dead (cancelled now or before). */
async function settlePaymentIntent(kind: string, id: string, piId: string | null, deps: AbandonedDeps): Promise<boolean> {
  if (!piId) return true;
  let status: string;
  try {
    status = await deps.getPaymentIntentStatus(piId);
  } catch (err) {
    console.error(`[AbandonedCheckout] ${kind} ${id}: could not read PaymentIntent ${piId}, will retry`, err);
    return false;
  }
  const decision = decideAbandoned(status);
  if (decision === "skip") {
    console.log(`[AbandonedCheckout] ${kind} ${id}: PaymentIntent ${piId} is ${status}, leaving it to the payment webhook`);
    return false;
  }
  if (decision === "cancel_then_expire") {
    try {
      await deps.cancelPaymentIntent(piId);
    } catch (err) {
      console.error(`[AbandonedCheckout] ${kind} ${id}: could not cancel PaymentIntent ${piId} (${status}), will retry`, err);
      return false;
    }
  }
  return true;
}

const doneCodes = new Set(["BOOKING_EXPIRED", "CONCURRENT_TRANSITION"]);

export async function cleanupAbandonedPendingPayment(
  now: Date = new Date(),
  deps?: AbandonedDeps,
): Promise<{ appointments: number; shootBookings: number; skipped: number }> {
  const d = deps ?? (await defaultDeps());
  const cutoff = new Date(now.getTime() - ABANDON_AFTER_MS);
  let apptCount = 0;
  let shootCount = 0;
  let skipped = 0;

  const appts = await db.select({ id: appointments.id, pi: appointments.stripePaymentIntentId })
    .from(appointments)
    .where(and(eq(appointments.status, BOOKING_STATES.PENDING_PAYMENT), lt(appointments.updatedAt, cutoff)));

  for (const a of appts) {
    try {
      if (!(await settlePaymentIntent("appointment", a.id, a.pi, d))) { skipped++; continue; }
      const r = await d.transitionAppointment(a.id);
      if (r.success) apptCount++;
      else if (!doneCodes.has(String(r.code))) {
        skipped++;
        console.error(`[AbandonedCheckout] appointment ${a.id}: could not expire (${r.code}): ${r.error}`);
      }
    } catch (err) {
      skipped++;
      console.error(`[AbandonedCheckout] appointment ${a.id} failed:`, err);
    }
  }

  const shoots = await db.select({ id: shootBookings.id, pi: shootBookings.stripePaymentIntentId })
    .from(shootBookings)
    .where(and(eq(shootBookings.status, BOOKING_STATES.PENDING_PAYMENT), lt(shootBookings.updatedAt, cutoff)));

  for (const s of shoots) {
    try {
      if (!(await settlePaymentIntent("shoot_booking", s.id, s.pi, d))) { skipped++; continue; }
      const r = await d.transitionShoot(s.id);
      if (r.success) shootCount++;
      else if (!doneCodes.has(String(r.code))) {
        skipped++;
        console.error(`[AbandonedCheckout] shoot_booking ${s.id}: could not expire (${r.code}): ${r.error}`);
        continue;
      }
      // Free the photographer's reserved slot whenever the booking is over, however it ended.
      const status = await d.getShootStatus(s.id);
      if (status && TERMINAL.has(status)) await d.releasePhotographerSlot(s.id);
    } catch (err) {
      skipped++;
      console.error(`[AbandonedCheckout] shoot_booking ${s.id} failed:`, err);
    }
  }

  if (apptCount || shootCount || skipped) {
    console.log(`[AbandonedCheckout] Expired ${apptCount} appointments, ${shootCount} shoot bookings; ${skipped} left for a later run`);
  }
  return { appointments: apptCount, shootBookings: shootCount, skipped };
}
