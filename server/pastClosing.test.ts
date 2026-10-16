/**
 * Past-closing rule (migration 044) — pure tests for fitsOpenHours.
 * Run with: DATABASE_URL=postgresql://x@localhost/x npx tsx server/pastClosing.test.ts
 * (db.ts throws on import without DATABASE_URL; no query is made.)
 */
import { fitsOpenHours, PAST_CLOSING_MAX_END_MINUTES } from './availabilityService';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}
const m = (h: number, min = 0) => h * 60 + min;

// Braids With Love weekday hours, stored as 12-hour text in Neon
const bwl = [{ startTime: '10:30 AM', endTime: '5:00 PM' }];
const split = [{ startTime: '09:00', endTime: '12:00' }, { startTime: '13:00', endTime: '17:00' }];

console.log('\n=== fitsOpenHours: toggle OFF (unchanged behaviour) ===');
assert(fitsOpenHours(bwl, m(10, 30), m(16, 30), false), '6h service at opening fits');
assert(!fitsOpenHours(bwl, m(10, 30), m(17, 10), false), '400 min at opening does NOT fit (today)');
assert(fitsOpenHours(bwl, m(16), m(17), false), 'ends exactly at closing fits');
assert(!fitsOpenHours(bwl, m(10), m(11), false), 'starts before opening rejected');
assert(!fitsOpenHours(split, m(11), m(14), false), 'split: cannot span the break');
assert(fitsOpenHours(bwl, m(12), m(12), false), 'zero-length inside window still fits (as before)');

console.log('\n=== fitsOpenHours: toggle ON ===');
assert(fitsOpenHours(bwl, m(10, 30), m(17, 10), true), '400 min at 10:30 fits (ends 5:10 PM)');
assert(fitsOpenHours(bwl, m(16, 45), m(23, 25), true), 'starts 4:45 PM, ends 11:25 PM fits');
assert(!fitsOpenHours(bwl, m(17), m(18), true), 'starting AT closing rejected');
assert(!fitsOpenHours(bwl, m(10), m(17), true), 'starting before opening still rejected');
assert(fitsOpenHours(bwl, m(17), m(23, 59), false) === false, 'sanity: off rejects after-hours');
assert(fitsOpenHours(bwl, m(16, 59), PAST_CLOSING_MAX_END_MINUTES, true), 'ends exactly 23:59 fits');
assert(!fitsOpenHours(bwl, m(16), m(24), true), 'ending at/after midnight rejected');
assert(!fitsOpenHours(bwl, m(16, 30), m(25, 10), true), 'crossing midnight rejected');
assert(!fitsOpenHours(split, m(11), m(14), true), 'split: morning window never runs into the break');
assert(fitsOpenHours(split, m(16), m(19), true), 'split: last window may run past closing');
assert(!fitsOpenHours([], m(10), m(11), true), 'no windows = closed even when on');
assert(!fitsOpenHours([{ startTime: 'bad', endTime: 'x' }], m(10), m(11), true), 'unparseable windows = closed');

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
