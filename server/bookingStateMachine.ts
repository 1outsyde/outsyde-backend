import { db } from "./db";
import {
  appointments,
  shootBookings,
  bookingAuditLog,
  BOOKING_STATES,
  BOOKING_TRANSITIONS,
  type BookingState,
  type CancellationReason
} from "@shared/schema";
import { eq, and, or, lt, inArray } from "drizzle-orm";
import { expireOldHolds } from "./availabilityService";
import { rejectPendingForReference } from "./loyaltyLedger";
import { releasePromoForEndedCheckout } from "./promoCheckout";

// A booking that ends any way other than completed never releases its pending points.
const POINTS_REJECT_STATES: ReadonlySet<string> = new Set([
  BOOKING_STATES.CANCELED,
  BOOKING_STATES.DECLINED,
  BOOKING_STATES.EXPIRED,
  BOOKING_STATES.NO_SHOW,
]);

async function rejectPendingPointsOnEnd(
  referenceType: 'appointment' | 'shoot_booking',
  bookingId: string,
  toState: string,
): Promise<void> {
  if (!POINTS_REJECT_STATES.has(toState)) return;
  try {
    await rejectPendingForReference(referenceType, bookingId, `Booking ${toState}`);
  } catch (err) {
    console.error(`[Points] Failed to reject pending points for ${referenceType} ${bookingId}:`, err);
  }
  // A points code still only held by this booking (never paid: abandoned, declined, expired)
  // goes back to the customer, after its unpaid PaymentIntent is cancelled so it can never be
  // paid with the code too. A code that was used stays used; a full refund gives it back
  // separately (restorePromoForReference at the refund).
  try {
    await releasePromoForEndedCheckout({ type: referenceType, id: bookingId });
  } catch (err) {
    console.error(`[Points] Failed to release points code for ${referenceType} ${bookingId}:`, err);
  }
}

const PENDING_PROVIDER_TTL_HOURS = 48;

export type BookingErrorCode = 'BOOKING_NOT_FOUND' | 'BOOKING_EXPIRED' | 'INVALID_STATE' | 'ALREADY_CONFIRMED' | 'PENDING_PROVIDER_EXPIRED' | 'DECLINED' | 'CONCURRENT_TRANSITION';

export interface StateTransitionResult {
  success: boolean;
  error?: string;
  code?: BookingErrorCode;
  previousState?: BookingState;
  newState?: BookingState;
}

export interface BookingContext {
  bookingType: 'appointment' | 'shoot_booking';
  bookingId: string;
  triggeredBy: string;
  triggerSource: 'api' | 'webhook' | 'cron' | 'admin';
  metadata?: Record<string, any>;
}

export function isValidTransition(fromState: BookingState, toState: BookingState): boolean {
  const allowedTransitions = BOOKING_TRANSITIONS[fromState];
  return allowedTransitions?.includes(toState) ?? false;
}

export function isDraftExpired(draftExpiresAt: Date | null): boolean {
  if (!draftExpiresAt) return true;
  return new Date() > new Date(draftExpiresAt);
}

export function getPendingProviderExpiryTime(): Date {
  return new Date(Date.now() + PENDING_PROVIDER_TTL_HOURS * 60 * 60 * 1000);
}

/** The deadline a caller worked out (48h or the appointment start, Part C), else 48h from now. */
function pendingProviderDeadlineFrom(context: { metadata?: Record<string, any> }): Date {
  const given = context.metadata?.pendingProviderExpiresAt;
  const d = given ? new Date(given) : null;
  return d && Number.isFinite(d.getTime()) ? d : getPendingProviderExpiryTime();
}

export function isPendingProviderExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return true;
  return new Date() > new Date(expiresAt);
}

async function logAuditEntry(
  context: BookingContext,
  fromState: BookingState | null,
  toState: BookingState
): Promise<void> {
  try {
    await db.insert(bookingAuditLog).values({
      bookingType: context.bookingType,
      bookingId: context.bookingId,
      fromState: fromState,
      toState: toState,
      triggeredBy: context.triggeredBy,
      triggerSource: context.triggerSource,
      metadata: context.metadata,
    });
  } catch (error) {
    console.error("[BookingStateMachine] Failed to log audit entry:", error);
  }
}

