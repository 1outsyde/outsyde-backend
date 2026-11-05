/**
 * Pure tests for quotes step 4b-2b (extras). Run with: npx tsx server/quotes/quoteExtras.test.ts
 *
 * Legend 2026-11-05 (B1 to B4, E2 to E7): the vendor (owner or the staff member who sent the quote) sends extras
 * from payment until Job complete; each $1 to $10,000, up to 10 per booking, all together up to the quote total.
 * Only the customer's Approve adds one, and it is held on the card right then (a hold replaces the last one with one
 * for the new total, so there is one charge at Job complete). More than about 6 days before the end, a hold can't
 * last: the card is checked without reserving money and the hold is placed with the balance, 24 hours before. Each
 * extra carries its own service fee and 2% (fees.ts quoteExtraSplit). Unanswered extras lapse at Job complete. An
 * approved extra is final.
 */
import {
  EXTRA_MIN_CENTS, EXTRA_MAX_CENTS, MAX_EXTRAS, checkExtraInput, extrasLimitBlocker, extrasTotals, holdAtApprove,
  extrasHoldTimes, extraCardText, extrasCompleteBlocker,
} from './quoteExtrasRules';
import { quoteExtraSplit } from '../fees';
import { splitReportRefund, resolveOutcome } from './quoteWindowRules';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const H = 3600_000;
const D = 24 * H;

console.log('\n── an extra ──');
assert(EXTRA_MIN_CENTS === 100 && EXTRA_MAX_CENTS === 1_000_000 && MAX_EXTRAS === 10, 'limits: $1 to $10,000, up to 10');
let c = checkExtraInput({ description: '  2 extra hours, $50 each ', amountCents: 10000 });
assert(c.ok && c.value.description === '2 extra hours, $50 each' && c.value.amountCents === 10000, 'trimmed and kept', c);
c = checkExtraInput({ description: 'ab', amountCents: 10000 });
assert(!c.ok && c.field === 'description', 'a description is required (3 characters or more)', c);
c = checkExtraInput({ description: 'x'.repeat(201), amountCents: 10000 });
assert(!c.ok && c.field === 'description', 'up to 200 characters', c);
c = checkExtraInput({ description: 'Stairs', amountCents: 99 });
assert(!c.ok && c.field === 'amountCents', 'at least $1', c);
c = checkExtraInput({ description: 'Stairs', amountCents: 1_000_001 });
assert(!c.ok && c.field === 'amountCents', 'up to $10,000', c);
c = checkExtraInput({ description: 'Stairs', amountCents: 100.5 });
assert(!c.ok && c.field === 'amountCents', 'whole cents', c);
c = checkExtraInput(null);
assert(!c.ok, 'nothing sent is refused', c);

console.log('\n── limits on a booking ──');
const ex = (status: string, amountCents: number) => ({ status, amountCents });
assert(extrasLimitBlocker([], 10000, 65000) === null, 'the first extra');
assert(extrasLimitBlocker(Array.from({ length: 10 }, () => ex('approved', 100)), 100, 65000) === 'TOO_MANY', 'no 11th extra');
assert(extrasLimitBlocker([...Array.from({ length: 9 }, () => ex('declined', 100)), ex('approved', 100)], 100, 65000) === null, 'declined, withdrawn and lapsed ones do not count');
assert(extrasLimitBlocker([ex('approved', 60000)], 5001, 65000) === 'OVER_TOTAL', 'all extras together up to the quote total');
assert(extrasLimitBlocker([ex('approved', 60000)], 5000, 65000) === null, 'exactly the quote total is fine');
assert(extrasLimitBlocker([ex('proposed', 60000)], 5001, 65000) === 'OVER_TOTAL', 'open proposals count toward the total');

console.log('\n── money (each extra with its own fee and 2%) ──');
let t = extrasTotals([10000]);
const one = quoteExtraSplit(10000);
assert(t.approvedCents === 10000 && t.feeCents === one.serviceFeeCents && t.platformFeeCents === one.platformFeeCents && t.vendorNetCents === one.vendorNetCents && t.holdCents === one.holdCents, '$100 extra: $108 held, the vendor gets $98', t);
t = extrasTotals([10000, 2500]);
const two = quoteExtraSplit(2500);
assert(t.approvedCents === 12500 && t.feeCents === one.serviceFeeCents + two.serviceFeeCents && t.holdCents === one.holdCents + two.holdCents && t.vendorNetCents === one.vendorNetCents + two.vendorNetCents, 'two extras: their fees add up, one hold for the total', t);
t = extrasTotals([]);
assert(t.approvedCents === 0 && t.holdCents === 0, 'none: nothing held', t);

console.log('\n── held now, or checked now and held later (E2) ──');
const now = new Date('2026-11-05T15:00:00Z');
assert(holdAtApprove(new Date(now.getTime() + 2 * D), now) === true, 'ends in 2 days: held at Approve');
assert(holdAtApprove(new Date(now.getTime() + 6 * D), now) === true, 'ends in exactly 6 days: still held now');
assert(holdAtApprove(new Date(now.getTime() + 6 * D + H), now) === false, 'ends later: card checked now, held 24 hours before');
const starts = new Date(now.getTime() + 20 * D);
let h = extrasHoldTimes(starts, now);
assert(h.holdAt.getTime() === starts.getTime() - D && h.retryAt?.getTime() === starts.getTime() - 12 * H, 'held 24 hours before, retried 12 hours before (E3, like the balance)', h);
h = extrasHoldTimes(new Date(now.getTime() + 10 * H), now);
assert(h.holdAt.getTime() === now.getTime(), 'less than a day away: held now', h);

