import { db } from "./db";
import { appointments, BOOKING_STATES } from "@shared/schema";
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
