/**
 * p4-team step 6: reminder timing and copy for everyone at the event (canvas screen 58; Legend calls 34 to 40).
 * Pure, no database. Run: npx tsx server/events/teamReminderRules.test.ts
 */
import {
  dueAnchored, doorsDue, momentOfKind, teamAnchor, guestWeekCopy, guestStartCopy, hostCopy, teamReminderCopy, teamKindsToReset,
  WEEK_MS, START_LATE_MS,
} from "./eventReminderRules";

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, JSON.stringify(actual), "expected", JSON.stringify(expected)); }
}
const H = 3600e3, MIN = 60e3, DAY = 24 * H;
// Saturday Oct 24 2026, 9:00 PM in New York (EDT, UTC-4).
const start = new Date("2026-10-25T01:00:00Z");
const t = (iso: string) => new Date(iso);
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const e = { title: "Rooftop Night", starts_at: start, timezone: "America/New_York", city: "Freeport", state: "NY", venue_name: "The Loft" };

console.log("windows");
eq(WEEK_MS, 7 * DAY, "a week is 7 days");
eq(START_LATE_MS, 30 * MIN, "doors open can be 30 minutes late at most");
eq(dueAnchored(start, at(start, -7 * DAY)), "week", "exactly 7 days before: week");
eq(dueAnchored(start, at(start, -7 * DAY - 1)), null, "earlier than 7 days: nothing");
eq(dueAnchored(start, at(start, -DAY - 1)), "week", "just over a day before: still week");
eq(dueAnchored(start, at(start, -DAY)), "day_before", "24 hours before: day before");
eq(dueAnchored(start, at(start, -2 * H - 1)), "day_before", "just over 2 hours: day before");
eq(dueAnchored(start, at(start, -2 * H)), "soon", "2 hours before: soon");
eq(dueAnchored(start, at(start, -1)), "soon", "a moment before: soon");
eq(dueAnchored(start, start), null, "at the time: nothing");
eq(doorsDue(start, at(start, -1)), false, "doors: not before the start");
eq(doorsDue(start, start), true, "doors: at the start");
eq(doorsDue(start, at(start, 30 * MIN)), true, "doors: 30 minutes late is fine");
eq(doorsDue(start, at(start, 30 * MIN + 1)), false, "doors: later is skipped (call 37)");
eq(momentOfKind("week", start, start).toISOString(), at(start, -7 * DAY).toISOString(), "week moment");
eq(momentOfKind("day_before", start, start).toISOString(), at(start, -DAY).toISOString(), "day before moment");
eq(momentOfKind("soon", start, start).toISOString(), at(start, -2 * H).toISOString(), "soon moment");
eq(momentOfKind("start", at(start, -H), start).toISOString(), start.toISOString(), "doors moment is the event start");

console.log("which time counts (call 35)");
const shift = { startsAt: t("2026-10-25T00:00:00Z"), endsAt: t("2026-10-25T06:00:00Z"), callAt: t("2026-10-24T23:30:00Z"), loadInAt: null, placeNote: null };
eq(teamAnchor("door", shift, start).toISOString(), "2026-10-25T00:00:00.000Z", "Admissions: shift start");
eq(teamAnchor("security", shift, start).toISOString(), "2026-10-24T23:30:00.000Z", "Security: call time");
eq(teamAnchor("security", { ...shift, callAt: null }, start).toISOString(), "2026-10-25T00:00:00.000Z", "Security without a call time: the first time set");
eq(teamAnchor("entertainment", { startsAt: t("2026-10-25T03:00:00Z"), endsAt: null, callAt: null, loadInAt: t("2026-10-25T02:00:00Z"), placeNote: null }, start).toISOString(),
  "2026-10-25T02:00:00.000Z", "Entertainment: load in");
eq(teamAnchor("media", { startsAt: t("2026-10-25T02:00:00Z"), endsAt: null, callAt: t("2026-10-25T01:30:00Z"), loadInAt: null, placeNote: null }, start).toISOString(),
  "2026-10-25T01:30:00.000Z", "Media: the first time set");
