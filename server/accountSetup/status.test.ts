/**
 * Pure tests for computeSetupSteps — run with: npx tsx server/accountSetup/status.test.ts
 * No database, no network.
 */
import { computeSetupSteps, payoutsReady, type SetupInput } from "./status";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const NOW = new Date("2026-10-15T12:00:00Z");
const base: SetupInput = { hasLoginMethod: true, hasUsername: true, now: NOW };
const paidTier = { priceInCents: 2900 } as any;
const freeTier = { priceInCents: 0 } as any;

// consumer
let s = computeSetupSteps(base);
assert(s.role === "consumer" && s.complete && s.next === null, "consumer with password + username is complete", s);

s = computeSetupSteps({ ...base, hasLoginMethod: false, hasUsername: false });
assert(s.next === "password" && !s.complete, "passwordless consumer → next is password", s);

s = computeSetupSteps({ ...base, hasUsername: false });
assert(s.next === "username", "consumer without username → next is username", s);

// business
s = computeSetupSteps({ ...base, business: { approvalStatus: "pending", subscription: null, tier: null, payoutsComplete: false } });
assert(s.role === "business" && s.steps.find(x => x.key === "approval")?.state === "waiting", "pending business → approval waiting", s);
assert(s.next === null && !s.complete, "pending business with username → nothing actionable, not complete", s);
assert(!s.steps.some(x => x.key === "plan"), "pending business → plan/payout steps hidden until approved", s);

s = computeSetupSteps({ ...base, business: { approvalStatus: "approved", subscription: null, tier: null, payoutsComplete: false } });
assert(s.next === "plan", "approved business without subscription → next is plan", s);

s = computeSetupSteps({ ...base, business: { approvalStatus: "approved", subscription: { stripeSubscriptionId: "sub_1", status: "active", currentPeriodEnd: null } as any, tier: { priceInCents: 4099 } as any, payoutsComplete: false } });
assert(s.steps.find(x => x.key === "plan")?.state === "done" && s.next === "payouts", "grandfathered/paid row → plan done, next payouts", s);

s = computeSetupSteps({ ...base, business: { approvalStatus: "approved", subscription: { stripeSubscriptionId: null, status: "active", currentPeriodEnd: "2099-01-01T00:00:00.000Z" } as any, tier: freeTier, payoutsComplete: true } });
assert(s.complete, "waived (complimentary) active grant + payouts → complete", s);

s = computeSetupSteps({ ...base, business: { approvalStatus: "approved", subscription: { stripeSubscriptionId: null, status: "active", currentPeriodEnd: "2026-10-01T00:00:00.000Z" } as any, tier: freeTier, payoutsComplete: true } });
assert(s.next === "plan", "expired complimentary grant → plan todo again", s);

s = computeSetupSteps({ ...base, business: { approvalStatus: "approved", subscription: { stripeSubscriptionId: "sub_2", status: "canceled", currentPeriodEnd: null } as any, tier: paidTier, payoutsComplete: true } });
assert(s.next === "plan", "canceled paid subscription → plan todo", s);

// photographer
s = computeSetupSteps({ ...base, hasUsername: false, photographer: { payoutsComplete: true } });
assert(s.role === "photographer" && s.next === "username", "onboarded photographer without username → next username", s);

s = computeSetupSteps({ ...base, photographer: { payoutsComplete: false } });
assert(s.next === "payouts", "photographer without payouts → next payouts", s);

// staff
s = computeSetupSteps({ ...base, staff: [{ payoutsComplete: false }] });
assert(s.role === "staff" && s.next === "payouts", "active staff without payouts → next payouts", s);

s = computeSetupSteps({ ...base, staff: [] });
assert(s.role === "consumer" && s.complete, "no active staff rows → treated as consumer", s);

// ordering: password always first
s = computeSetupSteps({ ...base, hasLoginMethod: false, business: { approvalStatus: "approved", subscription: null, tier: null, payoutsComplete: false } });
assert(s.next === "password" && s.steps[0].key === "password", "password comes before plan/payouts", s);

// payouts count as done only with a real Stripe account (flag alone is not enough)
assert(payoutsReady(true, "acct_123") === true, "flag + account → payouts ready");
assert(payoutsReady(true, null) === false, "flag true but no account (Lana case) → not ready");
assert(payoutsReady(true, "") === false, "flag true, empty account id → not ready");
assert(payoutsReady(false, "acct_123") === false, "account but flag false → not ready");
assert(payoutsReady(null, undefined) === false, "nothing → not ready");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
