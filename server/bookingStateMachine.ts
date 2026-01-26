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

const DRAFT_TTL_MINUTES = 10;

export type BookingErrorCode = 'BOOKING_NOT_FOUND' | 'BOOKING_EXPIRED' | 'INVALID_STATE' | 'ALREADY_CONFIRMED';

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

export function startDraftCleanupJob(intervalMs: number = 60000): NodeJS.Timeout {
  console.log(`[DraftCleanup] Starting cleanup job (interval: ${intervalMs}ms)`);
  
  const cleanup = async () => {
    try {
      await cleanupExpiredDrafts();
    } catch (error) {
      console.error("[DraftCleanup] Error during cleanup:", error);
    }
  };

  cleanup();
  
  return setInterval(cleanup, intervalMs);
}
