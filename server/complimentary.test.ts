/**
 * Complimentary ("waived") tier tests — run with: npx tsx server/complimentary.test.ts
 *
 * Pure logic only: no production database, no Stripe. The storage backstop test builds a
 * DatabaseStorage without ever running a query (DATABASE_URL is a dummy that is never dialled).
 */

import {
  isComplimentaryTier,
  isSubscriptionProvisioned,
  isExpiredUnbilledActiveRow,
  isTerminalStripeStatus,
  resolveGrantTierId,
  selectTiersForCaller,
  PERMANENT_EXPIRY_ISO,
} from './complimentary';
import { grantToken } from './utils/grantToken';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

const NOW = new Date('2026-09-30T12:00:00Z');
const PAST = new Date('2026-09-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');

// Tier fixtures mirror the production rows (SELECT * FROM subscription_tiers)
const WAIVED = { id: 'tier-waived', name: 'waived', priceInCents: 0, stripePriceId: null, sortOrder: -2 };
const GRANDFATHERED = { id: 'tier-gf', name: 'grandfathered', priceInCents: 4099, stripePriceId: 'price_1SqLPsRxWOny76kZbQXc', sortOrder: -1 };
const STARTER = { id: 'tier-starter', name: 'starter', priceInCents: 2900, stripePriceId: 'price_1U73BmRxWOny76kZPUKzAcme', sortOrder: 0 };
const GROWTH = { id: 'tier-growth', name: 'growth', priceInCents: 5900, stripePriceId: 'price_1U73DQRxWOny76kZhoEcEEUC', sortOrder: 1 };
const PRO = { id: 'tier-pro', name: 'pro', priceInCents: 9900, stripePriceId: 'price_1U73E8RxWOny76kZkFLcOo6T', sortOrder: 2 };
const ALL = [WAIVED, GRANDFATHERED, STARTER, GROWTH, PRO]; // already sorted by sortOrder

console.log('\n=== Complimentary Tier Tests ===\n');

// ── isComplimentaryTier ─────────────────────────────────────────────────────
console.log('Test 1: isComplimentaryTier');
{
  assert(isComplimentaryTier(WAIVED) === true, 'waived is complimentary');
  assert(isComplimentaryTier(GRANDFATHERED) === false, 'grandfathered is not');
  assert(isComplimentaryTier(STARTER) === false, 'starter is not');
  assert(isComplimentaryTier(GROWTH) === false, 'growth is not');
  assert(isComplimentaryTier(PRO) === false, 'pro is not');
  assert(isComplimentaryTier(null) === false, 'null is not');
  assert(isComplimentaryTier(undefined) === false, 'undefined is not');
  assert(isComplimentaryTier({ priceInCents: 0, stripePriceId: 'price_x' }) === false, 'price 0 WITH a Stripe price is not');
  assert(isComplimentaryTier({ priceInCents: 500, stripePriceId: null }) === false, 'priced tier with no Stripe price is not');
  assert(isComplimentaryTier({ name: 'anything-else', priceInCents: 0, stripePriceId: null } as any) === true, 'decided by price fields, not by name');
}

// ── tiers filter ────────────────────────────────────────────────────────────
console.log('\nTest 2: selectTiersForCaller (GET /api/subscription-tiers)');
{
  const ids = (list: { id: string }[]) => list.map((t) => t.id).join(',');

  assert(ids(selectTiersForCaller(ALL, {})) === 'tier-starter,tier-growth,tier-pro',
    'anonymous: only sortOrder >= 0 (no waived, no grandfathered)');
  assert(ids(selectTiersForCaller(ALL)) === 'tier-starter,tier-growth,tier-pro', 'no context = anonymous');
  assert(ids(selectTiersForCaller(ALL, { currentTierId: GRANDFATHERED.id })) === 'tier-gf,tier-starter,tier-growth,tier-pro',
    "own tier: a grandfathered holder still sees their plan, in sortOrder");
  assert(ids(selectTiersForCaller(ALL, { currentTierId: WAIVED.id })) === 'tier-waived,tier-starter,tier-growth,tier-pro',
    "own tier: a waived holder still sees their plan");
  assert(ids(selectTiersForCaller(ALL, { grantTierId: GRANDFATHERED.id })) === 'tier-gf,tier-starter,tier-growth,tier-pro',
    'valid grant: names the grandfathered tier');
  assert(ids(selectTiersForCaller(ALL, { grantTierId: null })) === 'tier-starter,tier-growth,tier-pro',
    'no valid grant: public list only');
  assert(ids(selectTiersForCaller(ALL, { isAdmin: true })) === 'tier-waived,tier-gf,tier-starter,tier-growth,tier-pro',
    'admin: everything');
  assert(ids(selectTiersForCaller(ALL, { isAdmin: false, currentTierId: STARTER.id })) === 'tier-starter,tier-growth,tier-pro',
    'non-admin holder of a public tier: still only the public list');
  assert(ids(selectTiersForCaller([{ id: 'x', sortOrder: null }], {})) === 'x', 'null sortOrder is treated as 0 (public)');
  assert(ids(selectTiersForCaller(ALL, { grantTierId: 'unknown-id' })) === 'tier-starter,tier-growth,tier-pro',
    'a grant naming an unknown tier adds nothing');
}

