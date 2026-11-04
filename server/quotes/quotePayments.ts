/**
 * Paying a quote (Quotes in Messages, step 3). Pure rules: no database, no network.
 *
 * Legend 2026-11-04 (all 12 recommended):
 *   1. A quote can only be paid when the business can take money: approved, payouts finished (not just a Stripe
 *      account id, R38), an active plan and the Vendor Agreement accepted; a staff quote also needs the staff
 *      member's payouts. The live booking and cart routes get the same check in their own R38 PR.
 *   2. Customer cancels a full price quote: the price minus the vendor's cancellation fee comes back, the service
 *      fee is kept, no second charge.
 *   3. The vendor keeps a quote's cancellation fee (paid like a booking share).
 *   4. The quote's service policy, else the business policy, saved on the booking at payment.
 *   5. At payment only an overlap with another booking or hold refuses it (not business hours or time off).
 *   6. Jobs longer than a day block the extra days.
 *   Deposit quotes: the deposit is never refunded and the vendor's fee is charged on top. Refund windows are
 *   ignored for quotes.
 */

export type QuoteGateCode =
  | "NOT_APPROVED" | "PAYOUTS_NOT_READY" | "PLAN_NOT_ACTIVE" | "AGREEMENT_NOT_ACCEPTED"
  | "STAFF_NOT_ACTIVE" | "STAFF_PAYOUTS_NOT_READY";

const CANT_PAY = "This business can't take payments yet. Message them to finish setting up, then try again.";

/** Can this business (and the staff member who sent the quote) take a quote payment right now? */
export function canTakeQuotePayments(
  business: { approvalStatus: string | null; stripeAccountId: string | null; stripeOnboardingComplete: boolean | null; vendorAgreementAccepted: boolean | null },
  planActive: boolean,
  staff: { status: string | null; stripeAccountId: string | null; stripeOnboardingComplete: boolean | null } | null,
): { ok: true } | { ok: false; code: QuoteGateCode; message: string } {
  if (business.approvalStatus !== "approved") return { ok: false, code: "NOT_APPROVED", message: CANT_PAY };
  if (!business.stripeAccountId || business.stripeOnboardingComplete !== true) return { ok: false, code: "PAYOUTS_NOT_READY", message: CANT_PAY };
  if (!planActive) return { ok: false, code: "PLAN_NOT_ACTIVE", message: CANT_PAY };
  if (business.vendorAgreementAccepted !== true) return { ok: false, code: "AGREEMENT_NOT_ACCEPTED", message: CANT_PAY };
  if (staff) {
    if (staff.status !== "active") return { ok: false, code: "STAFF_NOT_ACTIVE", message: "The person who sent this quote no longer works there. Ask the business for a new quote." };
    if (!staff.stripeAccountId || staff.stripeOnboardingComplete !== true) return { ok: false, code: "STAFF_PAYOUTS_NOT_READY", message: CANT_PAY };
  }
  return { ok: true };
}

type Policy = {
  fullRefundWindow?: string | null; hasPartialRefund?: boolean | null; partialRefundWindow?: string | null;
  partialRefundPercentage?: number | null; hasCancellationFee?: boolean | null; cancellationFeeType?: string | null;
  cancellationFeeAmount?: number | null;
};

/** The cancellation policy saved on a quote booking at payment: the quote's service, else the business (call 4). */
export function cancellationPolicyFor(service: Policy | null | undefined, business: Policy | null | undefined) {
  const p = service ?? business ?? null;
  return {
    serviceFullRefundWindow: p?.fullRefundWindow ?? null,
    serviceHasPartialRefund: p?.hasPartialRefund ?? null,
    servicePartialRefundWindow: p?.partialRefundWindow ?? null,
    servicePartialRefundPercentage: p?.partialRefundPercentage ?? null,
    serviceHasCancellationFee: p?.hasCancellationFee ?? null,
    serviceCancellationFeeType: p?.cancellationFeeType ?? null,
    serviceCancellationFeeAmount: p?.cancellationFeeAmount ?? null,
  };
}

/**
 * What happens when the customer cancels a paid quote booking. Reads only the policy saved on the booking.
 *   refundAmountCents  what goes back to the card (the service fee is never refunded)
 *   chargeFeeCents     what is charged on top to the saved card (deposit quotes only)
 *   feeCents           the vendor's fee, charged on top or kept from the refund
 */
export function quoteCancelOutcome(appt: {
  totalPrice: number; depositAmountCents: number | null;
  serviceHasCancellationFee: boolean | null; serviceCancellationFeeType: string | null; serviceCancellationFeeAmount: number | null;
}): { refundTier: "full" | "partial" | "none"; refundAmountCents: number; chargeFeeCents: number; feeCents: number } {
  const total = Math.max(0, appt.totalPrice);
  let fee = 0;
  if (appt.serviceHasCancellationFee === true && typeof appt.serviceCancellationFeeAmount === "number" && appt.serviceCancellationFeeAmount > 0) {
    fee = appt.serviceCancellationFeeType === "percentage"
      ? Math.round(total * (appt.serviceCancellationFeeAmount / 100))
      : appt.serviceCancellationFeeType === "flat" ? appt.serviceCancellationFeeAmount : 0;
  }
  const deposit = appt.depositAmountCents ?? 0;
  if (deposit > 0) {
    // Deposit kept; the fee on top is never more than the balance the customer would still have owed.
    const charge = Math.min(fee, Math.max(0, total - deposit));
    return { refundTier: "none", refundAmountCents: 0, chargeFeeCents: charge, feeCents: charge };
  }
  const kept = Math.min(fee, total);
  const refund = total - kept;
  return { refundTier: kept === 0 ? "full" : refund > 0 ? "partial" : "none", refundAmountCents: refund, chargeFeeCents: 0, feeCents: kept };
}

const pad = (n: number) => String(n).padStart(2, "0");
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * The job as one slice per calendar day, in the business's wall clock. The first slice is the booking; the
 * others become time off blocks (call 6). A slice that runs to midnight ends at 23:59, the way the booking
 * tables store a time of day.
 */
export function jobDaySegments(jobDate: string, startTime: string, durationMinutes: number): { date: string; startTime: string; endTime: string }[] {
  const [h, m] = startTime.split(":").map(Number);
  let start = h * 60 + m;
  let left = durationMinutes;
  let day = 0;
  const out: { date: string; startTime: string; endTime: string }[] = [];
  while (left > 0) {
    const end = Math.min(start + left, 24 * 60);
    out.push({ date: addDays(jobDate, day), startTime: `${pad(Math.floor(start / 60))}:${pad(start % 60)}`, endTime: end === 24 * 60 ? "23:59" : `${pad(Math.floor(end / 60))}:${pad(end % 60)}` });
    left -= end - start;
    start = 0;
    day++;
  }
  return out;
}