export async function transitionAppointmentState(
  appointmentId: string,
  toState: BookingState,
  context: Omit<BookingContext, 'bookingType' | 'bookingId'>
): Promise<StateTransitionResult> {
  const [appointment] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  
  if (!appointment) {
    return { success: false, code: 'BOOKING_NOT_FOUND', error: "Booking not found" };
  }

  const currentState = appointment.status as BookingState;

  // Idempotency check: if already confirmed and trying to confirm again
  if (currentState === 'confirmed' && toState === 'confirmed') {
    return { 
      success: false, 
      code: 'ALREADY_CONFIRMED', 
      error: "Booking is already confirmed",
      previousState: currentState 
    };
  }

  if (currentState === 'draft' && isDraftExpired(appointment.draftExpiresAt)) {
    await db.update(appointments)
      .set({ 
        status: BOOKING_STATES.EXPIRED,
        stateChangedAt: new Date(),
        stateChangedBy: 'system',
        previousState: currentState,
        updatedAt: new Date(),
      })
      .where(eq(appointments.id, appointmentId));
    
    await logAuditEntry(
      { bookingType: 'appointment', bookingId: appointmentId, triggeredBy: 'system', triggerSource: 'cron' },
      currentState,
      BOOKING_STATES.EXPIRED
    );
    
    return { success: false, code: 'BOOKING_EXPIRED', error: "Booking draft has expired. Please restart booking." };
  }

  // Past its deadline: refuse the change but leave the row alone. The cleanup job releases the
  // card hold, expires the request through this state machine and tells both sides, once
  // (server/manualRequests.ts, Part C). Expiring is the one move still allowed here.
  if (currentState === 'pending_provider' && toState !== BOOKING_STATES.EXPIRED && isPendingProviderExpired(appointment.pendingProviderExpiresAt)) {
    return { success: false, code: 'PENDING_PROVIDER_EXPIRED', error: "Provider did not respond in time. Please restart booking." };
  }

  // Check for declined state
  if (currentState === 'declined') {
    return { 
      success: false, 
      code: 'DECLINED', 
      error: "Booking was declined by the provider. Please try a different time or provider.",
      previousState: currentState 
    };
  }

  // Check for expired/canceled states trying to transition
  if (['expired', 'canceled', 'completed', 'no_show'].includes(currentState)) {
    return { 
      success: false, 
      code: 'BOOKING_EXPIRED', 
      error: "Booking can no longer be modified. Please restart booking.",
      previousState: currentState 
    };
  }

  if (!isValidTransition(currentState, toState)) {
    return { 
      success: false, 
      code: 'INVALID_STATE',
      error: "Booking can no longer be confirmed. Please restart booking." 
    };
  }

  const updateData: Record<string, any> = {
    status: toState,
    stateChangedAt: new Date(),
    stateChangedBy: context.triggeredBy,
    previousState: currentState,
    updatedAt: new Date(),
  };

  if (toState === BOOKING_STATES.CANCELED) {
    updateData.canceledAt = new Date();
    updateData.canceledBy = context.triggeredBy;
    updateData.cancellationReason = context.metadata?.reason;
  }

  // Handle pending_provider transition - set expiry time
  if (toState === BOOKING_STATES.PENDING_PROVIDER) {
    updateData.pendingProviderExpiresAt = pendingProviderDeadlineFrom(context);
    updateData.providerReminderSentAt = null;
  }

  // Handle decline transition
  if (toState === BOOKING_STATES.DECLINED) {
    updateData.declinedAt = new Date();
    updateData.declinedBy = context.triggeredBy;
    updateData.declineReason = context.metadata?.reason;
  }

  // Conditional on the state read above so two concurrent transitions
  // (e.g. duplicate webhook deliveries) cannot both succeed.
  const updated = await db.update(appointments)
    .set(updateData)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, currentState)))
    .returning({ id: appointments.id });

  if (updated.length === 0) {
    return {
      success: false,
      code: 'CONCURRENT_TRANSITION',
      error: "Booking state changed during this update. Please retry.",
      previousState: currentState,
    };
  }

  await logAuditEntry(
    { 
      bookingType: 'appointment', 
      bookingId: appointmentId, 
      triggeredBy: context.triggeredBy, 
      triggerSource: context.triggerSource,
      metadata: context.metadata 
    },
    currentState,
    toState
  );

  await rejectPendingPointsOnEnd('appointment', appointmentId, toState);

  return { 
    success: true, 
    previousState: currentState, 
    newState: toState 
  };
}

