/**
 * Outsyde Platform Fee Configuration
 *
 * Product fee:  4% on product purchases (orders, a la carte product purchases)
 * Booking fee: 12% on service bookings (appointments, photographer shoots, a la carte services)
 *
 * Fees are collected via Stripe's `application_fee_amount` on destination charges.
 */

export const PRODUCT_FEE_PERCENT = 4;
export const PRODUCT_FEE_RATE = 0.04;

export const BOOKING_FEE_PERCENT = 12;
export const BOOKING_FEE_RATE = 0.12;

/**
 * Calculate the platform fee for a product purchase.
 */
export function calculateProductFee(amountCents: number): number {
  return Math.round(amountCents * PRODUCT_FEE_RATE);
}

/**
 * Calculate the platform fee for a service booking.
 */
export function calculateBookingFee(amountCents: number): number {
  return Math.round(amountCents * BOOKING_FEE_RATE);
}