console.log('\n── Job complete waits for the extras (E3) ──');
const pay = (status: string, approvedCents = 10000, approveClaimedAt: Date | null = null) => ({ status, approvedCents, approveClaimedAt });
assert(extrasCompleteBlocker(null, now) === null && extrasCompleteBlocker(pay('none', 0), now) === null, 'no extras: nothing to wait for');
assert(extrasCompleteBlocker(pay('held'), now) === null, 'held: Job complete charges it');
assert(extrasCompleteBlocker(pay('scheduled'), now) === 'EXTRAS_NOT_HELD' && extrasCompleteBlocker(pay('hold_failed'), now) === 'EXTRAS_NOT_HELD', 'approved but not held yet: blocked');
assert(extrasCompleteBlocker(pay('holding'), now) === 'EXTRAS_BUSY', 'a hold being placed: wait');
assert(extrasCompleteBlocker(pay('releasing'), now) === 'EXTRAS_BUSY', 'a release under way: wait');
assert(extrasCompleteBlocker(pay('held', 10000, new Date(now.getTime() - 60_000)), now) === 'EXTRAS_BUSY', 'an Approve under way: wait');
assert(extrasCompleteBlocker(pay('held', 10000, new Date(now.getTime() - 11 * 60_000)), now) === null, 'a stale Approve claim does not block forever');

console.log('\n── refunds: the extras first, then the balance, then the deposit (B6) ──');
const L = { extrasLeft: 10000, balanceLeft: 55000, depositLeft: 10000 };
let sp = splitReportRefund(6000, L);
assert(sp.ok && sp.fromExtras === 6000 && sp.fromBalance === 0 && sp.fromDeposit === 0, '$60: all from the extras', sp);
sp = splitReportRefund(70000, L);
assert(sp.ok && sp.fromExtras === 10000 && sp.fromBalance === 55000 && sp.fromDeposit === 5000, '$700: extras, balance, then deposit', sp);
sp = splitReportRefund(75001, L);
assert(!sp.ok, 'never more than the business was paid', sp);
let ro = resolveOutcome('full_refund', undefined, L);
assert(ro.ok && ro.refundCents === 75000, 'full refund covers the extras too', ro);
ro = resolveOutcome('partial_refund', 75000, L);
assert(!ro.ok && ro.code === 'USE_FULL_REFUND', 'everything is a full refund', ro);
ro = resolveOutcome('full_refund', undefined, { balanceLeft: 55000, depositLeft: 10000 });
assert(ro.ok && ro.refundCents === 65000, 'no extras: as before', ro);

console.log('\n── card text (commas and periods, never the fee rate) ──');
const texts = [
  extraCardText('extra_proposed', { businessName: 'Royal Elite Moving', description: '2 extra hours', amountCents: 10000 }),
  extraCardText('extra_approved', { businessName: 'Royal Elite Moving', description: '2 extra hours', amountCents: 10000 }),
  extraCardText('extra_declined', { businessName: 'Royal Elite Moving', description: '2 extra hours', amountCents: 10000 }),
  extraCardText('extra_withdrawn', { businessName: 'Royal Elite Moving', description: '2 extra hours', amountCents: 10000 }),
  extraCardText('extras_failed', { businessName: 'Royal Elite Moving', description: '', amountCents: 10800 }),
  extraCardText('extras_hold_failed', { businessName: 'Royal Elite Moving', description: '', amountCents: 10800 }),
  extraCardText('extras_reminder', { businessName: 'Royal Elite Moving', description: '', amountCents: 10800 }),
];
assert(texts[0] === 'Royal Elite Moving added 2 extra hours, $100.00 plus a service fee. Nothing is charged unless you approve.', 'proposed', texts[0]);
assert(texts[1] === 'Approved: 2 extra hours, $100.00. It is held on the card and charged when the job is complete.', 'approved', texts[1]);
assert(texts[2] === 'Declined: 2 extra hours. Nothing was added.', 'declined', texts[2]);
assert(texts[3] === 'Royal Elite Moving took back 2 extra hours. Nothing was added.', 'withdrawn', texts[3]);
assert(texts[4] === "We couldn't charge your card for the extras, $108.00. Pay for extras to finish your booking.", 'failed (B4 backup)', texts[4]);
assert(texts[5] === "We couldn't hold the extras, $108.00, on your card. Update your card so the job can be marked complete.", 'far out hold failed (E3)', texts[5]);
assert(texts[6] === 'Reminder: the extras, $108.00, are still unpaid. Pay for extras to finish your booking.', 'unpaid reminder (E7)', texts[6]);
for (const s of texts) assert(!/[–—]|8%/.test(s), `no dashes or fee rate: ${s}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
