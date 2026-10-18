import { db } from "./db";
import { appointments, shootBookings, BOOKING_STATES } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { storage } from "./storage";
import { stripeService } from "./stripe/stripeService";
import { markHoldAsConverted } from "./availabilityService";
import { calculateBookingFees } from "./fees";
import { releaseAfterForBooking } from "./loyaltyLedger";
import { payBookingRecipient } from "./payouts";

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
      // Same transfer as before; if Outsyde's balance is short it falls back to the customer's
      // charge, and anything left unpaid is retried hourly with an alert (server/payouts.ts).
      const staffAccountId = staffMember.stripeAccountId;
      const paid = await payBookingRecipient({
        kind: 'appointment',
        bookingId: appointmentId,
        recipient: 'staff',
        connectedAccountId: staffAccountId,
        amountCents: vendorNetCents,
        paymentIntentId: appointment.stripePaymentIntentId ?? null,
        fastPath: () => stripeService.transferBookingPayout({
          amountInCents: vendorNetCents,
          connectedAccountId: staffAccountId,
          appointmentId,
          recipient: 'staff',
        }),
      });
      if (paid.baseTransferId) {
        transferId = paid.baseTransferId;
        await db.update(appointments).set({
          staffPayout: vendorNetCents,
          stripeTransferId: paid.baseTransferId,
          updatedAt: new Date(),
        }).where(eq(appointments.id, appointmentId));
        console.log(`[Settlement] Transferred ${vendorNetCents}c to staff ${staffMemberId} (transfer ${paid.baseTransferId}) for appointment ${appointmentId}`);
      } else {
        console.error(`[Settlement] PAYOUT FAILED appointment ${appointmentId}: queued for retry`);
      }
    }
  } else {
    const businessAccountId = business.stripeAccountId;
    const paid = await payBookingRecipient({
      kind: 'appointment',
      bookingId: appointmentId,
      recipient: 'business',
      connectedAccountId: businessAccountId,
      amountCents: vendorNetCents,
      paymentIntentId: appointment.stripePaymentIntentId ?? null,
      fastPath: () => stripeService.transferBookingPayout({
        amountInCents: vendorNetCents,
        connectedAccountId: businessAccountId,
        appointmentId,
        recipient: 'business',
      }),
    });
    if (paid.baseTransferId) {
      transferId = paid.baseTransferId;
      await db.update(appointments).set({
        stripeTransferId: paid.baseTransferId,
        updatedAt: new Date(),
      }).where(eq(appointments.id, appointmentId));
      console.log(`[Settlement] Transferred ${vendorNetCents}c to business ${businessId} (transfer ${paid.baseTransferId}) for appointment ${appointmentId}`);
    } else {
      console.error(`[Settlement] PAYOUT FAILED appointment ${appointmentId}: queued for retry`);
    }
  }

  // Pending points on what went through Outsyde (deposit or full charge, plus the service fee),
  // released when the business marks it complete or 3 days after the appointment. The referral
  // check runs at release, once the booking is final.
  try {
    await storage.createPendingPointTransaction({
      userId: appointment.clientId,
      dollarAmountCents: calculateBookingFees(chargedAmountCents).customerTotalBeforeTaxCents,
      transactionType: 'business_transaction',
      referenceType: 'appointment',
      referenceId: appointmentId,
      description: 'Points earned from service booking',
      businessId,
      releaseAfter: releaseAfterForBooking(appointment.appointmentDate, appointment.appointmentEndTime ?? appointment.appointmentTime),
    });
  } catch (pointsErr) {
    if (isUniqueViolation(pointsErr)) {
      console.log(`[Settlement] pending points for appointment ${appointmentId} already exist`);
    } else {
      console.error(`[Settlement] createPendingPointTransaction for appointment ${appointmentId} failed:`, pointsErr);
    }
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
    const photographerAccountId = photographer.stripeAccountId;
    const paid = await payBookingRecipient({
      kind: 'shoot_booking',
      bookingId,
      recipient: 'photographer',
      connectedAccountId: photographerAccountId,
      amountCents: vendorNetCents,
      paymentIntentId: booking.stripePaymentIntentId ?? null,
      fastPath: () => stripeService.transferShootBookingPayout({
        amountInCents: vendorNetCents,
        connectedAccountId: photographerAccountId,
        bookingId,
      }),
    });
    if (paid.baseTransferId) {
      transferId = paid.baseTransferId;
      await db.update(shootBookings).set({
        stripeTransferId: paid.baseTransferId,
        updatedAt: new Date(),
      }).where(eq(shootBookings.id, bookingId));
      console.log(`[Settlement] Transferred ${vendorNetCents}c to photographer ${photographer.id} (transfer ${paid.baseTransferId}) for shoot booking ${bookingId}`);
    } else {
      console.error(`[Settlement] PAYOUT FAILED shoot booking ${bookingId}: queued for retry`);
    }
  }

  // Pending points on the original pre-discount total, released 3 days after the shoot unless it
  // is cancelled. The referral check runs at release, once the booking is final.
  const pointsBase = metadata.originalConsumerTotalCents ? Number(metadata.originalConsumerTotalCents) : paymentIntent.amount;
  const clientId = metadata.clientId || booking.clientId;
  if (clientId) {
    try {
      await storage.createPendingPointTransaction({
        userId: clientId,
        dollarAmountCents: pointsBase,
        transactionType: 'photographer_booking',
        referenceType: 'shoot_booking',
        referenceId: bookingId,
        description: 'Points earned from photographer booking',
        releaseAfter: releaseAfterForBooking(booking.date, booking.endTime ?? booking.startTime),
      });
    } catch (pointsErr) {
      console.error(`[Settlement] pending points for shoot booking ${bookingId} failed:`, pointsErr);
    }
  }

  return { settled: true, transferId };
}
