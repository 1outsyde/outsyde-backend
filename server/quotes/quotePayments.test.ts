/**
 * Pure tests for paying a quote (Quotes in Messages, step 3). No database, no network.
 * Run with: npx tsx server/quotes/quotePayments.test.ts
 *
 * Legend 2026-11-04 (all 12 recommended): quote payments need a business that can take money (approved, payouts
 * finished, active plan, Vendor Agreement accepted, and the sending staff member's payouts); cancelling follows
 * the vendor's own policy as for services, saved at payment (the quote's service, else the business policy);
 * jobs longer than a day block the extra days.
 */
import { canTakeQuotePayments, savedQuotePolicy, jobDaySegments, cancellationPolicyFor } from './quotePayments';

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

console.log('\n── savedQuotePolicy ──');
{
  // Cancelling a quote booking uses the vendor's own policy exactly as for services, read from the booking.
  const p = savedQuotePolicy({ serviceFullRefundWindow: '24_hours', serviceHasPartialRefund: true, servicePartialRefundWindow: '1_hour', servicePartialRefundPercentage: 50,
    serviceHasCancellationFee: true, serviceCancellationFeeType: 'flat', serviceCancellationFeeAmount: 5000 });
  assert(p.fullRefundWindow === '24_hours' && p.hasPartialRefund === true && p.partialRefundWindow === '1_hour' && p.partialRefundPercentage === 50
    && p.hasCancellationFee === true && p.cancellationFeeType === 'flat' && p.cancellationFeeAmount === 5000, 'the saved policy in the shape the cancel routes read', p);
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