eq(teamAnchor("security", { startsAt: t("2026-10-24T22:00:00Z"), endsAt: null, callAt: t("2026-10-25T00:00:00Z"), loadInAt: null, placeNote: null }, start).toISOString(),
  "2026-10-25T00:00:00.000Z", "Security: call time even when another time is earlier");
eq(teamAnchor("entertainment", { startsAt: t("2026-10-25T01:00:00Z"), endsAt: null, callAt: null, loadInAt: t("2026-10-25T02:00:00Z"), placeNote: null }, start).toISOString(),
  "2026-10-25T02:00:00.000Z", "Entertainment: load in even when the set is earlier");
eq(teamAnchor("security", null, start).toISOString(), start.toISOString(), "nothing set: the event start");
eq(teamAnchor("host", shift, start).toISOString(), start.toISOString(), "Promoter: the event start");
eq(teamAnchor("cohost", shift, start).toISOString(), start.toISOString(), "Co-host: the event start (host reminders)");

console.log("ticket holders (screen 58 row 1)");
eq(guestWeekCopy(e, at(start, -7 * DAY)), { title: "Rooftop Night is one week away", body: "Sat, Oct 24 at 9:00 PM in Freeport, NY. Your ticket is in the app." }, "7 days");
eq(guestWeekCopy({ ...e, city: null, state: null }, at(start, -7 * DAY)).body, "Sat, Oct 24 at 9:00 PM. Your ticket is in the app.", "7 days, no city");
eq(guestStartCopy(e), { title: "Doors just opened at Rooftop Night", body: "Have your ticket ready at the door." }, "doors open");

console.log("host and co-hosts (row 2)");
eq(hostCopy("week", e, 84, 6, at(start, -7 * DAY)), { title: "Rooftop Night is one week away", body: "84 going. Tap to check your team and ticket sales." }, "7 days");
eq(hostCopy("day_before", e, 112, 6, at(start, -DAY)), { title: "Your event is tomorrow: Rooftop Night", body: "112 going. Tap to see your guests and manage the event." }, "day before (same as today)");
eq(hostCopy("soon", e, 112, 6, at(start, -2 * H)), { title: "Rooftop Night starts in 2 hours", body: "Your team of 6 has the call times. Tap to message them." }, "2 hours");
eq(hostCopy("soon", e, 112, 1, at(start, -2 * H)).body, "Your team of 1 has the call times. Tap to message them.", "2 hours, team of 1");
eq(hostCopy("soon", e, 112, 0, at(start, -2 * H)).body, "112 going. Tap to see your guests.", "2 hours, no team");
eq(hostCopy("soon", e, 112, 6, at(start, -60 * MIN)).title, "Rooftop Night starts soon", "late 2 hour push: starts soon");
eq(hostCopy("start", e, 112, 6, start), { title: "Doors just opened", body: "Tap to watch check ins live." }, "doors open");

const ctx = (role: any, kind: any, s: any, over: Record<string, unknown> = {}) => teamReminderCopy(kind, role, {
  title: e.title, timezone: e.timezone, eventStart: start, venueName: "The Loft", roleLabel: null, schedule: s, linkSold: null,
  anchor: teamAnchor(role, s, start), now: at(teamAnchor(role, s, start), kind === "week" ? -7 * DAY : kind === "day_before" ? -DAY : kind === "soon" ? -2 * H : 0), ...over,
});

