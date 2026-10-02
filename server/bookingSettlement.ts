import { db } from "./db";
import { appointments, shootBookings, BOOKING_STATES } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { storage } from "./storage";
import { stripeService } from "./stripe/stripeService";
import { markHoldAsConverted } from "./availabilityService";
import { calculateBookingFees } from "./fees";

export type SettlementResult =
  | { settled: true; transferId: string | null }
  | { settled: false; reason: string };

function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || err?.cause?.code === '23505';
}

/**
 * Post-confirmation work for a hold-based ('appointment') booking: hold
 * conversion, vendor payout, pending points, referral. Runs at most once per
 * appointment: settled_at is claimed first with a conditional UPDATE, so the
 * Accept route and the payment_intent.succeeded webhook can both call this
 * and only one of them does the work.
 *
 * Sends no receipts or notifications and never changes status. A failed
 * payout keeps settled_at (stripe_transfer_id stays NULL) for manual
 * reconciliation; settled_at is never reset.
 */
export async function settleAppointmentBooking(appointmentId: string): Promise<SettlementResult> {
  const [appointment] = await db.update(appointments)
    .set({ settledAt: sql`now()` })
    .where(and(
      eq(appointments.id, appointmentId),
      eq(appointments.status, BOOKING_STATES.CONFIRMED),
      isNull(appointments.settledAt),
    ))
    .returning();

  if (!appointment) {
    const [current] = await db.select({ status: appointments.status, settledAt: appointments.settledAt })
      .from(appointments)
      .where(eq(appointments.id, appointmentId));
    const reason = !current
      ? 'not_found'
      : current.settledAt
        ? 'already_settled'
        : `status_${current.status}`;
    console.log(`[Settlement] appointment ${appointmentId} not settled: ${reason}`);
    return { settled: false, reason };
  }

  const { holdId, businessId, staffMemberId } = appointment;

  if (holdId) {
    try {
      await markHoldAsConverted(holdId, appointmentId, 'appointment');
    } catch (holdErr) {
      console.error(`[Settlement] Failed to convert hold ${holdId}:`, holdErr);
    }
  }

  // Same amount the webhook has always transferred: the stored deposit when
  // one was configured, otherwise the full service price.
  const chargedAmountCents = appointment.depositAmountCents ?? appointment.totalPrice;
  const vendorNetCents = calculateBookingFees(chargedAmountCents).vendorNetCents;

  const business = await storage.getBusiness(businessId).catch(() => undefined);
  let transferId: string | null = null;

  if (!business?.stripeAccountId) {
    console.error(`[Settlement] PAYOUT FAILED appointment ${appointmentId}: business ${businessId} has no stripeAccountId. Funds remain on platform balance -- manual reconciliation required.`);
  } else if (staffMemberId) {
    // Staff member receives the full vendorNetCents; no booth-split column exists yet.
    const staffMember = await storage.getStaffMember(staffMemberId);
    if (!staffMember?.stripeAccountId) {
      console.error(`[Settlement] PAYOUT FAILED appointment ${appointmentId}: staff member ${staffMemberId} has no stripeAccountId. Funds remain on platform balance -- manual reconciliation required.`);
    } else {
      try {
        const transfer = await stripeService.transferBookingPayout({
          amountInCents: vendorNetCents,
          connectedAccountId: staffMember.stripeAccountId,
          appointmentId,
          recipient: 'staff',
        });
        transferId = transfer.id;
        await db.update(appointments).set({
          staffPayout: vendorNetCents,
          stripeTransferId: transfer.id,
          updatedAt: new Date(),
        }).where(eq(appointments.id, appointmentId));
        console.log(`[Settlement] Transferred ${vendorNetCents}c to staff ${staffMemberId} (transfer ${transfer.id}) for appointment ${appointmentId}`);
      } catch (transferErr) {
        console.error(`[Settlement] PAYOUT FAILED appointment ${appointmentId}`, transferErr);
      }
    }
  } else {
    try {
      const transfer = await stripeService.transferBookingPayout({
        amountInCents: vendorNetCents,
        connectedAccountId: business.stripeAccountId,
        appointmentId,
        recipient: 'business',
      });
      transferId = transfer.id;
      await db.update(appointments).set({
        stripeTransferId: transfer.id,
        updatedAt: new Date(),
      }).where(eq(appointments.id, appointmentId));
      console.log(`[Settlement] Transferred ${vendorNetCents}c to business ${businessId} (transfer ${transfer.id}) for appointment ${appointmentId}`);
    } catch (transferErr) {
      console.error(`[Settlement] PAYOUT FAILED appointment ${appointmentId}`, transferErr);
    }
  }

  // Pending points on totalPrice (full service value), approved at completion.
  try {
    await storage.createPendingPointTransaction({
      userId: appointment.clientId,
      dollarAmountCents: appointment.totalPrice,
      transactionType: 'business_transaction',
      referenceType: 'appointment',
      referenceId: appointmentId,
      description: 'Points earned from service booking',
      businessId,
    });
  } catch (pointsErr) {
    if (isUniqueViolation(pointsErr)) {
      console.log(`[Settlement] pending points for appointment ${appointmentId} already exist`);
    } else {
      console.error(`[Settlement] createPendingPointTransaction for appointment ${appointmentId} failed:`, pointsErr);
    }
  }

  try {
    // Dynamic import: webhookHandlers imports this module.
    const { WebhookHandlers } = await import("./stripe/webhookHandlers");
    await WebhookHandlers.tryCompleteReferral(appointment.clientId, appointmentId, 'appointment');
  } catch (referralErr) {
    console.error(`[Settlement] tryCompleteReferral for appointment ${appointmentId} failed:`, referralErr);
  }

  return { settled: true, transferId };
}

