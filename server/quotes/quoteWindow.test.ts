/**
 * Pure tests for quotes step 4b-1 (Confirm or Report window, review outcomes, balance payout, points).
 * Run with: DATABASE_URL=postgresql://x:y@localhost:5432/z npx tsx server/quotes/quoteWindow.test.ts
 * (the points rule lives in loyaltyLedger.ts, which imports db.ts; nothing connects).
 *
 * Legend 2026-11-05 (calls B5 to B14): the customer has 6 hours after Job complete to Confirm (vendor paid at once)
 * or Report a problem (payout paused, Outsyde reviews). No answer: paid when the 6 hours end. A report covers
 * everything still held, reason 10 to 1,000 characters, up to 5 photos, one per booking. Outcomes: pay in full,
 * partial refund (an amount), full refund (every dollar paid, service fees included). Refunds come from the balance
 * first, then the deposit. Decided reports are final. Points follow the money and wait for Confirm or the window.
 */
import {
  WINDOW_HOURS, windowEndsAt, windowState, confirmBlocker, reportBlocker, checkReport, vendorPartOfRefund,
  balancePayoutCents, payoutEligible, splitReportRefund, resolveOutcome, pointsTarget, pointsToReverse, legacyDecision,
  REPORT_REMINDER_HOURS,
} from './quoteWindowRules';
import { pointsForGrossCents } from '../loyaltyLedger';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const H = 3600_000;
const t0 = new Date('2026-11-13T19:00:00Z');
const base = { completedAt: t0, windowEndsAt: new Date(t0.getTime() + 6 * H), confirmedAt: null as Date | null, reportedAt: null as Date | null, payoutStatus: 'held' };

console.log('\n── the 6 hour window ──');
assert(WINDOW_HOURS === 6, 'the window is 6 hours');
assert(windowEndsAt(t0).getTime() === t0.getTime() + 6 * H, 'it ends 6 hours after Job complete');
assert(REPORT_REMINDER_HOURS === 48, 'an open report reminds Outsyde after 48 hours');
assert(windowState({ ...base, completedAt: null, windowEndsAt: null }, t0) === 'not_complete', 'before Job complete there is no window');
assert(windowState(base, new Date(t0.getTime() + H)) === 'open', 'open inside the 6 hours');
assert(windowState(base, new Date(t0.getTime() + 6 * H)) === 'closed', 'closed at exactly 6 hours');
assert(windowState({ ...base, confirmedAt: new Date(t0.getTime() + H) }, new Date(t0.getTime() + 2 * H)) === 'confirmed', 'confirmed');
assert(windowState({ ...base, reportedAt: new Date(t0.getTime() + H) }, new Date(t0.getTime() + 9 * H)) === 'reported', 'a report stays reported after the window');

console.log('\n── Confirm ──');
assert(confirmBlocker(base, new Date(t0.getTime() + H)) === null, 'the customer can confirm inside the window');
assert(confirmBlocker({ ...base, completedAt: null, windowEndsAt: null }, t0) === 'NOT_COMPLETE', 'not before Job complete');
assert(confirmBlocker({ ...base, confirmedAt: t0 }, new Date(t0.getTime() + H)) === 'ALREADY_CONFIRMED', 'not twice');
assert(confirmBlocker({ ...base, reportedAt: t0 }, new Date(t0.getTime() + H)) === 'REPORTED', 'not after a report');
assert(confirmBlocker(base, new Date(t0.getTime() + 7 * H)) === 'WINDOW_OVER', 'not after the window (already paid on its own)');

