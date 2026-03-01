/**
 * Outsyde Platform Fee Configuration
 *
 * Universal 12% booking/transaction fee applied to all marketplace transactions.
 * This fee is collected via Stripe's `application_fee_amount` on destination charges.
 */

export const PLATFORM_FEE_PERCENT = 12;
export const PLATFORM_FEE_RATE = 0.12;

/**
 * Calculate the platform fee in cents for a given transaction amount.
 */
export function calculatePlatformFee(amountCents: number): number {
  return Math.round(amountCents * PLATFORM_FEE_RATE);
}
