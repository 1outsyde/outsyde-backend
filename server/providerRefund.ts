/**
 * Provider-initiated refunds (business owner or photographer), 2026-10-21.
 *
 * Shared by POST /api/bookings/appointments/:id/refund and
 * POST /api/bookings/photographer/:id/refund.
 *
 * Amount rules:
 *  - `amountCents` (integer cents) is the amount to refund. Sent by app builds from Oct 21 2026 on.
 *  - `amount` is the legacy field. Its only caller, the app's RefundModal, has always sent DOLLARS
 *    (parseFloat of what the provider typed), while these routes read it as cents, so a $25 refund
 *    went out as $0.25. It is now read as dollars, which fixes installed app builds too.
 *  - Neither field = full refund: what was charged before the consumer service fee, i.e. the
 *    deposit on deposit bookings, otherwise the service price. The 8% fee is kept.
 *  - A refund is never more than that full amount (the fee is never refunded here).
 *    stripeService.createBookingRefund additionally caps at what the card was charged.
 */

export interface RefundableBooking {
  totalPrice: number | null;
  depositAmountCents?: number | null;
}

export type ProviderRefundResolution =
  | { ok: true; refundCents: number; fullRefundCents: number; isFullRefund: boolean }
  | { ok: false; code: 'INVALID_REFUND_AMOUNT' | 'REFUND_TOO_LARGE'; error: string; maxRefundCents: number };

/** What a full provider refund returns: the deposit on deposit bookings, otherwise the service price. */
export function fullProviderRefundCents(booking: RefundableBooking): number {
  const deposit = booking.depositAmountCents;
  if (typeof deposit === 'number' && deposit > 0) return deposit;
  return booking.totalPrice ?? 0;
}

export function resolveProviderRefund(
  body: { amountCents?: unknown; amount?: unknown } | undefined,
  booking: RefundableBooking,
): ProviderRefundResolution {
  const fullRefundCents = fullProviderRefundCents(booking);
  const amountCents = body?.amountCents;
  const legacyDollars = body?.amount;

  let refundCents: number;
  if (amountCents !== undefined && amountCents !== null) {
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
      return { ok: false, code: 'INVALID_REFUND_AMOUNT', error: 'Refund amount must be a whole number of cents above zero.', maxRefundCents: fullRefundCents };
    }
    refundCents = amountCents;
  } else if (legacyDollars !== undefined && legacyDollars !== null) {
    if (typeof legacyDollars !== 'number' || !Number.isFinite(legacyDollars) || legacyDollars <= 0) {
      return { ok: false, code: 'INVALID_REFUND_AMOUNT', error: 'Refund amount must be above zero.', maxRefundCents: fullRefundCents };
    }
    refundCents = Math.round(legacyDollars * 100);
  } else {
    refundCents = fullRefundCents;
  }

  if (refundCents <= 0 || refundCents > fullRefundCents) {
    return {
      ok: false,
      code: 'REFUND_TOO_LARGE',
      error: `The most you can refund is $${(fullRefundCents / 100).toFixed(2)}.`,
      maxRefundCents: fullRefundCents,
    };
  }

  return { ok: true, refundCents, fullRefundCents, isFullRefund: refundCents >= fullRefundCents };
}
