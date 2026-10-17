/**
 * One revenue rule for every money figure (Part A, 2026-10-17).
 *
 * Revenue = money captured through Outsyde for the service, gross (before Outsyde's cut and
 * Stripe fees), never the customer service fee.
 *
 * Bookings (appointments + shoot_bookings):
 *   - count when status is confirmed, completed or no_show, or canceled AFTER payment was
 *     captured (settled_at set). A cancel that only released an authorization never counts.
 *   - pending_payment, pending_provider, draft, expired, declined and anything else never count.
 *   - amount = deposit if the booking took one, otherwise the price charged, minus any refund.
 *   - money lands on the appointment date.
 * Orders: paid, shipped or delivered; amount = total_amount (subtotal); lands on the paid date
 *   (orders created before migration 048 have no paid_at and fall back to created_at).
 * In-person balance: full price (incl. add-ons) minus what Outsyde charged. Confirmed bookings
 *   = "due at appointment", completed bookings = "collected in person (est.)".
 * Cancellation fees go to Outsyde's platform account (stripeService.chargeSavedPaymentMethod has
 *   no transfer), so they are NOT business revenue; only Outsyde's admin revenue counts them.
 */
import { sql } from "drizzle-orm";

export const BOOKED_STATUSES = ["confirmed", "completed", "no_show"] as const;
export const PAID_ORDER_STATUSES = ["paid", "shipped", "delivered"] as const;

// ─── SQL fragments (column names are the same on appointments and shoot_bookings) ───

/** A real booking (for counts): never pending, expired, declined or canceled. */
export const bookedStatusSql = sql.raw(`status IN ('confirmed','completed','no_show')`);

/** Rows whose captured money counts as revenue. */
export const bookingRevenueWhereSql = sql.raw(
  `(status IN ('confirmed','completed','no_show') OR (status = 'canceled' AND settled_at IS NOT NULL))`,
);

/** Captured amount for the service, net of refunds, never below 0. A deposit of 0 means "no deposit". */
export const bookingRevenueAmountSql = sql.raw(
  `GREATEST(COALESCE(NULLIF(deposit_amount_cents, 0), total_price, 0) - COALESCE(refund_amount, 0), 0)`,
);

/** Balance the customer pays the business in person. */
export const bookingInPersonAmountSql = sql.raw(
  `GREATEST(COALESCE(total_price, 0) - COALESCE(NULLIF(deposit_amount_cents, 0), total_price, 0), 0)`,
);

export const paidOrderWhereSql = sql.raw(`status IN ('paid','shipped','delivered')`);

/** Date an order's money lands on. */
export const orderRevenueDateSql = sql.raw(`COALESCE(paid_at, created_at)`);

// ─── Same rule in JS, for routes that already load rows ───

export interface RevenueBooking {
  status?: string | null;
  totalPrice?: number | null;
  depositAmountCents?: number | null;
  refundAmount?: number | null;
  settledAt?: Date | string | null;
}

export interface RevenueOrder {
  status?: string | null;
  totalAmount?: number | null;
  paidAt?: Date | string | null;
  createdAt?: Date | string | null;
}

export function isBooked(b: RevenueBooking): boolean {
  return (BOOKED_STATUSES as readonly string[]).includes(b.status ?? "");
}

export function bookingCountsAsRevenue(b: RevenueBooking): boolean {
  if (isBooked(b)) return true;
  return b.status === "canceled" && b.settledAt != null;
}

function chargedCents(b: RevenueBooking): number {
  const deposit = b.depositAmountCents ?? 0;
  return deposit > 0 ? deposit : (b.totalPrice ?? 0);
}

/** Revenue cents for one booking (0 when it does not count). */
export function bookingRevenueCents(b: RevenueBooking): number {
  if (!bookingCountsAsRevenue(b)) return 0;
  return Math.max(chargedCents(b) - (b.refundAmount ?? 0), 0);
}

/** In-person balance for one booking; only confirmed and completed bookings have one. */
export function bookingInPersonCents(b: RevenueBooking): number {
  if (b.status !== "confirmed" && b.status !== "completed") return 0;
  return Math.max((b.totalPrice ?? 0) - chargedCents(b), 0);
}

export function isPaidOrder(o: RevenueOrder): boolean {
  return (PAID_ORDER_STATUSES as readonly string[]).includes(o.status ?? "");
}

export function orderRevenueDate(o: RevenueOrder): Date | null {
  for (const v of [o.paidAt, o.createdAt]) {
    if (!v) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** "YYYY-MM" of a booking's appointment date string ("YYYY-MM-DD"). */
export function monthOf(dateStr: string | null | undefined): string {
  return (dateStr ?? "").slice(0, 7);
}

/** "YYYY-MM" for a Date in UTC (matches NOW() on the server). */
export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}
