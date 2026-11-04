/**
 * Pure tests for quotes step 4a (balance hold, Job complete, cancels). No database, no network.
 * Run with: npx tsx server/quotes/quoteBalance.test.ts
 *
 * Legend 2026-11-04 (final): fees split (each payment carries the service fee and the 2% on its own amount, adding
 * up to one fee on the whole job); balance + its fee held 24 h before the job (right after payment when sooner),
 * retry 12 h before; Job complete by the owner or the sending staff member, or 2 h after the scheduled end;
 * cancel after the hold: take only what is owed from the hold and release the rest.
 */
import { quoteBalanceSplit, quoteExtraSplit, quoteDeposit, calculateBookingFees } from '../fees';
import { balanceHoldTimes, autoCompleteAt, splitHold, jobCompleteBlocker } from './quoteBalanceRules';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

console.log('\n── quoteBalanceSplit (split rule) ──');
{
  // The plan page example: $650 job, $100 deposit. Deposit $100 + $8 now; balance $550 + $44 at Job complete.
  const s = quoteBalanceSplit(65000, 10000);
  assert(s.balanceCents === 55000, 'balance is total less deposit', s);
  assert(s.serviceFeeCents === 4400, 'service fee on the balance only', s);
  assert(s.platformFeeCents === 1100, '2% on the balance only', s);
  assert(s.vendorNetCents === 53900, 'vendor share of the balance is balance less 2%', s);
  assert(s.holdCents === 59400, 'hold is balance + its service fee', s);
  const dep = quoteDeposit(65000, 10000);
  assert(dep.feeBreakdown.consumerServiceFeeCents + s.serviceFeeCents === calculateBookingFees(65000).consumerServiceFeeCents, 'deposit fee + balance fee = one fee on the whole job');
}
{
  // Rounding can never add a cent: totals always equal the whole job's fees.
  let ok = true;
  for (const [t, d] of [[70001, 700], [12345, 1111], [99999, 7001], [800, 701], [1000063, 333333]]) {
    const s = quoteBalanceSplit(t, d);
    const dep = calculateBookingFees(d);
    const whole = calculateBookingFees(t);
    if (dep.consumerServiceFeeCents + s.serviceFeeCents !== whole.consumerServiceFeeCents) ok = false;
    if (dep.platformFeeCents + s.platformFeeCents !== whole.platformFeeCents) ok = false;
    if (dep.vendorNetCents + s.vendorNetCents !== whole.vendorNetCents) ok = false;
  }
  assert(ok, 'fees and vendor share add up exactly across odd amounts');
}
{
  const full = quoteBalanceSplit(50000, null);
  assert(full.balanceCents === 0 && full.holdCents === 0 && full.serviceFeeCents === 0, 'paid in full: no balance, no hold', full);
  const zero = quoteBalanceSplit(50000, 0);
  assert(zero.holdCents === 0, 'deposit 0 counts as paid in full', zero);
}
{
  const e = quoteExtraSplit(5000);
  assert(e.serviceFeeCents === 400 && e.platformFeeCents === 100 && e.vendorNetCents === 4900 && e.holdCents === 5400, 'an extra carries its own fee and 2%', e);
  let threw = false; try { quoteExtraSplit(0); } catch { threw = true; }
  assert(threw, 'an extra must be more than 0');
}

