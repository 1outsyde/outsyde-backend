/**
 * Event reminder timing and copy (Events canvas screen 36). Run: npx tsx server/events/eventReminderRules.test.ts
 * Mutation checks:
 *  - change `<` to `<=` on the soon end in dueKind → "at the start: nothing" fails.
 *  - compare UTC days instead of the event's own days → the Los Angeles checks fail.
 *  - drop the 90 minute rule → "late 2 hour push says starts soon" fails.
 *  - always say Tomorrow → "late day before push says Today" fails.
 */
import { dueKind, reminderMoment, guestReminderCopy, hostReminderCopy, DAY_BEFORE_MS, SOON_MS } from "./eventReminderRules";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
function eq(actual: unknown, expected: unknown, name: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), name, { actual, expected });
}

const H = 3600e3;
const MIN = 60e3;
// Friday Oct 30 2026, 9:00 PM in New York (EDT).
const start = new Date("2026-10-31T01:00:00Z");
const at = (ms: number) => new Date(start.getTime() + ms);
const ev = { title: "Rooftop Night", starts_at: start, timezone: "America/New_York", city: "Freeport", state: "NY" };

// dueKind windows
eq(DAY_BEFORE_MS, 24 * H, "day before is 24 hours");
eq(SOON_MS, 2 * H, "soon is 2 hours");
eq(dueKind(start, at(-24 * H)), "day_before", "24 hours before: day before");
eq(dueKind(start, at(-2 * H - 1)), "day_before", "just over 2 hours before: still day before");
eq(dueKind(start, at(-2 * H)), "soon", "2 hours before: soon");
eq(dueKind(start, at(-1)), "soon", "1 ms before the start: soon");
eq(dueKind(start, start), null, "at the start: nothing");
eq(dueKind(start, at(5 * MIN)), null, "after the start: nothing");
eq(dueKind(start, at(-24 * H - 1)), null, "more than 24 hours before: nothing");

// moments
eq(reminderMoment(start, "day_before").toISOString(), "2026-10-30T01:00:00.000Z", "day before moment");
eq(reminderMoment(start, "soon").toISOString(), "2026-10-30T23:00:00.000Z", "soon moment");

// guest copy
eq(guestReminderCopy("day_before", ev, at(-24 * H)),
  { title: "Tomorrow: Rooftop Night", body: "Friday at 9:00 PM in Freeport, NY. Your ticket is in the app." },
  "day before copy (screen 36)");
eq(guestReminderCopy("day_before", ev, at(-5 * H)).title, "Today: Rooftop Night", "late day before push says Today");
eq(guestReminderCopy("day_before", { ...ev, city: null, state: null }, at(-24 * H)).body,
  "Friday at 9:00 PM. Your ticket is in the app.", "no city or state: no place");
eq(guestReminderCopy("day_before", { ...ev, city: "  ", state: "NY" }, at(-24 * H)).body,
  "Friday at 9:00 PM in NY. Your ticket is in the app.", "state only");
eq(guestReminderCopy("soon", ev, at(-2 * H)),
  { title: "Rooftop Night starts in 2 hours", body: "Starts at 9:00 PM. Tap for your ticket and directions." },
  "2 hour copy (screen 36)");
eq(guestReminderCopy("soon", ev, at(-90 * MIN)).title, "Rooftop Night starts in 2 hours", "90 minutes left: still 2 hours");
eq(guestReminderCopy("soon", ev, at(-89 * MIN)).title, "Rooftop Night starts soon", "late 2 hour push says starts soon");

// time zones: the event's own calendar day decides Tomorrow / Today
const late = new Date("2026-10-31T04:30:00Z"); // Sat 12:30 AM New York, Fri 9:30 PM Los Angeles
const lateNow = new Date(late.getTime() - 24 * H);
const ny = guestReminderCopy("day_before", { ...ev, starts_at: late }, lateNow);
eq(ny.title, "Tomorrow: Rooftop Night", "12:30 AM New York event: Tomorrow");
eq(ny.body.startsWith("Saturday at 12:30 AM"), true, "12:30 AM New York event: Saturday");
const la = guestReminderCopy("day_before", { ...ev, starts_at: late, timezone: "America/Los_Angeles" }, lateNow);
eq(la.title, "Tomorrow: Rooftop Night", "Los Angeles event: Tomorrow");
eq(la.body.startsWith("Friday at 9:30 PM"), true, "Los Angeles event: Friday 9:30 PM");
const sameDayLa = guestReminderCopy("day_before", { ...ev, starts_at: late, timezone: "America/Los_Angeles" }, new Date(late.getTime() - 3 * H));
eq(sameDayLa.title, "Today: Rooftop Night", "Los Angeles: same local day is Today even though UTC days differ");
eq(guestReminderCopy("soon", { ...ev, timezone: "Not/AZone" }, at(-2 * H)).body, "Starts at 1:00 AM. Tap for your ticket and directions.",
  "bad time zone falls back to UTC");

// host copy
eq(hostReminderCopy(ev, 12, at(-24 * H)),
  { title: "Your event is tomorrow: Rooftop Night", body: "12 going. Tap to see your guests and manage the event." },
  "host copy (screen 36)");
eq(hostReminderCopy(ev, 0, at(-24 * H)).body, "0 going. Tap to see your guests and manage the event.", "host copy with nobody yet");
eq(hostReminderCopy(ev, 3, at(-5 * H)).title, "Your event is today: Rooftop Night", "late host push says today");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
