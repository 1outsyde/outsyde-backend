/**
 * p4-team step 4a: Event team pay maths (no database). Run: npx tsx server/events/teamPay.test.ts
 *
 * Rules (Legend 2026-10-29 / 2026-10-30): no pay, fixed, or hourly (exact hours of the shift the host set x rate),
 * plus commission for Promoters (role 'host') and Entertainment on ticket price sold through their own link.
 * Limits: fixed up to $10,000 per role, hourly up to $1,000 an hour, commission 1% to 50%. All or nothing: if the team
 * is owed more than the host's earnings, Outsyde pays the team $0 and the host keeps everything.
 */
import { computeRolePay, coverage, parsePay, LINK_ROLES } from "./teamPay";

let passed = 0, failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`, JSON.stringify(actual), "expected", JSON.stringify(expected)); }
}
const H = 3600000;
const shift = (hours: number) => ({ startsAt: "2026-11-07T03:00:00.000Z", endsAt: new Date(Date.parse("2026-11-07T03:00:00.000Z") + hours * H).toISOString() });

console.log("link roles");
eq([...LINK_ROLES].sort(), ["entertainment", "host"], "Promoters (host) and Entertainment get links");

console.log("fixed");
let r = computeRolePay({ payType: "fixed", fixedCents: 16000, hourlyCents: null, commissionBps: null }, null, 0);
eq([r.fixedCents, r.hourlyCents, r.commissionCents, r.totalCents, r.needsShift], [16000, 0, 0, 16000, false], "$160 fixed, no sales needed");

console.log("hourly (exact hours)");
r = computeRolePay({ payType: "hourly", fixedCents: null, hourlyCents: 5000, commissionBps: null }, shift(4), 0);
eq([r.hours, r.hourlyCents, r.totalCents], [4, 20000, 20000], "$50 x 4 h = $200");
r = computeRolePay({ payType: "hourly", fixedCents: null, hourlyCents: 5000, commissionBps: null }, shift(4.5), 0);
eq([r.hours, r.hourlyCents, r.totalCents], [4.5, 22500, 22500], "$50 x 4.5 h = $225 (Legend's example)");
r = computeRolePay({ payType: "hourly", fixedCents: null, hourlyCents: 3333, commissionBps: null }, shift(1 + 20 / 60), 0);
eq([r.hours, r.hourlyCents], [1.33, 4444], "$33.33 x 1 h 20 min = $44.44 (rounded to the cent)");
r = computeRolePay({ payType: "hourly", fixedCents: null, hourlyCents: 5000, commissionBps: null }, null, 0);
eq([r.needsShift, r.hourlyCents, r.totalCents], [true, 0, 0], "hourly without shift times: $0 and flagged");
r = computeRolePay({ payType: "hourly", fixedCents: null, hourlyCents: 5000, commissionBps: null }, { startsAt: "2026-11-07T03:00:00.000Z", endsAt: null }, 0);
eq([r.needsShift, r.totalCents], [true, 0], "hourly with only a start: flagged");

console.log("commission");
r = computeRolePay({ payType: "none", fixedCents: null, hourlyCents: null, commissionBps: 1000 }, null, 30000);
eq([r.commissionPercent, r.commissionCents, r.totalCents], [10, 3000, 3000], "10% of $300 through the link = $30");
r = computeRolePay({ payType: "fixed", fixedCents: 10000, hourlyCents: null, commissionBps: 1250 }, null, 9999);
eq([r.commissionCents, r.totalCents], [1250, 11250], "12.5% of $99.99 = $12.50 (half up), plus $100 fixed");
r = computeRolePay({ payType: "hourly", fixedCents: null, hourlyCents: 5000, commissionBps: 500 }, shift(2), 0);
eq([r.commissionCents, r.totalCents], [0, 10000], "commission on no sales = $0, hourly still counts");
r = computeRolePay({ payType: "none", fixedCents: null, hourlyCents: null, commissionBps: null }, null, 50000);
eq([r.totalCents, r.commissionPercent], [0, null], "no pay set: $0 even with sales");

console.log("all or nothing");
eq(coverage(39000, 98000), { covered: true, teamPaidCents: 39000, hostTakeHomeCents: 59000 }, "$390 team out of $980: team paid, host $590");
eq(coverage(98000, 98000), { covered: true, teamPaidCents: 98000, hostTakeHomeCents: 0 }, "team exactly equals earnings: paid, host $0");
eq(coverage(120000, 98000), { covered: false, teamPaidCents: 0, hostTakeHomeCents: 98000 }, "team owed more than the event made: team $0, host everything");
eq(coverage(16000, 0), { covered: false, teamPaidCents: 0, hostTakeHomeCents: 0 }, "free event with fixed pay: Outsyde pays nothing");
eq(coverage(0, 0), { covered: true, teamPaidCents: 0, hostTakeHomeCents: 0 }, "nothing owed: nothing to cover");

console.log("what the host can set");
eq(parsePay("security", { payType: "fixed", fixedCents: 16000 }), { ok: true, value: { payType: "fixed", fixedCents: 16000, hourlyCents: null, commissionBps: null } }, "fixed");
eq(parsePay("entertainment", { payType: "hourly", hourlyCents: 5000, commissionPercent: 10 }), { ok: true, value: { payType: "hourly", fixedCents: null, hourlyCents: 5000, commissionBps: 1000 } }, "DJ hourly plus 10%");
eq(parsePay("host", { payType: "none", commissionPercent: 12.5 }), { ok: true, value: { payType: "none", fixedCents: null, hourlyCents: null, commissionBps: 1250 } }, "promoter commission only, 12.5%");
eq(parsePay("door", { payType: "none" }), { ok: true, value: { payType: "none", fixedCents: null, hourlyCents: null, commissionBps: null } }, "no pay");
const bad = (role: string, body: unknown) => (parsePay(role, body) as any).ok === false;
eq(bad("security", { payType: "fixed" }), true, "fixed needs an amount");
eq(bad("security", { payType: "fixed", fixedCents: 0 }), true, "fixed $0 refused");
eq(bad("security", { payType: "fixed", fixedCents: 1000001 }), true, "fixed over $10,000 refused");
eq(bad("security", { payType: "fixed", fixedCents: 1000000 }), false, "fixed $10,000 allowed");
eq(bad("security", { payType: "fixed", fixedCents: 12.5 }), true, "cents must be whole");
eq(bad("security", { payType: "hourly", hourlyCents: 100001 }), true, "hourly over $1,000 refused");
eq(bad("security", { payType: "hourly", hourlyCents: 100000 }), false, "hourly $1,000 allowed");
eq(bad("security", { payType: "fixed", fixedCents: 100, hourlyCents: 100 }), true, "fixed with an hourly rate refused");
eq(bad("security", { payType: "hourly", hourlyCents: 100, fixedCents: 100 }), true, "hourly with a fixed amount refused");
eq(bad("security", { payType: "none", fixedCents: 100 }), true, "no pay with an amount refused");
eq(bad("security", { payType: "none", commissionPercent: 10 }), true, "commission refused for Security");
eq(bad("door", { payType: "none", commissionPercent: 10 }), true, "commission refused for Admissions");
eq(bad("cohost", { payType: "none", commissionPercent: 10 }), true, "commission refused for co-hosts");
eq(bad("host", { payType: "none", commissionPercent: 0.5 }), true, "commission under 1% refused");
eq(bad("host", { payType: "none", commissionPercent: 50.01 }), true, "commission over 50% refused");
eq(bad("host", { payType: "none", commissionPercent: 50 }), false, "commission 50% allowed");
eq(bad("host", { payType: "none", commissionPercent: 10.555 }), true, "commission with more than 2 decimals refused");
eq(bad("host", { payType: "salary" }), true, "unknown pay type refused");
eq(bad("host", { payType: "none", extra: 1 }), true, "unknown field refused");
eq(bad("host", null), true, "no body refused");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
