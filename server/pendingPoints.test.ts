/**
 * Booking step 4: pending points shown on the Booked screen.
 * Run with: DATABASE_URL=... NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/pendingPoints.test.ts
 */
import { appointmentPointsBaseCents, pendingPointsForAppointment, pendingPointsForShoot } from './bookingSettlement';
import { calculateBookingFees, quoteDeposit } from './fees';
import { pointsForGrossCents } from './loyaltyLedger';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('\n=== real examples (500 points = $1, half the service fee) ===');
assert(pendingPointsForAppointment({ totalPrice: 27500, depositAmountCents: 3000 }) === 600, '$275 with $30 deposit → 600 (not the mockup 1,200)');
assert(pendingPointsForAppointment({ totalPrice: 7000, depositAmountCents: null }) === 1400, '$70 paid in full → 1,400');
assert(pendingPointsForAppointment({ totalPrice: 12500, depositAmountCents: null }) === 2500, '$125 → 2,500 (Loyalty Points note example)');
assert(pendingPointsForAppointment({ totalPrice: 5000, depositAmountCents: 0 }) === 0, 'deposit 0 stored → 0, same as settlement (?? keeps 0)');

console.log('\n=== same base settlement saves ===');
for (const a of [{ totalPrice: 27500, depositAmountCents: 3000 }, { totalPrice: 7000, depositAmountCents: null }, { totalPrice: 2550, depositAmountCents: 700 }]) {
  assert(appointmentPointsBaseCents(a) === calculateBookingFees(a.depositAmountCents ?? a.totalPrice).customerTotalBeforeTaxCents,
    `appointment base = settlement base (${a.totalPrice}/${a.depositAmountCents})`);
}
for (const sb of [{ totalPrice: 7000, depositAmountCents: null }, { totalPrice: 20000, depositAmountCents: 5000 }]) {
  assert(pendingPointsForShoot(sb) === pointsForGrossCents(quoteDeposit(sb.totalPrice, sb.depositAmountCents).dueNowCents),
    `shoot points on due now (originalConsumerTotalCents) (${sb.totalPrice}/${sb.depositAmountCents})`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
