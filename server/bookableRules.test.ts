/**
 * Which services can be booked (risk 1: a paused service could still be booked; R20: a hold never checked
 * the service belongs to the provider). Pure rules only, no database.
 *
 * Run with: npx tsx server/bookableRules.test.ts
 */
import {
  SERVICE_UNAVAILABLE_MESSAGE,
  isServiceBookable,
  ownsService,
  planLapsedFromPolicy,
} from './bookableRules';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

console.log('\n── isServiceBookable: same rule as the public service lists (live AND active) ──');
assert(isServiceBookable({ status: 'live', isActive: true }) === true, 'live + active → bookable');
for (const status of ['draft', 'archived', 'paused', '', null, undefined]) {
  assert(isServiceBookable({ status: status as any, isActive: true }) === false, `status ${JSON.stringify(status)} → not bookable`);
}
assert(isServiceBookable({ status: 'live', isActive: false }) === false, 'live but inactive → not bookable');
assert(isServiceBookable({ status: 'live', isActive: null }) === false, 'live, isActive null → not bookable (public list treats it the same)');
assert(isServiceBookable(null) === false, 'missing service → not bookable');
assert(isServiceBookable(undefined) === false, 'undefined service → not bookable');
assert(isServiceBookable({ status: 'live', isActive: true, requestOnly: true }) === false, 'request only (067) → never bookable');
assert(isServiceBookable({ status: 'live', isActive: true, requestOnly: false }) === true, 'requestOnly false → bookable');
assert(isServiceBookable({ status: 'live', isActive: true, requestOnly: null }) === true, 'requestOnly null (staff / photographer rows) → bookable');

console.log('\n── ownsService ──');
assert(ownsService('biz-1', 'biz-1') === true, 'same owner → true');
assert(ownsService('biz-2', 'biz-1') === false, 'other owner → false');
assert(ownsService(null, 'biz-1') === false, 'no owner → false');
assert(ownsService(undefined, 'biz-1') === false, 'undefined owner → false');
assert(ownsService('', '') === false, 'empty ids never match');

console.log('\n── planLapsedFromPolicy: same rule as the staff seat block (routes.ts, staff invites) ──');
assert(planLapsedFromPolicy({ stripeSubscriptionId: 'sub_1' }, false) === true, 'paid plan, not active by policy → lapsed');
assert(planLapsedFromPolicy({ stripeSubscriptionId: 'sub_1' }, true) === false, 'paid plan, active (or in grace) → not lapsed');
assert(planLapsedFromPolicy({ stripeSubscriptionId: null }, false) === false, 'free or granted row (no Stripe plan) → today\'s behaviour');
assert(planLapsedFromPolicy(null, false) === false, 'no subscription row (e.g. XO) → today\'s behaviour');
assert(planLapsedFromPolicy(undefined, false) === false, 'undefined row → today\'s behaviour');

console.log('\n── customer copy ──');
assert(SERVICE_UNAVAILABLE_MESSAGE === "This service isn't available to book right now. Please choose another service.", 'exact message', SERVICE_UNAVAILABLE_MESSAGE);
assert(!/[–—]| - /.test(SERVICE_UNAVAILABLE_MESSAGE), 'message has no dash');
assert(!SERVICE_UNAVAILABLE_MESSAGE.includes('%'), 'message has no percent');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