console.log('\n── balanceHoldTimes ──');
{
  const H = 3600_000;
  const startsAt = new Date('2026-12-10T15:00:00Z');
  const paidLong = new Date('2026-12-01T12:00:00Z');
  const t = balanceHoldTimes(startsAt, paidLong);
  assert(t.holdAt.toISOString() === '2026-12-09T15:00:00.000Z', 'held 24 h before the job', t);
  assert(t.retryAt?.toISOString() === '2026-12-10T03:00:00.000Z', 'retried 12 h before the job', t);
  const paidSoon = new Date(startsAt.getTime() - 20 * H);
  const s = balanceHoldTimes(startsAt, paidSoon);
  assert(s.holdAt.getTime() === paidSoon.getTime(), 'job sooner than 24 h: held right after payment', s);
  assert(s.retryAt?.getTime() === startsAt.getTime() - 12 * H, 'still retried 12 h before', s);
  const paidVerySoon = new Date(startsAt.getTime() - 5 * H);
  const v = balanceHoldTimes(startsAt, paidVerySoon);
  assert(v.holdAt.getTime() === paidVerySoon.getTime(), 'job 5 h away: held right after payment', v);
  assert(v.retryAt?.getTime() === paidVerySoon.getTime() + 1 * H, 'job under 12 h away: one retry an hour later', v);
  const paidLast = new Date(startsAt.getTime() - 30 * 60_000);
  const w = balanceHoldTimes(startsAt, paidLast);
  assert(w.retryAt === null, 'no retry when an hour later is past the start', w);
}

console.log('\n── autoCompleteAt ──');
{
  const a = autoCompleteAt(new Date('2026-12-10T15:00:00Z'), 180);
  assert(a.toISOString() === '2026-12-10T20:00:00.000Z', '2 h after the scheduled end', a);
  const m = autoCompleteAt(new Date('2026-12-10T15:00:00Z'), 3 * 24 * 60);
  assert(m.toISOString() === '2026-12-13T17:00:00.000Z', 'multi day jobs: 2 h after the last day ends', m);
}

console.log('\n── splitHold (cancel after the hold) ──');
{
  const r = splitHold(30000, 5000);
  assert(r.captureCents === 5000 && r.releaseCents === 25000, 'a $300 hold, $50 owed: take $50, release $250', r);
  const n = splitHold(30000, 0);
  assert(n.captureCents === 0 && n.releaseCents === 30000, 'nothing owed: release all', n);
  const o = splitHold(30000, 45000);
  assert(o.captureCents === 30000 && o.releaseCents === 0, 'owed more than held: take only what is held', o);
  const neg = splitHold(30000, -5);
  assert(neg.captureCents === 0, 'a negative owed amount takes nothing', neg);
}

console.log('\n── jobCompleteBlocker ──');
{
  const now = new Date('2026-12-10T16:00:00Z');
  const base = { status: 'confirmed', quoteKind: 'service', startsAt: new Date('2026-12-10T15:00:00Z'), balanceStatus: 'held' as string | null, completedAt: null as Date | null };
  assert(jobCompleteBlocker(base, now) === null, 'confirmed, started, balance held: can complete');
  assert(jobCompleteBlocker({ ...base, balanceStatus: null }, now) === null, 'paid in full (no balance row): can complete');
  assert(jobCompleteBlocker({ ...base, status: 'completed' }, now) === 'ALREADY_COMPLETE', 'already completed');
  assert(jobCompleteBlocker({ ...base, status: 'canceled' }, now) === 'NOT_CONFIRMED', 'canceled cannot complete');
  assert(jobCompleteBlocker({ ...base, quoteKind: 'product' }, now) === 'PRODUCT_QUOTE', 'product quotes are delivered, not completed');
  assert(jobCompleteBlocker({ ...base, startsAt: new Date('2026-12-10T17:00:00Z') }, now) === 'NOT_STARTED', 'the job has not started yet');
  assert(jobCompleteBlocker({ ...base, balanceStatus: 'hold_failed' }, now) === 'BALANCE_NOT_HELD', 'balance not held: cannot charge it');
  assert(jobCompleteBlocker({ ...base, balanceStatus: 'scheduled' }, now) === 'BALANCE_NOT_HELD', 'hold not placed yet');
  assert(jobCompleteBlocker({ ...base, balanceStatus: 'captured' }, now) === null, 'charged but the booking not completed yet: finish it (review C1)');
  assert(jobCompleteBlocker({ ...base, balanceStatus: 'capturing' }, now) === null, 'capture in doubt: let the capture look at Stripe (review C1)');
  assert(jobCompleteBlocker({ ...base, balanceStatus: 'captured', completedAt: now }, now) === 'ALREADY_COMPLETE', 'completed: done');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
