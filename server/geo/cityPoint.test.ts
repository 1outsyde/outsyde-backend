/**
 * refreshCityPoint rules (pure, no DB, no network) — run with: npx tsx server/geo/cityPoint.test.ts
 */
import { refreshCityPoint } from "./cityPoint";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

(async () => {
  const calls: Array<[string, string | null, unknown]> = [];
  const lookup = async (city: string, state: string | null, opts?: unknown) => {
    calls.push([city, state, opts]);
    if (city === "Freeport") return { latitude: 40.6576, longitude: -73.5832 };
    if (city === "Boom") throw new Error("down");
    return null;
  };
  const cur = { city: "Baldwin", state: "NY" };

  assert((await refreshCityPoint(cur, {}, lookup)) === undefined && calls.length === 0, "nothing touched → undefined, no lookup");
  assert((await refreshCityPoint(cur, { city: " baldwin ", state: "New York" }, lookup)) === undefined && calls.length === 0,
    "same city/state resent (case, spaces, full state name) → no lookup");
  assert((await refreshCityPoint(cur, { city: "Baldwin", state: "Ny" }, lookup)) === undefined, '"Ny" equals "NY"');

  const moved = await refreshCityPoint(cur, { city: "Freeport" }, lookup);
  assert(moved?.latitude === 40.6576 && moved.longitude === -73.5832, "city changed → new point", moved);
  assert(calls.at(-1)?.[0] === "Freeport" && calls.at(-1)?.[1] === "NY", "keeps current state, normalized", calls.at(-1));
  assert((calls.at(-1)?.[2] as any)?.wait === true, "waits its turn (never skipped by the throttle)");

  const st = await refreshCityPoint({ city: "Freeport", state: "NJ" }, { state: "new york" }, lookup);
  assert(st?.latitude === 40.6576 && calls.at(-1)?.[1] === "NY", "state changed → looked up with new state", calls.at(-1));

  const miss = await refreshCityPoint(cur, { city: "Nowhereville" }, lookup);
  assert(miss?.latitude === null && miss.longitude === null, "lookup finds nothing → point cleared, not kept", miss);
  const boom = await refreshCityPoint(cur, { city: "Boom" }, lookup);
  assert(boom?.latitude === null, "lookup throws → point cleared, no throw", boom);

  const n = calls.length;
  const cleared = await refreshCityPoint(cur, { city: "" }, lookup);
  assert(cleared?.latitude === null && calls.length === n, "city cleared → point cleared, no lookup", cleared);
  const nulled = await refreshCityPoint(cur, { city: null }, lookup);
  assert(nulled?.latitude === null, "city null → point cleared", nulled);

  const fromNone = await refreshCityPoint({ city: null, state: null }, { city: "Freeport", state: "NY" }, lookup);
  assert(fromNone?.latitude === 40.6576, "first city set → point", fromNone);
  const unknownState = await refreshCityPoint({ city: "Queens", state: null }, { state: "Zz" }, lookup);
  assert(calls.at(-1)?.[1] === "Zz" && unknownState?.latitude === null, "unknown state passed through as typed", calls.at(-1));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
