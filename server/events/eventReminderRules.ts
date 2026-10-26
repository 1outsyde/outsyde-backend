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

function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return localDay(a, timeZone) === localDay(b, timeZone);
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
  const day = isSameLocalDay(start, now, tz) ? "Today" : "Tomorrow";
  const place = placeText(e.city, e.state);
  const when = `${fmt(start, tz, { weekday: "long" })} at ${clockText(start, tz)}`;
  return {
    title: `${day}: ${title}`,
    body: `${when}${place ? ` in ${place}` : ""}. Your ticket is in the app.`,
  };
}

export function hostReminderCopy(e: { title: string; starts_at: Date | string; timezone: string }, going: number, now: Date): { title: string; body: string } {
  const tz = zoneOr(e.timezone);
  const day = isSameLocalDay(new Date(e.starts_at), now, tz) ? "today" : "tomorrow";
  return {
    title: `Your event is ${day}: ${String(e.title)}`,
    body: `${going} going. Tap to see your guests and manage the event.`,
  };
}
