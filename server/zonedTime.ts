/**
 * Time zone helpers. Pure: no database, no imports from the app, so rule tests run with no DATABASE_URL.
 */

/** Offset (ms) of `tz` from UTC at the given instant. */
export function zoneOffsetMs(instantMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** "2026-10-18" + "14:30" (wall clock in `tz`) → the real instant. Null when the text is not a date/time. */
export function wallClockToUtc(date: string | null | undefined, time: string | null | undefined, tz: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time ?? "").trim());
  if (!d || !t) return null;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  if (!Number.isFinite(guess)) return null;
  let ts = guess - zoneOffsetMs(guess, tz);
  ts = guess - zoneOffsetMs(ts, tz); // second pass settles daylight saving edges
  return new Date(ts);
}

/** The calendar date ("YYYY-MM-DD") of `instant` as seen in `timeZone`. */
export function localDateInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