// ── ?grant= resolution ──────────────────────────────────────────────────────
console.log('\nTest 3: resolveGrantTierId (invalid / expired / missing secret)');
{
  const good = (_t: string) => ({ tierId: GRANDFATHERED.id, businessId: 'b', exp: 1 });
  const expired = (_t: string): { tierId: string } => { throw new Error('TOKEN_EXPIRED'); };
  const invalid = (_t: string): { tierId: string } => { throw new Error('INVALID_SIGNATURE'); };
  const noSecret = (_t: string): { tierId: string } => { throw new TypeError('The "key" argument must be of type string'); };

  assert(resolveGrantTierId('tok', good) === GRANDFATHERED.id, 'valid grant → tier id');
  assert(resolveGrantTierId('tok', expired) === null, 'expired grant → null (public list)');
  assert(resolveGrantTierId('tok', invalid) === null, 'invalid grant → null (public list)');
  assert(resolveGrantTierId('tok', noSecret) === null, 'verify throwing a TypeError → null');
  assert(resolveGrantTierId(undefined, good) === null, 'no grant param → null');
  assert(resolveGrantTierId('', good) === null, 'empty grant → null');
  assert(resolveGrantTierId(['a', 'b'], good) === null, 'array (repeated ?grant=) → null');
  assert(resolveGrantTierId({ x: 1 }, good) === null, 'object → null');
  assert(resolveGrantTierId('tok', () => ({ tierId: '' })) === null, 'empty tier id in payload → null');

  // The real grantToken module with GRANT_LINK_SECRET unset: verify throws, wrapper swallows it.
  assert(!process.env.GRANT_LINK_SECRET, 'test precondition: GRANT_LINK_SECRET is unset');
  assert(resolveGrantTierId('abc.def', (t) => grantToken.verify(t)) === null,
    'real grantToken.verify with a missing GRANT_LINK_SECRET → null (no 500)');
  assert(resolveGrantTierId('not-a-token', (t) => grantToken.verify(t)) === null, 'malformed token → null');
}

// ── eligibility provisioned logic ───────────────────────────────────────────
console.log('\nTest 4: isSubscriptionProvisioned (/api/vendor/eligibility)');
{
  const comp = (over: object = {}) => ({ status: 'active', stripeSubscriptionId: null, currentPeriodEnd: FUTURE, ...over });
  const paid = (over: object = {}) => ({ status: 'active', stripeSubscriptionId: 'sub_123', currentPeriodEnd: FUTURE, ...over });

  assert(isSubscriptionProvisioned(comp(), WAIVED, NOW) === true, 'complimentary active, period in future → provisioned');
  assert(isSubscriptionProvisioned(comp({ currentPeriodEnd: PAST }), WAIVED, NOW) === false, 'complimentary active but expired → not provisioned');
  assert(isSubscriptionProvisioned(comp({ status: 'canceled' }), WAIVED, NOW) === false, 'complimentary canceled → not provisioned');
  assert(isSubscriptionProvisioned(comp({ status: 'canceled', currentPeriodEnd: PAST }), WAIVED, NOW) === false, 'complimentary canceled + expired → not provisioned');
  assert(isSubscriptionProvisioned(comp({ currentPeriodEnd: null }), WAIVED, NOW) === false, 'complimentary with no period end → not provisioned');
  assert(isSubscriptionProvisioned(comp({ currentPeriodEnd: NOW }), WAIVED, NOW) === true, 'period end == now counts (>= now)');
  assert(isSubscriptionProvisioned(comp({ currentPeriodEnd: FUTURE.toISOString() }), WAIVED, NOW) === true, 'ISO string period end is handled');
  assert(isSubscriptionProvisioned(comp(), GROWTH, NOW) === false, 'no Stripe id on a priced tier → still not provisioned (unchanged)');
  assert(isSubscriptionProvisioned(comp(), null, NOW) === false, 'no tier → not provisioned');
  assert(isSubscriptionProvisioned(null, WAIVED, NOW) === false, 'no row → not provisioned');
  assert(isSubscriptionProvisioned(undefined, WAIVED, NOW) === false, 'undefined row → not provisioned');

  // paid rows are unchanged
  assert(isSubscriptionProvisioned(paid(), GROWTH, NOW) === true, 'paid active → provisioned');
  assert(isSubscriptionProvisioned(paid({ status: 'trialing' }), GROWTH, NOW) === true, 'paid trialing → provisioned');
  assert(isSubscriptionProvisioned(paid({ status: 'past_due' }), GROWTH, NOW) === true, 'paid past_due → provisioned (unchanged)');
  assert(isSubscriptionProvisioned(paid({ status: 'pending' }), STARTER, NOW) === true, 'paid pending with a Stripe id → provisioned (unchanged)');
  assert(isSubscriptionProvisioned(paid({ status: 'canceled' }), GROWTH, NOW) === false, 'paid canceled → not provisioned (unchanged)');
  assert(isSubscriptionProvisioned(paid({ status: 'incomplete_expired' }), GROWTH, NOW) === false, 'paid incomplete_expired → not provisioned (unchanged)');
  assert(isSubscriptionProvisioned(paid({ status: 'unpaid' }), GROWTH, NOW) === false, 'paid unpaid → not provisioned (unchanged)');
  assert(isSubscriptionProvisioned(paid({ currentPeriodEnd: PAST }), GRANDFATHERED, NOW) === true, 'paid active with a PAST period (Lotus / Dia Lux) stays provisioned');
}