console.log("Admissions (row 3, shift 8:00 PM to 2:00 AM)");
const adm = { startsAt: t("2026-10-25T00:00:00Z"), endsAt: t("2026-10-25T06:00:00Z"), callAt: null, loadInAt: null, placeNote: null };
eq(ctx("door", "week", adm), { title: "Admissions at Rooftop Night next Saturday", body: "Your shift is 8:00 PM to 2:00 AM." }, "7 days");
eq(ctx("door", "day_before", adm), { title: "Tomorrow: Admissions at Rooftop Night", body: "Shift 8:00 PM to 2:00 AM at The Loft." }, "day before");
eq(ctx("door", "soon", adm), { title: "Your shift starts in 2 hours", body: "8:00 PM at The Loft. Tap to open the scanner." }, "2 hours");
eq(ctx("door", "start", adm), { title: "Doors just opened", body: "Guests are arriving. Tap to open the scanner." }, "doors open");
eq(ctx("door", "week", { ...adm, endsAt: null }).body, "Your shift starts at 8:00 PM.", "no end time");

console.log("Security (row 4, call time 8:00 PM)");
const sec = { startsAt: null, endsAt: null, callAt: t("2026-10-25T00:00:00Z"), loadInAt: null, placeNote: "Side entrance on Main St" };
eq(ctx("security", "week", sec), { title: "Security at Rooftop Night next Saturday", body: "Call time 8:00 PM." }, "7 days");
eq(ctx("security", "day_before", sec), { title: "Tomorrow: Security at Rooftop Night", body: "Call time 8:00 PM. Side entrance on Main St." }, "day before, with where to go");
eq(ctx("security", "soon", sec), { title: "Call time in 2 hours", body: "8:00 PM at The Loft. Side entrance on Main St." }, "2 hours");
eq(ctx("security", "start", sec), { title: "Doors just opened", body: "Guests are arriving. Check From the host for any changes." }, "doors open");
eq(ctx("security", "soon", sec, { now: t("2026-10-24T23:15:00Z") }).title, "Call time soon", "late 2 hour push: soon");
eq(ctx("security", "day_before", sec, { now: t("2026-10-24T14:00:00Z") }).title, "Today: Security at Rooftop Night", "late day before push on the day: Today");

console.log("Promoter (row 5, event start)");
eq(ctx("host", "week", null, { linkSold: 40 }), { title: "Rooftop Night is one week away", body: "40 tickets sold through your link so far. Keep sharing." }, "7 days");
eq(ctx("host", "week", null, { linkSold: 1 }).body, "1 ticket sold through your link so far. Keep sharing.", "one ticket");
eq(ctx("host", "day_before", null, { linkSold: 96 }), { title: "Rooftop Night is tomorrow", body: "96 tickets sold through your link. Last day to share it." }, "day before");
eq(ctx("host", "soon", null, { linkSold: 96 }), { title: "Rooftop Night starts in 2 hours", body: "Tickets are still on sale. Share your link." }, "2 hours");
eq(ctx("host", "start", null, { linkSold: 120 }), { title: "Doors just opened", body: "120 tickets sold through your link. Thank you for promoting." }, "doors open");

console.log("Entertainment / DJ (row 6, set 11:00 PM to 1:00 AM, load in 10:00 PM)");
const dj = { startsAt: t("2026-10-25T03:00:00Z"), endsAt: t("2026-10-25T05:00:00Z"), callAt: null, loadInAt: t("2026-10-25T02:00:00Z"), placeNote: "Back door on Main St" };
eq(ctx("entertainment", "week", dj), { title: "Your set at Rooftop Night is next Saturday", body: "11:00 PM to 1:00 AM." }, "7 days");
eq(ctx("entertainment", "day_before", dj), { title: "Tomorrow: your set at Rooftop Night", body: "11:00 PM to 1:00 AM. Load in 10:00 PM. Back door on Main St." }, "day before");
eq(ctx("entertainment", "soon", dj), { title: "Load in is in 2 hours", body: "10:00 PM at The Loft. Back door on Main St." }, "2 hours");
eq(ctx("entertainment", "start", dj), { title: "Doors just opened", body: "Your set starts at 11:00 PM." }, "doors open");
const djNoLoad = { ...dj, loadInAt: null };
eq(ctx("entertainment", "soon", djNoLoad).title, "Your set starts in 2 hours", "no load in: counts from the set");

