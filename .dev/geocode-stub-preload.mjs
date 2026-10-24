// TEST-ONLY. Answers OpenStreetMap Nominatim lookups from a fixed table instead of the internet.
// Active only when GEOCODE_STUB=1. Use with:
//   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/geocode-stub-preload.mjs"
// server/geocoding.ts calls fetch("https://nominatim.openstreetmap.org/search?q=..."), so wrapping
// global fetch catches every lookup. When GEOCODE_STUB_LOG is set, each lookup's query is appended
// to that file (one line per lookup) so tests can count them.
import fs from 'fs';

if (process.env.GEOCODE_STUB === '1') {
  const TABLE = {
    'freeport, ny': [40.6576, -73.5832],
    'baldwin, ny': [40.6565, -73.6093],
    'queens, ny': [40.7282, -73.7949],
    'norfolk, va': [36.8508, -76.2859],
    'orlando, fl': [28.5384, -81.3789],
    'hampton roads, va': [36.9, -76.2],
    'miami, fl': [25.7617, -80.1918],
  };
  const log = process.env.GEOCODE_STUB_LOG;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function stubbedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.startsWith('https://nominatim.openstreetmap.org/search')) {
      const q = new URL(url).searchParams.get('q') || '';
      // "City, ST, United States" → "city, st"
      const key = q.split(',').map((p) => p.trim()).filter((p) => p && p !== 'United States').slice(0, 2).join(', ').toLowerCase();
      if (log) fs.appendFileSync(log, `${q}\n`);
      const hit = TABLE[key];
      const body = hit ? [{ lat: String(hit[0]), lon: String(hit[1]), display_name: q }] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  console.log('[geocode-stub-preload] nominatim.openstreetmap.org -> fixed table');
}
