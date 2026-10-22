/**
 * Fire-and-forget geocoding for events. Never throws and never blocks the request.
 *
 * Test seams (need ALLOW_TEST_SEAMS=1 and never active when NODE_ENV === "production"):
 *  - setGeocoderForTest(fn): in-process replacement for geocodeAddress.
 *  - EVENT_GEOCODE_STUB="lat,lon": for a booted server in a separate process. Every address resolves to those
 *    coords, except city "Nowhere" which resolves to null. EVENT_GEOCODE_STUB_LOG=<file> appends one line per call.
 */
import { appendFileSync } from "fs";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { geocodeAddress, type GeocodingInput, type GeocodingResult } from "../geocoding";

type Geocoder = (a: GeocodingInput) => Promise<GeocodingResult | null>;
let override: Geocoder | null = null;

export function setGeocoderForTest(fn: Geocoder | null): void {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_TEST_SEAMS !== "1") return;
  override = fn;
}

function envStub(): Geocoder | null {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_TEST_SEAMS !== "1") return null;
  const raw = process.env.EVENT_GEOCODE_STUB;
  if (!raw) return null;
  const [lat, lon] = raw.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return async (a) => {
    const log = process.env.EVENT_GEOCODE_STUB_LOG;
    if (log) { try { appendFileSync(log, `${a.streetAddress ?? ""}|${a.city}|${a.state}\n`); } catch {} }
    return a.city === "Nowhere" ? null : { latitude: lat, longitude: lon };
  };
}

export function geocodeEventInBackground(
  eventId: string,
  a: { addressLine1: string | null; city: string | null; state: string | null; postalCode: string | null },
): void {
  try {
    if (!a.city || !a.state) return;
    const geocoder: Geocoder = override ?? envStub() ?? geocodeAddress;
    geocoder({ streetAddress: a.addressLine1 ?? undefined, city: a.city, state: a.state, zipCode: a.postalCode ?? undefined })
      .then(async (coords) => {
        if (!coords) return;
        await db.execute(sql`
          UPDATE events SET latitude = ${coords.latitude}, longitude = ${coords.longitude}, updated_at = now()
          WHERE id = ${eventId} AND latitude IS NULL
            AND address_line1 IS NOT DISTINCT FROM ${a.addressLine1}
            AND city IS NOT DISTINCT FROM ${a.city}
            AND state IS NOT DISTINCT FROM ${a.state}
            AND postal_code IS NOT DISTINCT FROM ${a.postalCode}`);
      })
      .catch((err) => console.error("[Events] geocode failed:", err));
  } catch (err) {
    console.error("[Events] geocode failed:", err);
  }
}
