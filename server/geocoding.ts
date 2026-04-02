/**
 * Geocoding utility — converts addresses to lat/lng coordinates.
 * Uses OpenStreetMap Nominatim (free, no API key required).
 * Non-blocking: failures return null, never crash the caller.
 */

export interface GeocodingInput {
  streetAddress?: string;
  city: string;
  state: string;
  zipCode?: string;
  country?: string;
}

export interface GeocodingResult {
  latitude: number;
  longitude: number;
}

export async function geocodeAddress(address: GeocodingInput): Promise<GeocodingResult | null> {
  try {
    const query = [
      address.streetAddress,
      address.city,
      address.state,
      address.zipCode,
      address.country ?? 'United States',
    ].filter(Boolean).join(', ');

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Outsyde App (support@outsyde.com)' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json() as Array<{ lat: string; lon: string }>;
    if (data && data[0]) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (!isNaN(lat) && !isNaN(lon)) {
        console.log(`[Geocode] ${address.city}, ${address.state} → ${lat}, ${lon}`);
        return { latitude: lat, longitude: lon };
      }
    }
    return null;
  } catch (error) {
    console.error('[Geocode] Failed:', error);
    return null;
  }
}
