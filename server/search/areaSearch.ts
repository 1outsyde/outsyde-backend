/**
 * City search by area (2026-10-23, Legend): searching a city finds everyone in that city AND its
 * surrounding area, not only rows whose city text contains the word.
 *
 * A search area = a center point + radius. A row matches when
 *   (it has coordinates within the radius) OR (its city text contains the searched city)
 * so rows without coordinates are still found the old way (nothing that matched before disappears).
 *
 * Center point, in order: lat/lng sent by the client → a known center for the app's city cards →
 * a geocode of "city, state" (cached) → none (text match only, the old behaviour).
 */
import { sql, ilike, or, and, isNotNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { geocodeAddress } from "../geocoding";

export const DEFAULT_RADIUS_MILES = 30;
export const MAX_RADIUS_MILES = 100;
/** Smallest allowed radius, so nobody can narrow a person down to a spot with tiny circles. */
export const MIN_RADIUS_MILES = 5;
const EARTH_RADIUS_MILES = 3958.8;

export interface SearchArea {
  /** Text the old filter used; still matched for rows without coordinates. */
  city: string;
  state: string | null;
  center: { latitude: number; longitude: number } | null;
  radiusMiles: number;
}

const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR",
};
const VALID_CODES = new Set(Object.values(STATE_CODES));

/** "new york" / "Ny" / " NY " → "NY". Unknown → null. */
export function normalizeState(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return null;
  const up = t.toUpperCase();
  if (up.length === 2 && VALID_CODES.has(up)) return up;
  return STATE_CODES[t.toLowerCase()] ?? null;
}

/** Centers for the app's "Discover by City" cards, so those never need a network call. */
const KNOWN_CENTERS: Record<string, { latitude: number; longitude: number }> = {
  "new york|NY": { latitude: 40.7128, longitude: -74.006 },
  "atlanta|GA": { latitude: 33.749, longitude: -84.388 },
  "miami|FL": { latitude: 25.7617, longitude: -80.1918 },
  "los angeles|CA": { latitude: 34.0522, longitude: -118.2437 },
  "chicago|IL": { latitude: 41.8781, longitude: -87.6298 },
  "houston|TX": { latitude: 29.7604, longitude: -95.3698 },
  "dallas|TX": { latitude: 32.7767, longitude: -96.797 },
  "phoenix|AZ": { latitude: 33.4484, longitude: -112.074 },
};
/** Old app builds send only the city name of a card. */
const KNOWN_BY_CITY: Record<string, string> = {
  "new york": "NY", atlanta: "GA", miami: "FL", "los angeles": "CA",
  chicago: "IL", houston: "TX", dallas: "TX", phoenix: "AZ",
};

export function knownCenter(city: string, state: string | null) {
  const c = city.trim().toLowerCase().replace(/\s+/g, " ");
  const st = state ?? KNOWN_BY_CITY[c] ?? null;
  if (!st) return null;
  return KNOWN_CENTERS[`${c}|${st}`] ?? null;
}

