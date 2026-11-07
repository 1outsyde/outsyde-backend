/**
 * Payment method policy (app payment methods, Step 1 Task 1). Pure: no database, no Stripe.
 * Run with: npx tsx server/stripe/paymentMethodPolicy.test.ts
 */
import { automaticPaymentMethods, wantsRedirects } from "./paymentMethodPolicy";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("automaticPaymentMethods");
assert(same(automaticPaymentMethods(false), { enabled: true, allow_redirects: "never" }), "off keeps today's settings", automaticPaymentMethods(false));
assert(same(automaticPaymentMethods(true), { enabled: true }), "on lets Stripe offer redirect methods", automaticPaymentMethods(true));

console.log("wantsRedirects");
assert(wantsRedirects({ redirectCapable: true }) === true, "true only for the boolean true");
assert(wantsRedirects({}) === false, "missing is false");
assert(wantsRedirects({ redirectCapable: "true" }) === false, "the string \"true\" is false");
assert(wantsRedirects({ redirectCapable: 1 }) === false, "1 is false");
assert(wantsRedirects(null) === false, "null body is false");
assert(wantsRedirects(undefined) === false, "undefined body is false");
assert(wantsRedirects("redirectCapable") === false, "a string body is false");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
