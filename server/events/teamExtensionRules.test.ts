/**
 * p4-team step 7: stay longer rules with no database. Run: npx tsx server/events/teamExtensionRules.test.ts
 * Calls 43 (pay choices), 45 (open at least 30 minutes), 46 (limits, $10,000 role cap), 47 (To be discussed reminders).
 */
import { computeRolePay, extraLine, type Extra, type PaySetting } from "./teamPay";
import { amountReminderDue, durationText, expiryFor, moneyText, morningAfter, parseAsk, payText, STAY_LONGER_ROLES } from "./teamExtensions";

let passed = 0, failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`, JSON.stringify(actual), "expected", JSON.stringify(expected)); }
}
const H = 3600e3, MIN = 60e3, DAY = 24 * H;
const fixed = (c: number): PaySetting => ({ payType: "fixed", fixedCents: c, hourlyCents: null, commissionBps: null });
const hourly = (c: number): PaySetting => ({ payType: "hourly", fixedCents: null, hourlyCents: c, commissionBps: null });
const none: PaySetting = { payType: "none", fixedCents: null, hourlyCents: null, commissionBps: null };
const x = (payKind: Extra["payKind"], minutes: number, o: Partial<Extra> = {}): Extra => ({ id: `x${minutes}${payKind}`, minutes, payKind, fixedCents: null, finalCents: null, ...o });
const shift = (hours: number) => ({ startsAt: "2026-11-07T03:00:00.000Z", endsAt: new Date(Date.parse("2026-11-07T03:00:00.000Z") + hours * H).toISOString() });

console.log("who can be asked (call 41)");
eq([...STAY_LONGER_ROLES].sort(), ["door", "entertainment", "media", "other", "security"], "Admissions, Security, Entertainment, Media, Other; never Promoters or co-hosts");

console.log("wording");
eq([30, 45, 60, 90, 120, 135, 360].map(durationText),
  ["30 more minutes", "45 more minutes", "1 more hour", "1 more hour and 30 minutes", "2 more hours", "2 more hours and 15 minutes", "6 more hours"], "durations");
eq([moneyText(5000), moneyText(100000), moneyText(1)], ["$50.00", "$1,000.00", "$0.01"], "money");
eq([payText("fixed", 5000), payText("hourly", null), payText("tbd", null), payText("none", null)],
  ["$50.00 extra", "paid at your hourly rate", "extra pay to be discussed", "no extra pay"], "pay choices");

console.log("open at least 30 minutes (call 45)");
const sent = new Date("2026-11-07T06:00:00Z");
eq(expiryFor(new Date(sent.getTime() + 5 * MIN), sent).toISOString(), new Date(sent.getTime() + 30 * MIN).toISOString(), "their end in 5 minutes: open 30");
eq(expiryFor(new Date(sent.getTime() + 30 * MIN), sent).toISOString(), new Date(sent.getTime() + 30 * MIN).toISOString(), "exactly 30");
eq(expiryFor(new Date(sent.getTime() + 2 * H), sent).toISOString(), new Date(sent.getTime() + 2 * H).toISOString(), "their end in 2 hours: open until then");

console.log("what the host sends");
eq(parseAsk({ minutes: 60, pay: "fixed", fixedCents: 5000 }).ok, true, "minutes + Fixed");
eq(parseAsk({ endAt: "2026-11-07T08:00:00Z", pay: "tbd" }).ok, true, "end time + To be discussed");
eq(parseAsk({ minutes: 60, pay: "fixed", fixedCents: 100000 }).ok, true, "Fixed $1,000");
for (const [b, why] of [
  [{ minutes: 60, pay: "fixed", fixedCents: 100001 }, "Fixed over $1,000"], [{ minutes: 60, pay: "fixed", fixedCents: 0 }, "Fixed $0"],
  [{ minutes: 60, pay: "fixed", fixedCents: 10.5 }, "part cents"], [{ minutes: 60, pay: "fixed" }, "Fixed with no amount"],
  [{ minutes: 60, pay: "none", fixedCents: 100 }, "an amount without Fixed"], [{ minutes: 60, pay: "bonus" }, "unknown pay"],
  [{ minutes: 60.5, pay: "none" }, "part minutes"], [{ pay: "none" }, "no time"], [{ minutes: 60, endAt: "2026-11-07T08:00:00Z", pay: "none" }, "both"],
  [{ endAt: "soon", pay: "none" }, "bad end time"], [{ minutes: 60, pay: "none", note: "x" }, "unknown field"], [null, "no body"],
] as const) eq(parseAsk(b).ok, false, `refused: ${why}`);

console.log("extra pay (calls 43, 47)");
eq(extraLine(fixed(16000), x("fixed", 60, { fixedCents: 5000 })).cents, 5000, "Fixed: its amount");
eq(extraLine(fixed(16000), x("none", 60)).cents, 0, "No extra pay: $0");
eq(extraLine(none, x("tbd", 60)), { id: "x60tbd", minutes: 60, payKind: "tbd", cents: null, tbd: true }, "To be discussed, not entered: no amount yet");
eq(extraLine(none, x("tbd", 60, { finalCents: 9000 })).cents, 9000, "To be discussed, entered: that amount");
eq(extraLine(none, x("tbd", 60, { finalCents: 0 })).cents, 0, "entered as $0");
eq(extraLine(hourly(5000), x("hourly", 90)).cents, 7500, "hourly rate x 1.5 hours");
eq(extraLine(hourly(3333), x("hourly", 45)).cents, 2500, "rounded to the cent");
eq(extraLine({ payType: "fixed", fixedCents: 16000, hourlyCents: 5000, commissionBps: null }, x("hourly", 60)).cents, 0, "hourly kind after their pay stopped being hourly: $0");

console.log("in the role's pay");
let r = computeRolePay(fixed(16000), null, 0, [x("fixed", 60, { fixedCents: 5000 })]);
eq([r.extraCents, r.totalCents, r.extraCapped], [5000, 21000, false], "$160 + $50 = $210");
r = computeRolePay(hourly(5000), shift(2), 0, [x("hourly", 90), x("none", 30)]);
eq([r.hourlyCents, r.extraCents, r.totalCents], [10000, 7500, 17500], "hourly: shift $100 + 1.5 hours $75");
r = computeRolePay(none, null, 0, [x("tbd", 60)]);
eq([r.extraCents, r.totalCents, r.extras.length], [0, 0, 1], "To be discussed not entered adds $0");
r = computeRolePay(fixed(990000), null, 0, [x("fixed", 60, { fixedCents: 20000 })]);
eq([r.extraCents, r.totalCents, r.extraCapped], [10000, 1000000, true], "role cap: $9,900 + $200 stops at $10,000 (call 46)");
r = computeRolePay({ payType: "fixed", fixedCents: 1000000, hourlyCents: null, commissionBps: 1000 }, null, 10000, [x("fixed", 60, { fixedCents: 5000 })]);
eq([r.extraCents, r.commissionCents, r.totalCents], [0, 1000, 1001000], "commission stays on top of the cap");
r = computeRolePay(fixed(16000), null, 0);
eq([r.extraCents, r.extras, r.extraCapped], [0, [], false], "no requests: nothing changes");

console.log("To be discussed reminders (call 47)");
// Ends 11:00 PM in New York (04:00 UTC next day), Saturday Nov 7 2026 (after the clocks change on Nov 1).
const end = new Date("2026-11-08T04:00:00Z");
eq(morningAfter(end, "America/New_York").toISOString(), "2026-11-08T15:00:00.000Z", "ends 11 PM: 10 AM the next day");
eq(morningAfter(new Date("2026-11-08T07:00:00Z"), "America/New_York").toISOString(), "2026-11-08T15:00:00.000Z", "ends 2 AM: 10 AM that morning");
eq(morningAfter(new Date("2026-11-08T12:00:00Z"), "America/New_York").toISOString(), "2026-11-09T15:00:00.000Z", "ends 7 AM: 10 AM the day after");
eq(morningAfter(new Date("2026-11-08T07:00:00Z"), "America/Los_Angeles").toISOString(), "2026-11-08T18:00:00.000Z", "the event's time zone");
eq(morningAfter(new Date("2026-03-08T05:00:00Z"), "America/New_York").toISOString(), "2026-03-08T14:00:00.000Z", "clocks change that night");
eq(morningAfter(end, "Not/AZone").toISOString(), "2026-11-08T15:00:00.000Z", "a bad time zone reads as New York");
const due = (at: number, s = { morning: false, eve: false }) => amountReminderDue(end, "America/New_York", new Date(at), s);
eq(due(end.getTime() + H), null, "right after: nothing");
eq(due(Date.parse("2026-11-08T14:59:00Z")), null, "9:59 AM: not yet");
eq(due(Date.parse("2026-11-08T15:00:00Z")), "morning", "10 AM the next day");
eq(due(Date.parse("2026-11-08T15:00:00Z"), { morning: true, eve: false }), null, "once");
eq(due(end.getTime() + 2 * DAY - MIN, { morning: true, eve: false }), null, "not yet the day before payout day");
eq(due(end.getTime() + 2 * DAY, { morning: true, eve: false }), "eve", "the day before payout day");
eq(due(end.getTime() + 2 * DAY + H), "eve", "a late morning one is skipped for the eve one");
eq(due(end.getTime() + 2 * DAY + H, { morning: true, eve: true }), null, "both sent");
eq(due(end.getTime() + 3 * DAY), null, "payout time: too late, it's $0");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