console.log('\n── Report a problem ──');
assert(reportBlocker(base, new Date(t0.getTime() + H)) === null, 'the customer can report inside the window');
assert(reportBlocker({ ...base, payoutStatus: 'none' }, new Date(t0.getTime() + H)) === null, 'a quote paid in full can be reported too (B11: nothing held)');
assert(reportBlocker({ ...base, completedAt: null, windowEndsAt: null }, t0) === 'NOT_COMPLETE', 'not before Job complete');
assert(reportBlocker({ ...base, confirmedAt: t0 }, new Date(t0.getTime() + H)) === 'ALREADY_CONFIRMED', 'not after Confirm');
assert(reportBlocker({ ...base, reportedAt: t0 }, new Date(t0.getTime() + H)) === 'ALREADY_REPORTED', 'one report per booking');
assert(reportBlocker(base, new Date(t0.getTime() + 6 * H)) === 'WINDOW_OVER', 'not once the 6 hours are over');
assert(reportBlocker({ ...base, payoutStatus: 'paid' }, new Date(t0.getTime() + H)) === 'ALREADY_PAID', 'not once the vendor was paid');

const R2 = 'https://cdn.example/bucket';
let c = checkReport('Too short', [], R2);
assert(!c.ok && c.code === 'REASON_TOO_SHORT', 'a reason under 10 characters is refused', c);
c = checkReport('   The crew left early   ', [], R2);
assert(c.ok && c.reason === 'The crew left early' && c.photos.length === 0, 'reason trimmed, photos optional', c);
c = checkReport('x'.repeat(1001), [], R2);
assert(!c.ok && c.code === 'REASON_TOO_LONG', 'over 1,000 characters is refused', c);
c = checkReport('The crew broke a lamp', [`${R2}/a.jpg`, `${R2}/b.jpg`, `${R2}/c.jpg`, `${R2}/d.jpg`, `${R2}/e.jpg`, `${R2}/f.jpg`], R2);
assert(!c.ok && c.code === 'TOO_MANY_PHOTOS', 'at most 5 photos', c);
c = checkReport('The crew broke a lamp', ['https://evil.example/a.jpg'], R2);
assert(!c.ok && c.code === 'BAD_PHOTO', 'photos must be our uploads', c);
c = checkReport('The crew broke a lamp', [`${R2}/a.jpg`, `${R2}/a.jpg`], R2);
assert(c.ok && c.photos.length === 1, 'duplicate photos kept once', c);
c = checkReport('The crew broke a lamp', [`${R2}/a.jpg`], undefined);
assert(!c.ok && c.code === 'BAD_PHOTO', 'no upload address configured: photos refused', c);
c = checkReport(42 as any, [], R2);
assert(!c.ok && c.code === 'REASON_TOO_SHORT', 'a reason that is not text is refused', c);

console.log('\n── the vendor balance payout ──');
// $650 job, $100 deposit: balance $550, vendor share $539.
const job = { vendorNetCents: 53900, balanceCents: 55000, capturedCents: 59400, refundedCents: 0 };
assert(balancePayoutCents(job) === 53900, 'nothing refunded: the whole share');
assert(vendorPartOfRefund({ ...job, refundedCents: 27500 }) === 26950, 'half the balance refunded: half the share comes off');
assert(balancePayoutCents({ ...job, refundedCents: 27500 }) === 26950, 'and the rest is paid');
assert(balancePayoutCents({ ...job, refundedCents: 59400 }) === 0, 'balance and fee refunded: nothing to pay');
assert(balancePayoutCents({ ...job, refundedCents: 70000 }) === 0, 'never negative');
assert(balancePayoutCents({ ...job, capturedCents: 0 }) === 0, 'nothing captured: nothing to pay');

const now = new Date(t0.getTime() + 7 * H);
assert(payoutEligible(base, null, now), 'window over with no report: pay');
assert(!payoutEligible(base, null, new Date(t0.getTime() + H)), 'inside the window: wait');
assert(payoutEligible({ ...base, confirmedAt: new Date(t0.getTime() + H) }, null, new Date(t0.getTime() + H)), 'confirmed: pay at once');
assert(!payoutEligible({ ...base, reportedAt: t0 }, { outcome: null }, now), 'open report: wait');
assert(payoutEligible({ ...base, reportedAt: t0 }, { outcome: 'pay_full' }, now), 'decided pay in full: pay');
assert(payoutEligible({ ...base, reportedAt: t0 }, { outcome: 'partial_refund' }, now), 'decided partial refund: pay the rest');
assert(!payoutEligible({ ...base, reportedAt: t0 }, { outcome: 'full_refund' }, now), 'decided full refund: never pay');
assert(!payoutEligible({ ...base, payoutStatus: 'paid' }, null, now), 'paid already: never twice');
assert(!payoutEligible({ ...base, payoutStatus: 'canceled' }, null, now), 'canceled: never');
assert(!payoutEligible({ ...base, completedAt: null, windowEndsAt: null }, null, now), 'not complete: never');

