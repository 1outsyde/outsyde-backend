/**
 * Outsyde Platform Fee Configuration
 *
 * Product fee:  8% on product purchases (orders, a la carte product purchases)
 * Booking fee: 10% on service bookings (appointments, photographer shoots, a la carte services)
 *
 * Fees are collected via Stripe's `application_fee_amount` on destination charges.
 */

export const PRODUCT_FEE_PERCENT = 8;
export const PRODUCT_FEE_RATE = 0.08;

export const BOOKING_FEE_PERCENT = 10;
export const BOOKING_FEE_RATE = 0.10;

/**
 * Calculate the platform fee for a product purchase.
 */
export function calculateProductFee(amountCents: number): number {
  const fee = Math.round(amountCents * PRODUCT_FEE_RATE);
  console.log(`[Fee] Product transaction: amount=${amountCents}¢, fee=${fee}¢ (${PRODUCT_FEE_PERCENT}%)`);
  return fee;
}

/**
 * Calculate the platform fee for a service booking.
 */
export function calculateBookingFee(amountCents: number): number {
  const fee = Math.round(amountCents * BOOKING_FEE_RATE);
  console.log(`[Fee] Booking transaction: amount=${amountCents}¢, fee=${fee}¢ (${BOOKING_FEE_PERCENT}%)`);
  return fee;
}
