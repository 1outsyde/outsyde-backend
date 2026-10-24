/**
 * Keep a business's or photographer's map point in step with its city (2026-10-23).
 *
 * Points used to be looked up only at signup, so changing the city in the storefront editor or the
 * photographer dashboard left the old point (or none). City search (#362) measures distance from
 * these points, so a stale point puts someone in the wrong area.
 *
 * Rule: when a save actually changes the city or state (compared trimmed and case-insensitive, with
 * state names normalized), look up a CITY-LEVEL point. If the lookup fails, clear the point so the
 * row falls back to city-name matching instead of keeping the old city's point. Saves that resend the
 * same city/state, or don't touch them, change nothing and make no lookup.
 */
import { cachedCityGeocode, normalizeState } from "../search/areaSearch";

type CityState = { city?: string | null; state?: string | null };
export type CityPoint = { latitude: number | null; longitude: number | null };

const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const sameCity = (a: unknown, b: unknown) => clean(a).toLowerCase() === clean(b).toLowerCase();
const sameState = (a: unknown, b: unknown) => {
  const na = normalizeState(a) ?? clean(a).toLowerCase();
  const nb = normalizeState(b) ?? clean(b).toLowerCase();
  return na === nb;
};

type Lookup = typeof cachedCityGeocode;

/**
 * Returns the point to save, or `undefined` when the save doesn't change the city or state
 * (nothing to do). Never throws.
 */
export async function refreshCityPoint(
  current: CityState,
  updates: CityState,
  lookup: Lookup = cachedCityGeocode,
): Promise<CityPoint | undefined> {
  const cityTouched = updates.city !== undefined && !sameCity(updates.city, current.city);
  const stateTouched = updates.state !== undefined && !sameState(updates.state, current.state);
  if (!cityTouched && !stateTouched) return undefined;

  const city = clean(updates.city !== undefined ? updates.city : current.city);
  const rawState = updates.state !== undefined ? updates.state : current.state;
  if (!city) return { latitude: null, longitude: null };
  const state = normalizeState(rawState) ?? (clean(rawState) || null);
  try {
    const point = await lookup(city, state, { wait: true });
    return point ? { latitude: point.latitude, longitude: point.longitude } : { latitude: null, longitude: null };
  } catch {
    return { latitude: null, longitude: null };
  }
}