export async function transitionShootBookingState(
  shootBookingId: string,
  toState: BookingState,
  context: Omit<BookingContext, 'bookingType' | 'bookingId'>
): Promise<StateTransitionResult> {
  const [booking] = await db.select().from(shootBookings).where(eq(shootBookings.id, shootBookingId));
  
  if (!booking) {
    return { success: false, code: 'BOOKING_NOT_FOUND', error: "Booking not found" };
  }

  const currentState = booking.status as BookingState;

  // Idempotency check: if already confirmed and trying to confirm again
  if (currentState === 'confirmed' && toState === 'confirmed') {
    return { 
      success: false, 
      code: 'ALREADY_CONFIRMED', 
      error: "Booking is already confirmed",
      previousState: currentState 
    };
  }

  if (currentState === 'draft' && isDraftExpired(booking.draftExpiresAt)) {
    await db.update(shootBookings)
      .set({ 
        status: BOOKING_STATES.EXPIRED,
        stateChangedAt: new Date(),
        stateChangedBy: 'system',
        previousState: currentState,
        updatedAt: new Date(),
      })
      .where(eq(shootBookings.id, shootBookingId));
    
    await logAuditEntry(
      { bookingType: 'shoot_booking', bookingId: shootBookingId, triggeredBy: 'system', triggerSource: 'cron' },
      currentState,
      BOOKING_STATES.EXPIRED
    );
    
    return { success: false, code: 'BOOKING_EXPIRED', error: "Booking draft has expired. Please restart booking." };
  }

  // Past its deadline: refuse the change but leave the row alone. The cleanup job releases the
  // card hold, expires the request through this state machine and tells both sides, once
  // (server/manualRequests.ts, Part C). Expiring is the one move still allowed here.
  if (currentState === 'pending_provider' && toState !== BOOKING_STATES.EXPIRED && isPendingProviderExpired(booking.pendingProviderExpiresAt)) {
    return { success: false, code: 'PENDING_PROVIDER_EXPIRED', error: "Provider did not respond in time. Please restart booking." };
  }

  // Check for declined state
  if (currentState === 'declined') {
    return { 
      success: false, 
      code: 'DECLINED', 
      error: "Booking was declined by the provider. Please try a different time or provider.",
      previousState: currentState 
    };
  }

  // Check for expired/canceled states trying to transition
  if (['expired', 'canceled', 'completed', 'no_show'].includes(currentState)) {
    return { 
      success: false, 
      code: 'BOOKING_EXPIRED', 
      error: "Booking can no longer be modified. Please restart booking.",
      previousState: currentState 
    };
  }

  if (!isValidTransition(currentState, toState)) {
    return { 
      success: false, 
      code: 'INVALID_STATE',
      error: "Booking can no longer be confirmed. Please restart booking." 
    };
  }

  const updateData: Record<string, any> = {
    status: toState,
    stateChangedAt: new Date(),
    stateChangedBy: context.triggeredBy,
    previousState: currentState,
    updatedAt: new Date(),
  };

  if (toState === BOOKING_STATES.CANCELED) {
    updateData.canceledAt = new Date();
    updateData.canceledBy = context.triggeredBy;
    updateData.cancellationReason = context.metadata?.reason;
  }

  // Handle pending_provider transition - set expiry time
  if (toState === BOOKING_STATES.PENDING_PROVIDER) {
    updateData.pendingProviderExpiresAt = pendingProviderDeadlineFrom(context);
    updateData.providerReminderSentAt = null;
  }

  // Handle decline transition
  if (toState === BOOKING_STATES.DECLINED) {
    updateData.declinedAt = new Date();
    updateData.declinedBy = context.triggeredBy;
    updateData.declineReason = context.metadata?.reason;
  }

  // Conditional on the state read above so two concurrent transitions
  // (e.g. duplicate webhook deliveries) cannot both succeed.
  const updated = await db.update(shootBookings)
    .set(updateData)
    .where(and(eq(shootBookings.id, shootBookingId), eq(shootBookings.status, currentState)))
    .returning({ id: shootBookings.id });

  if (updated.length === 0) {
    return {
      success: false,
      code: 'CONCURRENT_TRANSITION',
      error: "Booking state changed during this update. Please retry.",
      previousState: currentState,
    };
  }

  await logAuditEntry(
    { 
      bookingType: 'shoot_booking', 
      bookingId: shootBookingId, 
      triggeredBy: context.triggeredBy, 
      triggerSource: context.triggerSource,
      metadata: context.metadata 
    },
    currentState,
    toState
  );

  await rejectPendingPointsOnEnd('shoot_booking', shootBookingId, toState);

  return { 
    success: true, 
    previousState: currentState, 
    newState: toState 
  };
}