// ── active-status backstop ──────────────────────────────────────────────────
console.log('\nTest 5: isExpiredUnbilledActiveRow (checkSubscriptionActiveStatus backstop)');
{
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: null, currentPeriodEnd: PAST }, NOW) === true, 'complimentary active + past period → expired');
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: null, currentPeriodEnd: FUTURE }, NOW) === false, 'complimentary active + future period → not expired');
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: null, currentPeriodEnd: null }, NOW) === false, 'no period end → not expired');
  assert(isExpiredUnbilledActiveRow({ status: 'canceled', stripeSubscriptionId: null, currentPeriodEnd: PAST }, NOW) === false, 'canceled is handled by the existing branch');
  assert(isExpiredUnbilledActiveRow({ status: 'pending', stripeSubscriptionId: null, currentPeriodEnd: PAST }, NOW) === false, 'pending is left to the existing branch');

  // Lotus / Dia Lux / Crash out / Nails: paid, 'active', period already ended → must NOT match
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: 'sub_lotus', currentPeriodEnd: new Date('2026-08-23') }, NOW) === false, 'Lotus (paid, active, ended) is NOT matched');
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: 'sub_dialux', currentPeriodEnd: new Date('2026-09-09') }, NOW) === false, 'Dia Lux (paid, active, ended) is NOT matched');
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: 'sub_crash', currentPeriodEnd: new Date('2026-05-31') }, NOW) === false, 'Crash out (paid, active, ended) is NOT matched');
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: 'sub_nails', currentPeriodEnd: new Date('2026-07-31') }, NOW) === false, 'Nails (paid, active, ended) is NOT matched');
  assert(isExpiredUnbilledActiveRow({ status: 'active', stripeSubscriptionId: null, currentPeriodEnd: FUTURE }, NOW) === false, 'Lana (waived, 2099) is NOT matched');
}

console.log('\nTest 6: DatabaseStorage.checkSubscriptionActiveStatus (real method, no DB query)');
(async () => {
  try {
    // db.ts only builds a lazy HTTP client here; nothing below ever runs a query.
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/never_dialled';
    const { storage } = await import('./storage');
    const check = (row: object) => (storage as any).checkSubscriptionActiveStatus(row, 3);
    const base = { id: 'r', vendorId: 'v', businessId: 'b', tierId: 't' };

    assert(check({ ...base, status: 'active', stripeSubscriptionId: 'sub_lotus', currentPeriodEnd: new Date('2026-08-23') }).active === true,
      'paid active row with a past period stays ACTIVE (Lotus / Dia Lux case)');
    assert(check({ ...base, status: 'active', stripeSubscriptionId: null, currentPeriodEnd: FUTURE }).active === true,
      'complimentary active, 2099 → active (Lana)');
    assert(check({ ...base, status: 'active', stripeSubscriptionId: null, currentPeriodEnd: new Date('2020-01-01') }).active === false,
      'complimentary active with an expired period → inactive');
    assert(check({ ...base, status: 'canceled', stripeSubscriptionId: null, currentPeriodEnd: new Date('2020-01-01') }).active === false,
      'canceled complimentary with an ended period → inactive');
    assert(check({ ...base, status: 'canceled', stripeSubscriptionId: 'sub_x', currentPeriodEnd: FUTURE }).active === true,
      'paid canceled but period not over → still active (unchanged)');
    assert(check({ ...base, status: 'trialing', stripeSubscriptionId: 'sub_x', currentPeriodEnd: null }).active === true,
      'paid trialing → active (unchanged)');
    assert(check({ ...base, status: 'pending', stripeSubscriptionId: 'sub_x', currentPeriodEnd: null }).active === false,
      'pending → inactive (unchanged)');
  } catch (err) {
    failed++;
    console.error('  ❌ storage backstop test could not run:', err instanceof Error ? err.message : err);
  }

  // ── constants ─────────────────────────────────────────────────────────────
  console.log('\nTest 7: constants');
  assert(PERMANENT_EXPIRY_ISO === '2099-01-01T00:00:00.000Z', 'permanent expiry is 2099-01-01');
  assert(isTerminalStripeStatus('canceled') && isTerminalStripeStatus('incomplete_expired'), 'canceled + incomplete_expired are terminal');
  assert(!isTerminalStripeStatus('unpaid') && !isTerminalStripeStatus('past_due') && !isTerminalStripeStatus('incomplete') && !isTerminalStripeStatus('paused') && !isTerminalStripeStatus('active') && !isTerminalStripeStatus(null),
    'unpaid / past_due / incomplete / paused / active / null are NOT terminal');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