/**
 * Post-confirmation work for a shoot booking: hold conversion, photographer
 * payout, points, referral. Same once-only rule as settleAppointmentBooking:
 * settled_at is claimed first, so the photographer Accept route and the
 * payment_intent.succeeded webhook can both call this.
 *
 * paymentIntent is the charge that paid for the booking. Its metadata carries
 * holdId (hold flow only), clientId and originalConsumerTotalCents, which the
 * booking row does not store.
 *
 * Sends no receipts or notifications and never changes status. A failed
 * payout keeps settled_at (stripe_transfer_id stays NULL) for manual
 * reconciliation; settled_at is never reset.
 */
export async function settleShootBooking(
  bookingId: string,
  paymentIntent: {
    amount: number;
    metadata?: Record<string, string> | null;
    transfer_data?: { destination?: string | { id: string } | null } | null;
  },
): Promise<SettlementResult> {
  const [booking] = await db.update(shootBookings)
    .set({ settledAt: sql`now()` })
    .where(and(
      eq(shootBookings.id, bookingId),
      eq(shootBookings.status, BOOKING_STATES.CONFIRMED),
      isNull(shootBookings.settledAt),
    ))
    .returning();

  if (!booking) {
    const [current] = await db.select({ status: shootBookings.status, settledAt: shootBookings.settledAt })
      .from(shootBookings)
      .where(eq(shootBookings.id, bookingId));
    const reason = !current
      ? 'not_found'
      : current.settledAt
        ? 'already_settled'
        : `status_${current.status}`;
    console.log(`[Settlement] shoot booking ${bookingId} not settled: ${reason}`);
    return { settled: false, reason };
  }

  const metadata = paymentIntent.metadata || {};

  // holdId is only present on PaymentIntents from the hold-based flow
  // (POST /api/booking/:holdId/create-payment-intent).
  if (metadata.holdId) {
    try {
      await markHoldAsConverted(metadata.holdId, bookingId, 'shoot_booking');
    } catch (holdErr) {
      console.error(`[Settlement] Failed to convert hold ${metadata.holdId} for shoot booking ${bookingId}:`, holdErr);
    }
  }

  // vendor_net is written by both create-payment-intent routes with the same
  // value they put in the PaymentIntent's vendorPayoutCents metadata.
  const vendorNetCents = booking.vendorNet ?? 0;
  const photographer = await storage.getPhotographer(booking.photographerId).catch(() => undefined);
  let transferId: string | null = null;

  if (paymentIntent.transfer_data?.destination) {
    // Destination charge: Stripe already moved the photographer's share.
    console.log(`[Settlement] shoot booking ${bookingId} destination charge — no transfer`);
  } else if (vendorNetCents <= 0) {
    console.error(`[Settlement] PAYOUT FAILED shoot booking ${bookingId}: vendor_net is ${booking.vendorNet}. Manual reconciliation required.`);
  } else if (!photographer?.stripeAccountId) {
    console.error(`[Settlement] PAYOUT FAILED shoot booking ${bookingId}: photographer ${booking.photographerId} has no stripeAccountId. Funds remain on platform balance -- manual reconciliation required.`);
  } else {
    try {
      const transfer = await stripeService.transferShootBookingPayout({
        amountInCents: vendorNetCents,
        connectedAccountId: photographer.stripeAccountId,
        bookingId,
      });
      transferId = transfer.id;
      await db.update(shootBookings).set({
        stripeTransferId: transfer.id,
        updatedAt: new Date(),
      }).where(eq(shootBookings.id, bookingId));
      console.log(`[Settlement] Transferred ${vendorNetCents}c to photographer ${photographer.id} (transfer ${transfer.id}) for shoot booking ${bookingId}`);
    } catch (transferErr) {
      console.error(`[Settlement] PAYOUT FAILED shoot booking ${bookingId}`, transferErr);
    }
  }

  // Points on the original pre-discount total, earned immediately.
  const pointsBase = metadata.originalConsumerTotalCents ? Number(metadata.originalConsumerTotalCents) : paymentIntent.amount;
  const user = metadata.clientId ? await storage.getUser(metadata.clientId).catch(() => undefined) : undefined;
  if (user) {
    try {
      await storage.earnPoints({
        userId: user.id,
        dollarAmountCents: pointsBase,
        transactionType: 'photographer_booking',
        referenceType: 'shoot_booking',
        referenceId: bookingId,
        description: 'Points earned from photographer booking',
      });
    } catch (pointsErr) {
      console.error(`[Settlement] earnPoints for shoot booking ${bookingId} failed:`, pointsErr);
    }
    try {
      const { WebhookHandlers } = await import("./stripe/webhookHandlers");
      await WebhookHandlers.tryCompleteReferral(user.id, bookingId, 'shoot_booking');
    } catch (referralErr) {
      console.error(`[Settlement] tryCompleteReferral for shoot booking ${bookingId} failed:`, referralErr);
    }
  }

  return { settled: true, transferId };
}