console.log("Media and Other (call 34)");
const media = { startsAt: null, endsAt: null, callAt: t("2026-10-25T00:30:00Z"), loadInAt: null, placeNote: null };
eq(ctx("media", "week", media), { title: "Media at Rooftop Night next Saturday", body: "Your time is 8:30 PM." }, "Media 7 days");
eq(ctx("media", "day_before", media), { title: "Tomorrow: Media at Rooftop Night", body: "8:30 PM at The Loft." }, "Media day before");
eq(ctx("media", "soon", media), { title: "Media at Rooftop Night in 2 hours", body: "8:30 PM at The Loft." }, "Media 2 hours");
eq(ctx("other", "week", media, { roleLabel: "Bartender" }).title, "Bartender at Rooftop Night next Saturday", "Other uses the host's name for the role");
eq(ctx("media", "start", media), { title: "Doors just opened", body: "Guests are arriving." }, "doors open");
eq(ctx("media", "day_before", media, { venueName: null }).body, "8:30 PM.", "no venue name");

console.log("review fixes");
const A = t("2026-10-25T00:00:00Z");
eq(teamKindsToReset(A, A, at(A, -10 * DAY)), [], "same time: nothing resets");
eq(teamKindsToReset(A, at(A, -H), at(A, -10 * DAY)), ["week", "day_before", "soon"], "moved, all ahead: all reset");
eq(teamKindsToReset(A, at(A, H), at(A, -3 * DAY)), ["day_before", "soon"], "inside the week window: the 7 day one isn't sent twice");
eq(teamKindsToReset(A, at(A, H), at(A, -H - MIN)), ["soon"], "inside the day before window: only the 2 hour one");
eq(teamKindsToReset(A, at(A, -H), at(A, -H)), [], "all moments passed: nothing");
eq(ctx("security", "week", { startsAt: t("2026-10-25T00:00:00Z"), endsAt: null, callAt: null, loadInAt: null, placeNote: null }),
  { title: "Security at Rooftop Night next Saturday", body: "Your time is 8:00 PM." }, "Security with no call time: never says Call time");
eq(ctx("door", "soon", { startsAt: null, endsAt: null, callAt: t("2026-10-25T00:00:00Z"), loadInAt: null, placeNote: null }).title,
  "Admissions at Rooftop Night in 2 hours", "Admissions with only a call time: plain wording");
eq(ctx("host", "week", null, { linkSold: 0, linkRsvps: 12 }).body, "12 RSVPs through your link so far. Keep sharing.", "free event: RSVPs, not tickets sold");
eq(ctx("host", "week", null, { linkSold: 0, linkRsvps: 1 }).body, "1 RSVP through your link so far. Keep sharing.", "one RSVP");
const late = { startsAt: t("2026-10-25T05:00:00Z"), endsAt: null, callAt: null, loadInAt: t("2026-10-25T04:30:00Z"), placeNote: null }; // 1:00 AM Sunday
eq(ctx("entertainment", "week", late).title, "Your set at Rooftop Night is next Saturday", "a time after midnight still names the event's day");

console.log("no dashes anywhere");
const roles = ["door", "security", "host", "entertainment", "media", "other"] as const;
const kinds = ["week", "day_before", "soon", "start"] as const;
const all: string[] = [];
for (const r of roles) for (const k of kinds) for (const s of [null, adm, sec, dj, media]) {
  const c = ctx(r, k, s, { linkSold: 3, roleLabel: r === "other" ? "Bartender" : null });
  all.push(c.title, c.body);
}
for (const k of kinds) { const c = hostCopy(k, e, 5, 2, at(start, -H)); all.push(c.title, c.body); }
all.push(...Object.values(guestWeekCopy(e, at(start, -7 * DAY))), ...Object.values(guestStartCopy(e)));
eq(all.filter((x) => /[–—]| - /.test(x)), [], "no dashes");
eq(all.filter((x) => /\d\s*%/.test(x)), [], "no percentages");
eq(all.filter((x) => /undefined|null|NaN|Invalid/.test(x)), [], "no missing values printed");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
