/**
 * Revenue rule (server/revenue.ts) — pure unit tests, no database.
 * Run with: npx tsx server/revenue.test.ts
 */
import {
  bookingCountsAsRevenue, bookingRevenueCents, bookingInPersonCents, isBooked, isPaidOrder, orderRevenueDate,
} from "./revenue";

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  if (actual === expected) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const settled = new Date("2026-10-01T12:00:00Z");

console.log("Statuses that never count");
for (const status of ["pending_payment", "pending_provider", "draft", "expired", "declined", "awaiting_payment", "refunded"]) {
  eq(bookingRevenueCents({ status, totalPrice: 21000 }), 0, `${status} → $0`);
  eq(bookingInPersonCents({ status, totalPrice: 21000, depositAmountCents: 3000 }), 0, `${status} → no in-person balance`);
}
eq(isBooked({ status: "pending_payment" }), false, "pending_payment is not a booking for counts");

console.log("Abandoned checkout #A0033 shape");
eq(bookingRevenueCents({ status: "pending_payment", totalPrice: 21000, depositAmountCents: null }), 0, "$210 pending → $0");

console.log("Deposit bookings count the deposit only");
eq(bookingRevenueCents({ status: "confirmed", totalPrice: 20000, depositAmountCents: 3000 }), 3000, "confirmed $200 with $30 deposit → $30");
eq(bookingInPersonCents({ status: "confirmed", totalPrice: 20000, depositAmountCents: 3000 }), 17000, "due at appointment $170");
eq(bookingInPersonCents({ status: "completed", totalPrice: 20000, depositAmountCents: 3000 }), 17000, "collected in person $170");
eq(bookingRevenueCents({ status: "completed", totalPrice: 20000, depositAmountCents: 3000 }), 3000, "completed → $30");

console.log("No-deposit bookings count the price charged");
eq(bookingRevenueCents({ status: "confirmed", totalPrice: 21000, depositAmountCents: null }), 21000, "$210 charged in full → $210");
eq(bookingInPersonCents({ status: "confirmed", totalPrice: 21000, depositAmountCents: null }), 0, "nothing due in person");
eq(bookingRevenueCents({ status: "confirmed", totalPrice: 21000, depositAmountCents: 0 }), 21000, "deposit 0 means no deposit");

console.log("No-show keeps the deposit");
eq(bookingRevenueCents({ status: "no_show", totalPrice: 20000, depositAmountCents: 3000 }), 3000, "no_show → $30");
eq(bookingInPersonCents({ status: "no_show", totalPrice: 20000, depositAmountCents: 3000 }), 0, "no_show → nothing collected in person");

console.log("Cancels");
eq(bookingRevenueCents({ status: "canceled", totalPrice: 20000, depositAmountCents: 3000, settledAt: settled }), 3000, "customer cancel after capture keeps $30 deposit");
eq(bookingRevenueCents({ status: "canceled", totalPrice: 20000, depositAmountCents: 3000, settledAt: null }), 0, "cancel that only released an authorization → $0");
eq(bookingRevenueCents({ status: "canceled", totalPrice: 10000, settledAt: settled, refundAmount: 5000 }), 5000, "partial refund keeps the rest");
eq(bookingRevenueCents({ status: "canceled", totalPrice: 10000, settledAt: settled, refundAmount: 10000 }), 0, "full refund → $0");
eq(bookingRevenueCents({ status: "canceled", totalPrice: 10000, settledAt: settled, refundAmount: 12000 }), 0, "never negative");
eq(bookingCountsAsRevenue({ status: "canceled", settledAt: settled }), true, "captured cancel is counted");

console.log("Refund on a confirmed booking (admin-approved refund)");
eq(bookingRevenueCents({ status: "confirmed", totalPrice: 20000, depositAmountCents: 3000, refundAmount: 3000 }), 0, "refunded deposit drops out");

console.log("Orders");
for (const status of ["paid", "shipped", "delivered"]) eq(isPaidOrder({ status }), true, `${status} order counts`);
for (const status of ["pending", "cancelled", "refunded"]) eq(isPaidOrder({ status }), false, `${status} order does not count`);
eq(orderRevenueDate({ paidAt: "2026-10-05T00:00:00Z", createdAt: "2026-09-30T00:00:00Z" })?.toISOString().slice(0, 10), "2026-10-05", "order lands on paid date");
eq(orderRevenueDate({ paidAt: null, createdAt: "2026-09-30T00:00:00Z" })?.toISOString().slice(0, 10), "2026-09-30", "old order falls back to created date");

eq(orderRevenueDate({ paidAt: null, createdAt: "garbage" }), null, "unreadable dates never throw");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
