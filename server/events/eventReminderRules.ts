/**
 * Events & Ticketing: when event reminder pushes are due, and what they say (Events canvas screen 36, approved by
 * Legend 2026-10-26). Pure: no database, no clock. The job is server/events/eventReminders.ts.
 *
 * Guests: a "day before" push from 24 hours before the start until 2 hours before, then a "soon" push until the
 * start. The host: one push in the day before window. Times and days are the event's own time zone. If the job runs
 * late, the copy stays true: "Today" instead of "Tomorrow" on the event's own day, "starts soon" with under 90
 * minutes left. The day before body names the city and state only, never the venue or street (day-of address events
 * keep those hidden until the reveal).
 */

export type ReminderKind = "day_before" | "soon";

export const DAY_BEFORE_MS = 24 * 3600e3;
export const SOON_MS = 2 * 3600e3;
const SAY_TWO_HOURS_MIN_MS = 90 * 60e3;

export function dueKind(startsAt: Date, now: Date): ReminderKind | null {
  const left = startsAt.getTime() - now.getTime();
  if (left <= 0 || left > DAY_BEFORE_MS) return null;
  return left > SOON_MS ? "day_before" : "soon";
}

export function reminderMoment(startsAt: Date, kind: ReminderKind): Date {
  return new Date(startsAt.getTime() - (kind === "day_before" ? DAY_BEFORE_MS : SOON_MS));
}

function zoneOr(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function fmt(d: Date, timeZone: string, o: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...o }).format(d);
}

/** Calendar day (YYYY-MM-DD) of `d` in `timeZone`. */
function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Whole calendar days from `now` to `start`, counted in `timeZone` (0 = same day, 1 = the next day). */
function localDaysApart(now: Date, start: Date, timeZone: string): number {
  const toUtcMidnight = (d: Date) => Date.parse(`${localDay(d, timeZone)}T00:00:00Z`);
  return Math.round((toUtcMidnight(start) - toUtcMidnight(now)) / 86400e3);
}

function clockText(d: Date, timeZone: string): string {
  return fmt(d, timeZone, { hour: "numeric", minute: "2-digit" });
}