console.log('\n── report refunds (B6: balance first, then the deposit, fees included) ──');
let s = splitReportRefund(30000, { balanceLeft: 59400, depositLeft: 10800 });
assert(s.ok && s.fromBalance === 30000 && s.fromDeposit === 0, 'a partial refund comes off the balance first', s);
s = splitReportRefund(65000, { balanceLeft: 59400, depositLeft: 10800 });
assert(s.ok && s.fromBalance === 59400 && s.fromDeposit === 5600, 'then the deposit', s);
s = splitReportRefund(70200, { balanceLeft: 59400, depositLeft: 10800 });
assert(s.ok && s.fromBalance === 59400 && s.fromDeposit === 10800, 'a full refund is every dollar, fees included', s);
s = splitReportRefund(70201, { balanceLeft: 59400, depositLeft: 10800 });
assert(!s.ok, 'never more than was paid', s);
s = splitReportRefund(0, { balanceLeft: 59400, depositLeft: 10800 });
assert(!s.ok, 'zero is not a refund', s);

const left = { balanceLeft: 59400, depositLeft: 10800 };
let o = resolveOutcome('pay_full', undefined, left);
assert(o.ok && o.refundCents === 0, 'pay in full refunds nothing', o);
o = resolveOutcome('full_refund', undefined, left);
assert(o.ok && o.refundCents === 70200, 'full refund is everything still paid', o);
o = resolveOutcome('partial_refund', 25000, left);
assert(o.ok && o.refundCents === 25000, 'partial refund takes the amount', o);
o = resolveOutcome('partial_refund', undefined, left);
assert(!o.ok && o.code === 'AMOUNT_REQUIRED', 'partial needs an amount', o);
o = resolveOutcome('partial_refund', 70200, left);
assert(!o.ok && o.code === 'USE_FULL_REFUND', 'the whole amount is a full refund', o);
o = resolveOutcome('partial_refund', 12.5 as any, left);
assert(!o.ok && o.code === 'AMOUNT_INVALID', 'whole cents only', o);
o = resolveOutcome('nonsense' as any, undefined, left);
assert(!o.ok && o.code === 'OUTCOME_INVALID', 'unknown outcome refused', o);
o = resolveOutcome('full_refund', undefined, { balanceLeft: 0, depositLeft: 0 });
assert(!o.ok && o.code === 'NOTHING_TO_REFUND', 'nothing left to refund', o);

assert(legacyDecision('approved', undefined) === 'full_refund', "today's Approve button means full refund (B7)");
assert(legacyDecision('rejected', undefined) === 'pay_full', "today's Reject button means pay the vendor in full");
assert(legacyDecision('approved', 'partial_refund') === 'partial_refund', 'an outcome sent wins');
assert(legacyDecision('pending', undefined) === null, 'pending decides nothing');

console.log('\n── points follow the money (B8) ──');
assert(pointsTarget(10800, 0) === pointsForGrossCents(10800), 'nothing refunded: all the points');
assert(pointsTarget(10800, 10800) === 0, 'all refunded: none');
assert(pointsTarget(59400, 29700) === pointsForGrossCents(29700), 'half refunded: points on the half still paid');
assert(pointsTarget(10800, 20000) === 0, 'never negative');
assert(pointsToReverse({ earned: 2000, alreadyReversed: 0, target: 1000 }) === 1000, 'reverse down to the target');
assert(pointsToReverse({ earned: 2000, alreadyReversed: 1200, target: 1000 }) === 0, 'already below the target: nothing more (never adds back)');
assert(pointsToReverse({ earned: 2000, alreadyReversed: 500, target: 1000 }) === 500, 'only the part still above the target');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