function num(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function validCoords(lat: unknown, lng: unknown) {
  const la = num(lat);
  const lo = num(lng);
  if (la === null || lo === null) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { latitude: la, longitude: lo };
}

export function clampRadius(raw: unknown): number {
  const r = num(raw);
  if (r === null || r <= 0) return DEFAULT_RADIUS_MILES;
  return Math.min(MAX_RADIUS_MILES, Math.max(MIN_RADIUS_MILES, r));
}

type Geocoder = (
  city: string,
  state: string | null,
  opts?: { wait?: boolean },
) => Promise<{ latitude: number; longitude: number } | null>;

const CACHE_MS = 24 * 60 * 60 * 1000;
const FAIL_CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
/** OpenStreetMap Nominatim allows about 1 request a second; never go faster than that. */
const MIN_LOOKUP_GAP_MS = 1100;
const geoCache = new Map<string, { at: number; value: { latitude: number; longitude: number } | null }>();
let lastLookupAt = 0;

/**
 * City-level geocode with an in-memory least-recently-used cache (misses cached briefly) and a
 * global throttle: a lookup that would come too soon after the last one is skipped (null = text
 * match only for that search) instead of queued, so search never waits and Nominatim is never hammered.
 */
export const cachedCityGeocode: Geocoder = async (city, state, opts = {}) => {
  const key = `${city.trim().toLowerCase()}|${state ?? ""}`;
  const hit = geoCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < (hit.value ? CACHE_MS : FAIL_CACHE_MS)) {
    geoCache.delete(key);
    geoCache.set(key, hit); // most recently used last
    return hit.value;
  }
  const gap = MIN_LOOKUP_GAP_MS - (now - lastLookupAt);
  if (gap > 0) {
    // Search skips (null = text match only, not cached). A profile save waits its turn instead.
    if (!opts.wait) return null;
    lastLookupAt = now + gap;
    await new Promise((r) => setTimeout(r, gap));
  } else {
    lastLookupAt = now;
  }
  const value = await geocodeAddress({ city: city.trim(), state: state ?? "" });
  geoCache.delete(key);
  geoCache.set(key, { at: now, value });
  while (geoCache.size > CACHE_MAX) {
    const oldest = geoCache.keys().next().value;
    if (oldest === undefined) break;
    geoCache.delete(oldest);
  }
  return value;
};

/**
 * Builds the search area from query params. Returns null when no city was asked for.
 * Never throws: a failed geocode just means text matching only.
 */
export async function resolveSearchArea(
  params: { city?: unknown; state?: unknown; lat?: unknown; lng?: unknown; radiusMiles?: unknown },
  geocode: Geocoder = cachedCityGeocode,
): Promise<SearchArea | null> {
  const city = typeof params.city === "string" ? params.city.trim().slice(0, 100) : "";
  if (!city) return null;
  const state = normalizeState(params.state);
  const radiusMiles = clampRadius(params.radiusMiles);
  let center = validCoords(params.lat, params.lng) ?? knownCenter(city, state);
  if (!center) {
    try {
      center = await geocode(city, state);
    } catch {
      center = null;
    }
  }
  return { city, state, center, radiusMiles };
}

/** Great-circle distance in miles (same formula as the SQL below; used by tests and callers). */
export function milesBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const x =
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(rad(b.longitude) - rad(a.longitude)) +
    Math.sin(rad(a.latitude)) * Math.sin(rad(b.latitude));
  return EARTH_RADIUS_MILES * Math.acos(Math.min(1, Math.max(-1, x)));
}

/**
 * SQL condition: the row is in the area. Rows with coordinates inside the radius, or whose city text
 * contains the searched city (the old rule, kept so rows without coordinates are still found).
 */
export function inAreaSql(
  area: SearchArea | null,
  cols: { city: AnyPgColumn; latitude: AnyPgColumn; longitude: AnyPgColumn },
  opts: { coarse?: boolean } = {},
): SQL | undefined {
  if (!area) return undefined;
  const textMatch = ilike(cols.city, `%${area.city}%`);
  if (!area.center) return textMatch;
  const { latitude: lat0, longitude: lng0 } = area.center;
  // People (coarse): compare a point rounded to 0.1° (about 7 miles), never the stored point itself,
  // so a stored point that happens to be precise can't be located by repeated searches.
  const lat = opts.coarse ? sql`round((${cols.latitude})::numeric, 1)::float8` : sql`${cols.latitude}`;
  const lng = opts.coarse ? sql`round((${cols.longitude})::numeric, 1)::float8` : sql`${cols.longitude}`;
  const distance = sql`${EARTH_RADIUS_MILES} * acos(least(1, greatest(-1,
    cos(radians(${lat0})) * cos(radians(${lat})) * cos(radians(${lng}) - radians(${lng0}))
    + sin(radians(${lat0})) * sin(radians(${lat})))))`;
  return or(
    and(isNotNull(cols.latitude), isNotNull(cols.longitude), sql`${distance} <= ${area.radiusMiles}`),
    textMatch,
  );
}
