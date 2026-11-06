// R40 (Legend 2026-11-06): when a business turns off "show address", its street
// address is shared only with customers who have a real booking.
import { BOOKING_STATES } from "@shared/schema";

/** Booking statuses that unlock a hidden business address: paid and accepted, done, or no show. */
export const ADDRESS_VISIBLE_STATUSES: readonly string[] = [
  BOOKING_STATES.CONFIRMED,
  BOOKING_STATES.COMPLETED,
  BOOKING_STATES.NO_SHOW,
];

/** The business street address a customer may see on one of their bookings. */
export function businessAddressForCustomer(
  address: string | null | undefined,
  showAddress: boolean | null | undefined,
  status: string | null | undefined,
): string | null {
  if (!address) return null;
  if (showAddress !== false) return address;
  return status && ADDRESS_VISIBLE_STATUSES.includes(status) ? address : null;
}
