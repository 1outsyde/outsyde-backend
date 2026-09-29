// Deposit rule for vendor, staff and photographer services: no deposit (null),
// or at least $7.00 and less than the service price. 0 means no deposit and is
// stored as null.
export const MIN_DEPOSIT_CENTS = 700;

export function validateDeposit(
  depositCents: number | null | undefined,
  priceCents: number,
): { ok: true; value: number | null | undefined } | { ok: false; message: string } {
  if (depositCents === undefined) return { ok: true, value: undefined };
  if (depositCents === null || depositCents === 0) return { ok: true, value: null };
  if (depositCents < MIN_DEPOSIT_CENTS) return { ok: false, message: "Deposit must be at least $7.00." };
  if (depositCents >= priceCents) return { ok: false, message: "Deposit must be less than the service price." };
  return { ok: true, value: depositCents };
}

export const invalidDepositBody = (message: string, extra: Record<string, unknown> = {}) =>
  ({ error: message, message, code: "INVALID_DEPOSIT", ...extra });

/**
 * Photographer services: same rule as validateDeposit, against price_cents.
 * A service without a fixed price_cents (hourly, contact for pricing) cannot
 * carry a deposit.
 */
export function validatePhotographerDeposit(
  depositCents: number | null | undefined,
  priceCents: number | null | undefined,
): ReturnType<typeof validateDeposit> {
  if (depositCents && typeof priceCents !== "number") {
    return { ok: false, message: "Deposits require a fixed price." };
  }
  return validateDeposit(depositCents, priceCents ?? 0);
}

/**
 * The deposit a photographer booking charges: the service's stored deposit
 * when the service has a fixed price and 700 <= D < servicePriceCents,
 * otherwise null (full price). The hold and the hold PaymentIntent both use
 * this so the hold's dueNowCents equals the PaymentIntent amount.
 */
export function photographerBookingDepositCents(
  service: { priceCents?: number | null; depositAmountCents?: number | null } | null | undefined,
  servicePriceCents: number,
): number | null {
  const deposit = service?.depositAmountCents;
  if (typeof deposit !== "number" || typeof service?.priceCents !== "number") return null;
  return deposit >= MIN_DEPOSIT_CENTS && deposit < servicePriceCents ? deposit : null;
}