export async function cleanupExpiredDrafts(): Promise<{ appointments: number; shootBookings: number }> {
  const now = new Date();
  
  const expiredAppointments = await db.update(appointments)
    .set({ 
      status: BOOKING_STATES.EXPIRED,
      stateChangedAt: now,
      stateChangedBy: 'system',
      previousState: BOOKING_STATES.DRAFT,
      updatedAt: now,
    })
    .where(
      and(
        eq(appointments.status, BOOKING_STATES.DRAFT),
        lt(appointments.draftExpiresAt, now)
      )
    )
    .returning({ id: appointments.id });

  const expiredShootBookings = await db.update(shootBookings)
    .set({ 
      status: BOOKING_STATES.EXPIRED,
      stateChangedAt: now,
      stateChangedBy: 'system',
      previousState: BOOKING_STATES.DRAFT,
      updatedAt: now,
    })
    .where(
      and(
        eq(shootBookings.status, BOOKING_STATES.DRAFT),
        lt(shootBookings.draftExpiresAt, now)
      )
    )
    .returning({ id: shootBookings.id });

  for (const apt of expiredAppointments) {
    await logAuditEntry(
      { bookingType: 'appointment', bookingId: apt.id, triggeredBy: 'system', triggerSource: 'cron' },
      BOOKING_STATES.DRAFT,
      BOOKING_STATES.EXPIRED
    );
  }

  for (const booking of expiredShootBookings) {
    await logAuditEntry(
      { bookingType: 'shoot_booking', bookingId: booking.id, triggeredBy: 'system', triggerSource: 'cron' },
      BOOKING_STATES.DRAFT,
      BOOKING_STATES.EXPIRED
    );
  }

  console.log(`[DraftCleanup] Expired ${expiredAppointments.length} appointments, ${expiredShootBookings.length} shoot bookings`);

  return {
    appointments: expiredAppointments.length,
    shootBookings: expiredShootBookings.length,
  };
}

export async function cleanupExpiredPendingProvider(): Promise<{ appointments: number; shootBookings: number }> {
  // Part C: one expiry path for both tables (release the card hold first, per-row conditional
  // transition, both sides told once, shoot slot released). See server/manualRequests.ts.
  const { expireDueRequests, manualRequestDefaultDeps } = await import("./manualRequests");
  const r = await expireDueRequests(new Date(), await manualRequestDefaultDeps());
  return { appointments: r.appointments, shootBookings: r.shootBookings };
}

