/**
 * Pure tests for the business setup checklist, cancellation policy and default deposit rules.
 * Run with: npx tsx server/accountSetup/businessSetup.test.ts   (no database, no network)
 */
import {
  computeBusinessSetupSteps,
  hasOpenHours,
  parseCancellationPolicy,
  parseDefaultDeposit,
  type BusinessSetupInput,
} from "./businessSetup";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const NOW = new Date("2026-10-28T12:00:00Z");
const paidSub = { status: "active", stripeSubscriptionId: "sub_1", tierId: "t1" } as any;
const paidTier = { priceInCents: 2900 } as any;
const HOURS = { monday: { open: true, start: "09:00", end: "17:00" } };

const base: BusinessSetupInput = {
  businessId: "b1",
  approvalStatus: "approved",
  hasServicesFlag: true,
  products: [],
  services: [],
  hoursOfOperation: null,
  vendorTermsAndConditions: null,
  cancellationPolicySetAt: null,
  subscription: null,
  tier: null,
  payoutsComplete: false,
  now: NOW,
};
const keys = (s: ReturnType<typeof computeBusinessSetupSteps>) => s.steps.map((x) => x.key).join(",");
const state = (s: ReturnType<typeof computeBusinessSetupSteps>, k: string) => s.steps.find((x) => x.key === k)?.state;

console.log("checklist");
let s = computeBusinessSetupSteps(base);
assert(keys(s) === "first_item,hours,cancellation_policy,terms,payouts,plan", "new approved service business: every step, in order", keys(s));
assert(s.next === "first_item" && !s.complete && s.doneCount === 0 && s.totalCount === 6, "nothing done yet", s);
assert(s.steps[0].target === "services", "no products and offers services → first item opens Services");

s = computeBusinessSetupSteps({ ...base, approvalStatus: "pending" });
assert(keys(s) === "approval,first_item,hours,cancellation_policy,terms", "pending: approval waiting, no plan or payouts yet", keys(s));
assert(state(s, "approval") === "waiting" && s.next === "first_item", "waiting is never the next step");

s = computeBusinessSetupSteps({ ...base, hasServicesFlag: false });
assert(keys(s) === "first_item,payouts,plan", "products only business: no booking steps", keys(s));
assert(s.steps[0].target === "products", "products only → first item opens Products");

s = computeBusinessSetupSteps({ ...base, hasServicesFlag: false, services: [{ name: "Cut", imageUrl: null, status: "draft" }] });
assert(keys(s).includes("hours"), "a service row counts as offering services even with the flag off");

s = computeBusinessSetupSteps({ ...base, products: [{ name: "Cake", imageUrl: null, status: "live" }, { name: "Pie", imageUrl: "x", status: "live" }] });
const pp = s.steps.find((x) => x.key === "product_photos")!;
assert(pp.state === "todo" && pp.missingCount === 1 && pp.label === "Add a photo to Cake", "one product missing a photo is named", pp);

s = computeBusinessSetupSteps({ ...base, services: [{ name: "A", imageUrl: null }, { name: "B", imageUrl: null }, { name: "C", imageUrl: null, status: "archived" }] });
const sp = s.steps.find((x) => x.key === "service_photos")!;
assert(sp.missingCount === 2 && sp.label === "Add photos to 2 services", "archived services are ignored", sp);

s = computeBusinessSetupSteps({ ...base, products: [{ name: "Old", imageUrl: null, status: "archived" }], hasServicesFlag: false });
assert(state(s, "first_item") === "todo" && !keys(s).includes("product_photos"), "only archived products = no first item");

s = computeBusinessSetupSteps({ ...base, cancellationPolicySetAt: "2026-10-28T10:00:00Z" });
assert(state(s, "cancellation_policy") === "done", "policy chosen (even 'never') → done");
s = computeBusinessSetupSteps({ ...base, vendorTermsAndConditions: "   " });
assert(state(s, "terms") === "todo", "blank terms still todo");

