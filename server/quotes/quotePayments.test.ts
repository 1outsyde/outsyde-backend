/**
 * Pure tests for paying a quote (Quotes in Messages, step 3). No database, no network.
 * Run with: npx tsx server/quotes/quotePayments.test.ts
 *
 * Legend 2026-11-04 (all 12 recommended): quote payments need a business that can take money (approved, payouts
 * finished, active plan, Vendor Agreement accepted, and the sending staff member's payouts); deposit quotes keep
 * the deposit and the vendor's cancellation fee is charged on top; a full price quote refunds the price minus the
 * vendor's fee (service fee kept); the quote's service policy, else the business policy, saved at payment;
 * refund windows are ignored for quotes; jobs longer than a day block the extra days.
 */
import { canTakeQuotePayments, quoteCancelOutcome, jobDaySegments, cancellationPolicyFor } from './quotePayments';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

console.log('\n── canTakeQuotePayments ──');
{
  const ready = { approvalStatus: 'approved', stripeAccountId: 'acct_1', stripeOnboardingComplete: true, vendorAgreementAccepted: true };
  assert(canTakeQuotePayments(ready, true, null).ok === true, 'approved, payouts done, plan active, agreement accepted: ok');
  const r1 = canTakeQuotePayments({ ...ready, stripeAccountId: 'acct_1', stripeOnboardingComplete: false }, true, null);
  assert(!r1.ok && r1.code === 'PAYOUTS_NOT_READY', 'an account id alone is not enough (R38)', r1);
  const r2 = canTakeQuotePayments({ ...ready, stripeAccountId: null }, true, null);
  assert(!r2.ok && r2.code === 'PAYOUTS_NOT_READY', 'no Stripe account', r2);
  const r3 = canTakeQuotePayments(ready, false, null);
  assert(!r3.ok && r3.code === 'PLAN_NOT_ACTIVE', 'no active plan', r3);
  const r4 = canTakeQuotePayments({ ...ready, approvalStatus: 'pending' }, true, null);
  assert(!r4.ok && r4.code === 'NOT_APPROVED', 'not approved', r4);
  const r5 = canTakeQuotePayments({ ...ready, vendorAgreementAccepted: false }, true, null);
  assert(!r5.ok && r5.code === 'AGREEMENT_NOT_ACCEPTED', 'Vendor Agreement not accepted', r5);
  const r6 = canTakeQuotePayments(ready, true, { status: 'active', stripeAccountId: 'acct_s', stripeOnboardingComplete: false });
  assert(!r6.ok && r6.code === 'STAFF_PAYOUTS_NOT_READY', 'staff quote: the staff member must have payouts finished', r6);
  const r7 = canTakeQuotePayments(ready, true, { status: 'active', stripeAccountId: 'acct_s', stripeOnboardingComplete: true });
  assert(r7.ok === true, 'staff quote with staff payouts finished: ok');
  const r8 = canTakeQuotePayments(ready, true, { status: 'removed', stripeAccountId: 'acct_s', stripeOnboardingComplete: true });
  assert(!r8.ok && r8.code === 'STAFF_NOT_ACTIVE', 'staff member no longer active', r8);
  for (const r of [r1, r2, r3, r4, r5, r6, r8]) {
    if (!r.ok) assert(!/ - | — | – /.test(r.message) && !/8%|8 %|percent/.test(r.message), `customer copy has no dashes or fee rate (${r.code})`, r.message);
  }
}

console.log('\n── cancellationPolicyFor ──');
{
  const svc = { fullRefundWindow: '24_hours', hasPartialRefund: false, partialRefundWindow: null, partialRefundPercentage: null, hasCancellationFee: true, cancellationFeeType: 'flat', cancellationFeeAmount: 5000 };
  const biz = { fullRefundWindow: 'never', hasPartialRefund: false, partialRefundWindow: null, partialRefundPercentage: null, hasCancellationFee: true, cancellationFeeType: 'percentage', cancellationFeeAmount: 20 };
  assert(cancellationPolicyFor(svc, biz).serviceCancellationFeeAmount === 5000, 'the quote has a service: its policy is used');
  assert(cancellationPolicyFor(null, biz).serviceCancellationFeeType === 'percentage', 'no service: the business policy is used');
  const none = cancellationPolicyFor(null, null);
  assert(none.serviceHasCancellationFee === null && none.serviceCancellationFeeAmount === null, 'neither: nothing saved');
}