export function startBookingCleanupJob(intervalMs: number = 60000): NodeJS.Timeout {
  console.log(`[BookingCleanup] Starting cleanup job (interval: ${intervalMs}ms)`);
  
  const cleanup = async () => {
    try {
      await cleanupExpiredDrafts();
      // Also expire old booking holds
      await expireOldHolds();
    } catch (error) {
      console.error("[BookingCleanup] Error during cleanup:", error);
    }
    // Manual-accept requests (Part C): paid checkouts become requests, reminders, expiry.
    // Own try/catch so it can never starve the steps above or below.
    try {
      const { runManualRequestJob } = await import("./manualRequests");
      await runManualRequestJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during manual-request step:", error);
    }
    // Abandoned checkouts (Part B): own try/catch so it can never starve the steps above.
    try {
      const { cleanupAbandonedPendingPayment } = await import("./abandonedCheckouts");
      await cleanupAbandonedPendingPayment();
    } catch (error) {
      console.error("[BookingCleanup] Error during abandoned-checkout cleanup:", error);
    }
    // Event tickets: settle paid orders whose webhook was lost, expire abandoned holds.
    // Own try/catch so it can never starve the steps above.
    try {
      const { runTicketOrderJob } = await import("./events/ticketCheckout");
      await runTicketOrderJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during ticket order job:", error);
    }

    // Event tickets: send recorded refunds (retries with backoff) and refund guests of cancelled events.
    // Own try/catch, after the order job, so neither can starve the other.
    try {
      const { runTicketRefundJob } = await import("./events/ticketRefunds");
      await runTicketRefundJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during ticket refund job:", error);
    }

    // Event host payouts: one transfer per event, 3 days after it ends (claim with a 10 minute in-flight lock, one key per try, group lookup first: safe to run twice).
    // Own try/catch, after the refund job, so neither can starve the other.
    try {
      const { runEventPayoutJob } = await import("./events/eventPayouts");
      await runEventPayoutJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during event payout job:", error);
    }

    // Business referral cash: $25 to the referrer 7 days after a referred business qualifies (claim with a 10 minute in-flight lock, one key per claim, group lookup first: safe to run twice).
    // Own try/catch, before the bank payout job, so neither can starve the other.
    try {
      const { runReferralPayoutJob } = await import("./referrals/businessReferrals");
      await runReferralPayoutJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during referral payout job:", error);
    }

    // Daily bank payout: at most one Stripe payout a New York day (first run at or after 6:00) to Outsyde's bank, only money not held for anyone (off unless DAILY_BANK_PAYOUT_ENABLED is "true"; day claim + 10 minute lock, one key per try, lookup first: safe to run twice).
    // Own try/catch, after the event payout job, so neither can starve the other.
    try {
      const { runBankPayoutJob } = await import("./bankPayout");
      await runBankPayoutJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during bank payout job:", error);
    }

    // Booking refund recovery: take the seller's share of each booking refund back from their transfer, owed when their balance is short, seller alerts (claim with a 10 minute in-flight lock, lookup before every reversal, one key per try: safe to run twice).
    // Own try/catch, after the bank payout job, so neither can starve the other.
    try {
      const { runBookingRecoveryJob } = await import("./bookingRecoveries");
      await runBookingRecoveryJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during booking refund recovery job:", error);
    }

    // Stripe dashboard refunds and disputes (p5-stripe-sync): every 15 minutes read Stripe's own refund and dispute events
    // of the last 3 days (the webhook answers before it works and Stripe never retries), every minute settle closed
    // disputes (recoveries, held share release with claim + lock + lookup first). Each event is applied once: safe to run twice.
    // Own try/catch, after the booking recovery step, so neither can starve the other.
    try {
      const { runStripeSyncJob, SYNC_EVENTS_EVERY_MINUTES } = await import("./stripe/stripeSync");
      await runStripeSyncJob(undefined, { listEvents: new Date().getUTCMinutes() % SYNC_EVENTS_EVERY_MINUTES === 0 });
    } catch (error) {
      console.error("[BookingCleanup] Error during Stripe sync job:", error);
    }

    // Day-of address reveal: one push and email per ticket holder once the reveal time passes (atomic claim on tickets.address_reveal_notified_at: safe to run twice).
    // Own try/catch, after the booking recovery step, so neither can starve the other.
    try {
      const { runAddressRevealJob } = await import("./events/addressReveal");
      await runAddressRevealJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during address reveal job:", error);
    }

    // Event reminders: guests get a push the day before and 2 hours before, the host one the day before (atomic claims on
    // tickets.reminder_day_before_at / reminder_soon_at and events.host_reminder_at: safe to run twice). Push only.
    // Own try/catch, after the address reveal, so neither can starve the other.
    try {
      const { runEventReminderJob } = await import("./events/eventReminders");
      await runEventReminderJob();
    } catch (error) {
      console.error("[BookingCleanup] Error during event reminder job:", error);
    }
  };

  cleanup();
  
  return setInterval(cleanup, intervalMs);
}

export const startDraftCleanupJob = startBookingCleanupJob;