function placeText(city?: string | null, state?: string | null): string | null {
  const parts = [city, state].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

type ReminderEvent = { title: string; starts_at: Date | string; timezone: string; city?: string | null; state?: string | null };

export function guestReminderCopy(kind: ReminderKind, e: ReminderEvent, now: Date): { title: string; body: string } {
  const start = new Date(e.starts_at);
  const tz = zoneOr(e.timezone);
  const title = String(e.title);
  if (kind === "soon") {
    const soon = start.getTime() - now.getTime() < SAY_TWO_HOURS_MIN_MS;
    return {
      title: soon ? `${title} starts soon` : `${title} starts in 2 hours`,
      body: `Starts at ${clockText(start, tz)}. Tap for your ticket and directions.`,
    };
  }
  const apart = localDaysApart(now, start, tz);
  // 2 days apart only happens on a daylight saving weekend (24 hours before a 12:30 AM start): name the day.
  const day = apart <= 0 ? "Today" : apart === 1 ? "Tomorrow" : fmt(start, tz, { weekday: "long" });
  const place = placeText(e.city, e.state);
  const when = `${fmt(start, tz, { weekday: "long" })} at ${clockText(start, tz)}`;
  return {
    title: `${day}: ${title}`,
    body: `${when}${place ? ` in ${place}` : ""}. Your ticket is in the app.`,
  };
}

export function hostReminderCopy(e: { title: string; starts_at: Date | string; timezone: string }, going: number, now: Date): { title: string; body: string } {
  const tz = zoneOr(e.timezone);
  const start = new Date(e.starts_at);
  const apart = localDaysApart(now, start, tz);
  const day = apart <= 0 ? "today" : apart === 1 ? "tomorrow" : `on ${fmt(start, tz, { weekday: "long" })}`;
  return {
    title: `Your event is ${day}: ${String(e.title)}`,
    body: `${going} going. Tap to see your guests and manage the event.`,
  };
}

// ─── p4-team step 6: reminders for everyone at the event (canvas screen 58, Legend calls 34 to 40) ─────────────

export type AnyReminderKind = "week" | "day_before" | "soon" | "start";
export const WEEK_MS = 7 * 24 * 3600e3;
/** "Doors just opened" goes out at the start, at most this late; later it is skipped (call 37). */
export const START_LATE_MS = 30 * 60e3;

/** Which of the week / day before / 2 hour reminders is due for something at `anchor`. */
export function dueAnchored(anchor: Date, now: Date): "week" | "day_before" | "soon" | null {
  const left = anchor.getTime() - now.getTime();
  if (left <= 0 || left > WEEK_MS) return null;
  if (left > DAY_BEFORE_MS) return "week";
  return left > SOON_MS ? "day_before" : "soon";
}

/** Doors open: from the start until 30 minutes after it. */
export function doorsDue(eventStart: Date, now: Date): boolean {
  const late = now.getTime() - eventStart.getTime();
  return late >= 0 && late <= START_LATE_MS;
}

/** When a reminder's window opens: people who joined (or got a ticket) after it never get that one (call 36). */
export function momentOfKind(kind: AnyReminderKind, anchor: Date, eventStart: Date): Date {
  if (kind === "start") return eventStart;
  const back = kind === "week" ? WEEK_MS : kind === "day_before" ? DAY_BEFORE_MS : SOON_MS;
  return new Date(anchor.getTime() - back);
}

export type TeamTimes = { startsAt: Date | null; endsAt: Date | null; callAt: Date | null; loadInAt: Date | null; placeNote: string | null };

/**
 * The time a team member's reminders count from (call 35): Admissions their shift start, Security their call time,
 * Entertainment their load in; otherwise the first time the host set for them; nothing set: the event start.
 * Promoters and co-hosts count from the event start.
 */
export function teamAnchor(role: string, s: TeamTimes | null, eventStart: Date): Date {
  if (role === "host" || role === "cohost" || !s) return eventStart;
  const pick = role === "door" ? s.startsAt : role === "security" ? s.callAt : role === "entertainment" ? s.loadInAt : null;
  if (pick) return new Date(pick);
  const set = [s.callAt, s.startsAt, s.loadInAt].filter((d): d is Date => !!d).map((d) => new Date(d).getTime());
  return set.length ? new Date(Math.min(...set)) : eventStart;
}

/** "Tomorrow" / "Today" / a weekday, counted in the event's time zone (same rule as the guest day before push). */
function dayWord(now: Date, when: Date, tz: string): string {
  const apart = localDaysApart(now, when, tz);
  return apart <= 0 ? "Today" : apart === 1 ? "Tomorrow" : fmt(when, tz, { weekday: "long" });
}
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const isSoon = (anchor: Date, now: Date) => anchor.getTime() - now.getTime() < SAY_TWO_HOURS_MIN_MS;

export function guestWeekCopy(e: ReminderEvent, _now: Date): { title: string; body: string } {
  const tz = zoneOr(e.timezone);
  const start = new Date(e.starts_at);
  const place = placeText(e.city, e.state);
  return {
    title: `${String(e.title)} is one week away`,
    body: `${fmt(start, tz, { weekday: "short", month: "short", day: "numeric" })} at ${clockText(start, tz)}${place ? ` in ${place}` : ""}. Your ticket is in the app.`,
  };
}

export function guestStartCopy(e: { title: string }): { title: string; body: string } {
  return { title: `Doors just opened at ${String(e.title)}`, body: "Have your ticket ready at the door." };
}

/** The host's (and each co-host's) reminders. `team` = people who accepted a spot. */
export function hostCopy(kind: AnyReminderKind, e: { title: string; starts_at: Date | string; timezone: string }, going: number, team: number, now: Date): { title: string; body: string } {
  const title = String(e.title);
  if (kind === "day_before") return hostReminderCopy(e, going, now);
  if (kind === "week") return { title: `${title} is one week away`, body: `${going} going. Tap to check your team and ticket sales.` };
  if (kind === "soon") {
    return {
      title: isSoon(new Date(e.starts_at), now) ? `${title} starts soon` : `${title} starts in 2 hours`,
      body: team > 0 ? `Your team of ${team} has the call times. Tap to message them.` : `${going} going. Tap to see your guests.`,
    };
  }
  return { title: "Doors just opened", body: "Tap to watch check ins live." };
}

export type TeamCopyContext = {
  title: string; timezone: string; eventStart: Date; anchor: Date; venueName: string | null; roleLabel: string | null;
  schedule: TeamTimes | null; linkSold: number | null; now: Date;
};

/** One team member's reminder, worded for their role (screen 58; call 34 for Entertainment, Media and Other). */
export function teamReminderCopy(kind: AnyReminderKind, role: string, c: TeamCopyContext): { title: string; body: string } {
  const tz = zoneOr(c.timezone);
  const title = String(c.title);
  const clock = (d: Date | null | undefined) => (d ? clockText(new Date(d), tz) : "");
  const s = c.schedule;
  const at = clock(c.anchor);
  const venue = c.venueName && c.venueName.trim() ? c.venueName.trim() : null;
  const atVenue = (time: string) => `${time}${venue ? ` at ${venue}` : ""}.`;
  const place = s?.placeNote && s.placeNote.trim() ? ` ${sentence(s.placeNote)}` : "";
  const nextDay = `next ${fmt(c.anchor, tz, { weekday: "long" })}`;
  const day = dayWord(c.now, c.anchor, tz);
  const soon = isSoon(c.anchor, c.now);
  const doors = { title: "Doors just opened", body: "Guests are arriving." };

  if (role === "door") {
    const range = s?.startsAt && s?.endsAt ? `${clock(s.startsAt)} to ${clock(s.endsAt)}` : null;
    if (kind === "week") return { title: `Admissions at ${title} ${nextDay}`, body: range ? `Your shift is ${range}.` : `Your shift starts at ${at}.` };
    if (kind === "day_before") return { title: `${day}: Admissions at ${title}`, body: range ? `Shift ${range}${venue ? ` at ${venue}` : ""}.` : `Shift starts ${atVenue(at)}` };
    if (kind === "soon") return { title: soon ? "Your shift starts soon" : "Your shift starts in 2 hours", body: `${atVenue(at)} Tap to open the scanner.` };
    return { title: doors.title, body: "Guests are arriving. Tap to open the scanner." };
  }
  if (role === "security") {
    if (kind === "week") return { title: `Security at ${title} ${nextDay}`, body: `Call time ${at}.` };
    if (kind === "day_before") return { title: `${day}: Security at ${title}`, body: `Call time ${at}.${place}` };
    if (kind === "soon") return { title: soon ? "Call time soon" : "Call time in 2 hours", body: `${atVenue(at)}${place}` };
    return { title: doors.title, body: "Guests are arriving. Check From the host for any changes." };
  }
  if (role === "host") {
    const n = Math.max(0, Number(c.linkSold ?? 0));
    const sold = `${n} ${n === 1 ? "ticket" : "tickets"} sold through your link`;
    if (kind === "week") return { title: `${title} is one week away`, body: `${sold} so far. Keep sharing.` };
    if (kind === "day_before") return { title: `${title} is ${day === "Tomorrow" ? "tomorrow" : day === "Today" ? "today" : `on ${day}`}`, body: `${sold}. Last day to share it.` };
    if (kind === "soon") return { title: soon ? `${title} starts soon` : `${title} starts in 2 hours`, body: "Tickets are still on sale. Share your link." };
    return { title: doors.title, body: `${sold}. Thank you for promoting.` };
  }
  if (role === "entertainment") {
    const set = s?.startsAt ? (s.endsAt ? `${clock(s.startsAt)} to ${clock(s.endsAt)}` : `Starts at ${clock(s.startsAt)}`) : null;
    const loadIn = s?.loadInAt ? `Load in ${clock(s.loadInAt)}.` : "";
    if (kind === "week") return { title: `Your set at ${title} is ${nextDay}`, body: set ? `${set}.` : `Your time is ${at}.` };
    if (kind === "day_before") return { title: `${day}: your set at ${title}`, body: [set ? `${set}.` : `Your time is ${at}.`, loadIn].filter(Boolean).join(" ") + place };
    if (kind === "soon") {
      const what = s?.loadInAt ? "Load in is" : "Your set starts";
      return { title: soon ? `${what} soon` : `${what} in 2 hours`, body: `${atVenue(at)}${place}` };
    }
    return { title: doors.title, body: s?.startsAt ? `Your set starts at ${clock(s.startsAt)}.` : doors.body };
  }
  // Media, Other, and any role added later: their name for the role and their own time.
  const name = role === "media" ? "Media" : c.roleLabel && c.roleLabel.trim() ? c.roleLabel.trim() : "Event team";
  if (kind === "week") return { title: `${name} at ${title} ${nextDay}`, body: `Your time is ${at}.` };
  if (kind === "day_before") return { title: `${day}: ${name} at ${title}`, body: `${atVenue(at)}${place}` };
  if (kind === "soon") return { title: soon ? `${name} at ${title} soon` : `${name} at ${title} in 2 hours`, body: `${atVenue(at)}${place}` };
  return doors;
}
