/**
 * Gap after every booking (migration 104): pure overlap rule.
 * Run with: DATABASE_URL=... NODE_OPTIONS="--import ./.dev/neon-preload.mjs" npx tsx server/bookingGap.test.ts
 * (availabilityService imports db; no query runs in these tests.)
 *
 * Mutation check: drop `+ gap` from either side of doTimesOverlap → "11:00 clashes with a
 * booking ending 11:00 when gap 15" or "new booking must end 15 before the next" fails.
 */
import { doTimesOverlap, isValidBookingGap, BOOKING_GAP_CHOICES, DEFAULT_BOOKING_GAP_MINUTES } from './availabilityService';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('\n=== Gap 0 is the old plain overlap ===');
assert(doTimesOverlap('10:00', '11:00', '11:00', '12:00') === false, 'back to back allowed with no gap');
assert(doTimesOverlap('10:30', '11:30', '11:00', '12:00') === true, 'real overlap still clashes');
assert(doTimesOverlap('10:00', '11:00', '11:00', '12:00', 0) === false, 'explicit 0 = no gap');

console.log('\n=== Gap 15 after each booking ===');
// existing booking 10:00 to 11:00
assert(doTimesOverlap('11:00', '12:00', '10:00', '11:00', 15) === true, '11:00 clashes with a booking ending 11:00 when gap 15');
assert(doTimesOverlap('11:15', '12:15', '10:00', '11:00', 15) === false, '11:15 is free (booking ends 11:00 + 15)');
assert(doTimesOverlap('09:00', '10:00', '10:00', '11:00', 15) === true, 'new booking must end 15 before the next one starts');
assert(doTimesOverlap('08:45', '09:45', '10:00', '11:00', 15) === false, 'ending 9:45 leaves 15 before a 10:00 booking');
assert(doTimesOverlap('11:10', '11:40', '10:00', '11:00', 15) === true, '11:10 still inside the gap');

console.log('\n=== Other gap lengths ===');
assert(doTimesOverlap('11:15', '12:15', '10:00', '11:00', 30) === true, 'gap 30: 11:15 clashes');
assert(doTimesOverlap('11:30', '12:30', '10:00', '11:00', 30) === false, 'gap 30: 11:30 free');
assert(doTimesOverlap('12:00', '13:00', '10:00', '11:00', 60) === false, 'gap 60: 12:00 free');
assert(doTimesOverlap('11:00', '12:00', '10:00', '11:00', -5) === false, 'negative gap treated as 0');
assert(doTimesOverlap('11:00', '12:00', '10:00', '11:00', NaN) === false, 'NaN gap treated as 0');

console.log('\n=== 12-hour stored times (weekly hours format) ===');
assert(doTimesOverlap('11:00', '12:00', '10:00 AM', '11:00 AM', 15) === true, '12-hour booking times use the gap too');

console.log('\n=== Allowed values ===');
assert(DEFAULT_BOOKING_GAP_MINUTES === 15, 'default is 15');
assert(BOOKING_GAP_CHOICES.join(',') === '0,5,10,15,20,30,45,60', 'choices 0, 5, 10, 15, 20, 30, 45, 60');
for (const v of [0, 5, 10, 15, 20, 30, 45, 60]) assert(isValidBookingGap(v), `${v} accepted`);
for (const v of [7, 90, -15, '15', null, undefined, 15.5]) assert(!isValidBookingGap(v as any), `${JSON.stringify(v)} refused`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