/**
 * Settlement for a confirmed free consultation (payment_method 'free'): claims
 * settled_at with the same once-only conditional UPDATE as
 * settleAppointmentBooking, then converts the hold. Nothing else: no payout,
 * no points, no referral (nothing was paid).
 */
export async function settleFreeAppointmentBooking(appointmentId: string): Promise<SettlementResult> {
  const [appointment] = await db.update(appointments)
    .set({ settledAt: sql`now()` })
    .where(and(
      eq(appointments.id, appointmentId),
      eq(appointments.status, BOOKING_STATES.CONFIRMED),
      eq(appointments.paymentMethod, 'free'),
      isNull(appointments.settledAt),
    ))
    .returning();

  if (!appointment) {
    const [current] = await db.select({ status: appointments.status, settledAt: appointments.settledAt, paymentMethod: appointments.paymentMethod })
      .from(appointments)
      .where(eq(appointments.id, appointmentId));
    const reason = !current
      ? 'not_found'
      : current.paymentMethod !== 'free'
        ? 'not_free'
        : current.settledAt
          ? 'already_settled'
          : `status_${current.status}`;
    console.log(`[Settlement] free appointment ${appointmentId} not settled: ${reason}`);
    return { settled: false, reason };
  }

  if (appointment.holdId) {
    try {
      await markHoldAsConverted(appointment.holdId, appointmentId, 'appointment');
    } catch (holdErr) {
      console.error(`[Settlement] Failed to convert hold ${appointment.holdId} for free appointment ${appointmentId}:`, holdErr);
    }
  }

  return { settled: true, transferId: null };
}