const full = computeBusinessSetupSteps({
  ...base,
  services: [{ name: "A", imageUrl: "x", status: "live" }],
  hoursOfOperation: HOURS,
  vendorTermsAndConditions: "Be on time",
  cancellationPolicySetAt: new Date(),
  payoutsComplete: true,
  subscription: paidSub,
  tier: paidTier,
});
assert(full.complete && full.next === null && full.doneCount === full.totalCount, "everything set → complete", full);

console.log("hours");
assert(hasOpenHours(HOURS), "app format open day");
assert(!hasOpenHours({ monday: { open: false } }), "app format closed day");
assert(hasOpenHours({ monday: { open: "09:00", close: "17:00", closed: false } }), "legacy open day");
assert(!hasOpenHours({ monday: { open: "09:00", close: "17:00", closed: true } }), "legacy closed day");
assert(hasOpenHours(JSON.stringify(HOURS)), "JSON string");
assert(!hasOpenHours({}) && !hasOpenHours(null) && !hasOpenHours("nope") && !hasOpenHours([]), "empty / bad values");

console.log("cancellation policy");
let p = parseCancellationPolicy({ fullRefundWindow: "never" });
assert(p.ok && p.policy.hasPartialRefund === false && p.policy.cancellationFeeAmount === null, "'never' alone is a valid choice", p);
p = parseCancellationPolicy({});
assert(!p.ok && p.error === "Choose when customers get a full refund", "full refund window required", p);
p = parseCancellationPolicy({ fullRefundWindow: "2_days" });
assert(!p.ok, "unknown window refused");
p = parseCancellationPolicy({ fullRefundWindow: "48_hours", hasPartialRefund: true, partialRefundWindow: "24_hours", partialRefundPercentage: 50, hasCancellationFee: true, cancellationFeeType: "flat", cancellationFeeAmount: 1000 });
assert(p.ok && p.policy.partialRefundPercentage === 50 && p.policy.cancellationFeeAmount === 1000, "full policy kept", p);
p = parseCancellationPolicy({ fullRefundWindow: "1_week", hasPartialRefund: false, partialRefundPercentage: 40, hasCancellationFee: false, cancellationFeeType: "flat", cancellationFeeAmount: 500 });
assert(p.ok && p.policy.partialRefundPercentage === null && p.policy.cancellationFeeType === null && p.policy.cancellationFeeAmount === null, "switched off parts are cleared", p);
p = parseCancellationPolicy({ fullRefundWindow: "1_week", hasPartialRefund: true });
assert(!p.ok, "partial refund needs a percentage");
p = parseCancellationPolicy({ fullRefundWindow: "1_week", hasCancellationFee: true, cancellationFeeAmount: 500 });
assert(!p.ok, "fee needs a type");
p = parseCancellationPolicy({ fullRefundWindow: "1_week", hasCancellationFee: true, cancellationFeeType: "percentage", cancellationFeeAmount: 150 });
assert(!p.ok, "percentage fee over 100 refused");
p = parseCancellationPolicy({ fullRefundWindow: "1_week", partialRefundPercentage: 101 });
assert(!p.ok, "percentage over 100 refused by the field rule");
p = parseCancellationPolicy(null);
assert(!p.ok, "no body refused");

console.log("default deposit");
assert(JSON.stringify(parseDefaultDeposit(null)) === '{"ok":true,"value":null}', "null clears");
assert(JSON.stringify(parseDefaultDeposit(0)) === '{"ok":true,"value":null}', "0 clears");
assert(JSON.stringify(parseDefaultDeposit(700)) === '{"ok":true,"value":700}', "$7.00 ok");
assert(!parseDefaultDeposit(699).ok, "under $7.00 refused");
assert(!parseDefaultDeposit(25.5).ok && !parseDefaultDeposit("2500").ok && !parseDefaultDeposit(-5).ok, "not whole cents refused");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
