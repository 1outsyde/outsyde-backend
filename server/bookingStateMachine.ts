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

const DRAFT_TTL_MINUTES = 10;
const PENDING_PROVIDER_TTL_HOURS = 24;

export type BookingErrorCode = 'BOOKING_NOT_FOUND' | 'BOOKING_EXPIRED' | 'INVALID_STATE' | 'ALREADY_CONFIRMED' | 'PENDING_PROVIDER_EXPIRED' | 'DECLINED';

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

export function getDraftExpiryTime(): Date {
  return new Date(Date.now() + DRAFT_TTL_MINUTES * 60 * 1000);
}

export function isDraftExpired(draftExpiresAt: Date | null): boolean {
  if (!draftExpiresAt) return true;
  return new Date() > new Date(draftExpiresAt);
}

export function getPendingProviderExpiryTime(): Date {
  return new Date(Date.now() + PENDING_PROVIDER_TTL_HOURS * 60 * 60 * 1000);
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

  // Check for pending_provider expiry
  if (currentState === 'pending_provider' && isPendingProviderExpired(appointment.pendingProviderExpiresAt)) {
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
    updateData.pendingProviderExpiresAt = getPendingProviderExpiryTime();
  }

  // Handle decline transition
  if (toState === BOOKING_STATES.DECLINED) {
    updateData.declinedAt = new Date();
    updateData.declinedBy = context.triggeredBy;
    updateData.declineReason = context.metadata?.reason;
  }

  await db.update(appointments)
    .set(updateData)
    .where(eq(appointments.id, appointmentId));

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

  // Check for pending_provider expiry
  if (currentState === 'pending_provider' && isPendingProviderExpired(booking.pendingProviderExpiresAt)) {
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
    updateData.pendingProviderExpiresAt = getPendingProviderExpiryTime();
  }

  // Handle decline transition
  if (toState === BOOKING_STATES.DECLINED) {
    updateData.declinedAt = new Date();
    updateData.declinedBy = context.triggeredBy;
    updateData.declineReason = context.metadata?.reason;
  }

  await db.update(shootBookings)
    .set(updateData)
    .where(eq(shootBookings.id, shootBookingId));

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
  const now = new Date();
  
  // First, find expired appointments with PaymentIntents to cancel
  const expiredAptsWithPayment = await db.select({
    id: appointments.id,
    stripePaymentIntentId: appointments.stripePaymentIntentId,
    captureMethod: appointments.captureMethod,
  })
  .from(appointments)
  .where(
    and(
      eq(appointments.status, BOOKING_STATES.PENDING_PROVIDER),
      lt(appointments.pendingProviderExpiresAt, now)
    )
  );

  // Cancel PaymentIntents for manual capture appointments
  for (const apt of expiredAptsWithPayment) {
    if (apt.captureMethod === 'manual' && apt.stripePaymentIntentId) {
      try {
        const { stripeService } = await import('./stripe/stripeService');
        await stripeService.cancelPaymentIntent(apt.stripePaymentIntentId, 'abandoned');
        console.log(`[PendingProviderCleanup] Canceled PaymentIntent ${apt.stripePaymentIntentId} for expired appointment ${apt.id}`);
      } catch (stripeError) {
        console.error(`[PendingProviderCleanup] Failed to cancel PaymentIntent for appointment ${apt.id}:`, stripeError);
      }
    }
  }

  // Update expired appointments
  const expiredAppointments = await db.update(appointments)
    .set({ 
      status: BOOKING_STATES.EXPIRED,
      stateChangedAt: now,
      stateChangedBy: 'system',
      previousState: BOOKING_STATES.PENDING_PROVIDER,
      updatedAt: now,
    })
    .where(
      and(
        eq(appointments.status, BOOKING_STATES.PENDING_PROVIDER),
        lt(appointments.pendingProviderExpiresAt, now)
      )
    )
    .returning({ id: appointments.id });

  // Find expired shoot bookings with PaymentIntents to cancel
  const expiredShootsWithPayment = await db.select({
    id: shootBookings.id,
    stripePaymentIntentId: shootBookings.stripePaymentIntentId,
    captureMethod: shootBookings.captureMethod,
  })
  .from(shootBookings)
  .where(
    and(
      eq(shootBookings.status, BOOKING_STATES.PENDING_PROVIDER),
      lt(shootBookings.pendingProviderExpiresAt, now)
    )
  );

  // Cancel PaymentIntents for manual capture shoot bookings
  for (const booking of expiredShootsWithPayment) {
    if (booking.captureMethod === 'manual' && booking.stripePaymentIntentId) {
      try {
        const { stripeService } = await import('./stripe/stripeService');
        await stripeService.cancelPaymentIntent(booking.stripePaymentIntentId, 'abandoned');
        console.log(`[PendingProviderCleanup] Canceled PaymentIntent ${booking.stripePaymentIntentId} for expired shoot booking ${booking.id}`);
      } catch (stripeError) {
        console.error(`[PendingProviderCleanup] Failed to cancel PaymentIntent for shoot booking ${booking.id}:`, stripeError);
      }
    }
  }

  // Update expired shoot bookings
  const expiredShootBookings = await db.update(shootBookings)
    .set({ 
      status: BOOKING_STATES.EXPIRED,
      stateChangedAt: now,
      stateChangedBy: 'system',
      previousState: BOOKING_STATES.PENDING_PROVIDER,
      updatedAt: now,
    })
    .where(
      and(
        eq(shootBookings.status, BOOKING_STATES.PENDING_PROVIDER),
        lt(shootBookings.pendingProviderExpiresAt, now)
      )
    )
    .returning({ id: shootBookings.id });

  for (const apt of expiredAppointments) {
    await logAuditEntry(
      { bookingType: 'appointment', bookingId: apt.id, triggeredBy: 'system', triggerSource: 'cron' },
      BOOKING_STATES.PENDING_PROVIDER,
      BOOKING_STATES.EXPIRED
    );
  }

  for (const booking of expiredShootBookings) {
    await logAuditEntry(
      { bookingType: 'shoot_booking', bookingId: booking.id, triggeredBy: 'system', triggerSource: 'cron' },
      BOOKING_STATES.PENDING_PROVIDER,
      BOOKING_STATES.EXPIRED
    );
  }

  if (expiredAppointments.length > 0 || expiredShootBookings.length > 0) {
    console.log(`[PendingProviderCleanup] Expired ${expiredAppointments.length} appointments, ${expiredShootBookings.length} shoot bookings`);
  }

  return {
    appointments: expiredAppointments.length,
    shootBookings: expiredShootBookings.length,
  };
}

export function startBookingCleanupJob(intervalMs: number = 60000): NodeJS.Timeout {
  console.log(`[BookingCleanup] Starting cleanup job (interval: ${intervalMs}ms)`);
  
  const cleanup = async () => {
    try {
      await cleanupExpiredDrafts();
      await cleanupExpiredPendingProvider();
      // Also expire old booking holds
      await expireOldHolds();
    } catch (error) {
      console.error("[BookingCleanup] Error during cleanup:", error);
    }
  };

  cleanup();
  
  return setInterval(cleanup, intervalMs);
}

export const startDraftCleanupJob = startBookingCleanupJob;