console.log('\n── quoteCancelOutcome ──');
{
  const flat = { serviceHasCancellationFee: true, serviceCancellationFeeType: 'flat', serviceCancellationFeeAmount: 5000 };
  const pct = { serviceHasCancellationFee: true, serviceCancellationFeeType: 'percentage', serviceCancellationFeeAmount: 20 };
  const noFee = { serviceHasCancellationFee: false, serviceCancellationFeeType: null, serviceCancellationFeeAmount: null };

  const d0 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: 10000, ...noFee });
  assert(d0.refundTier === 'none' && d0.refundAmountCents === 0 && d0.chargeFeeCents === 0 && d0.feeCents === 0, 'deposit quote, no fee: deposit kept, nothing else', d0);
  const d1 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: 10000, ...flat });
  assert(d1.refundTier === 'none' && d1.refundAmountCents === 0 && d1.chargeFeeCents === 5000 && d1.feeCents === 5000, 'deposit quote: deposit kept and the vendor fee charged on top', d1);
  const d2 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: 10000, ...pct });
  assert(d2.chargeFeeCents === 13000, 'a percentage fee is on the job total', d2);
  const d3 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: 10000, serviceHasCancellationFee: true, serviceCancellationFeeType: 'flat', serviceCancellationFeeAmount: 90000 });
  assert(d3.chargeFeeCents === 55000, 'the fee on top is never more than the balance left', d3);

  const f0 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: null, ...noFee });
  assert(f0.refundTier === 'full' && f0.refundAmountCents === 65000 && f0.chargeFeeCents === 0, 'full price quote, no fee: the price comes back (service fee kept)', f0);
  const f1 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: null, ...flat });
  assert(f1.refundTier === 'partial' && f1.refundAmountCents === 60000 && f1.chargeFeeCents === 0 && f1.feeCents === 5000, 'full price quote: the price minus the vendor fee, no second charge', f1);
  const f2 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: null, serviceHasCancellationFee: true, serviceCancellationFeeType: 'flat', serviceCancellationFeeAmount: 70000 });
  assert(f2.refundTier === 'none' && f2.refundAmountCents === 0 && f2.feeCents === 65000, 'a fee bigger than the price: nothing comes back', f2);
  const f3 = quoteCancelOutcome({ totalPrice: 65000, depositAmountCents: null, serviceHasCancellationFee: true, serviceCancellationFeeType: 'flat', serviceCancellationFeeAmount: null });
  assert(f3.refundTier === 'full' && f3.feeCents === 0, 'a fee switched on with no amount counts as no fee', f3);
}

console.log('\n── jobDaySegments ──');
{
  const one = jobDaySegments('2026-11-13', '09:00', 300);
  assert(one.length === 1 && one[0].date === '2026-11-13' && one[0].startTime === '09:00' && one[0].endTime === '14:00', 'same day job', one);
  const late = jobDaySegments('2026-11-13', '22:00', 180);
  assert(late.length === 2 && late[0].endTime === '23:59' && late[1].date === '2026-11-14' && late[1].startTime === '00:00' && late[1].endTime === '01:00', 'crosses midnight', late);
  const three = jobDaySegments('2026-11-30', '08:00', 3 * 24 * 60);
  assert(three.length === 4 && three[1].date === '2026-12-01' && three[2].date === '2026-12-02' && three[3].date === '2026-12-03' && three[3].endTime === '08:00', 'three days, across a month', three);
  const toMidnight = jobDaySegments('2026-11-13', '20:00', 240);
  assert(toMidnight.length === 1 && toMidnight[0].endTime === '23:59', 'ending exactly at midnight stays one day', toMidnight);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
