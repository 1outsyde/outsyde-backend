/**
 * City search area rules (pure, no DB) — run with: npx tsx server/search/areaSearch.test.ts
 */
import {
  normalizeState, knownCenter, validCoords, clampRadius, resolveSearchArea, milesBetween,
  DEFAULT_RADIUS_MILES, MAX_RADIUS_MILES, MIN_RADIUS_MILES,
} from "./areaSearch";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

(async () => {
  console.log("normalizeState");
  assert(normalizeState("NY") === "NY", "NY");
  assert(normalizeState(" ny ") === "NY", "lower + spaces");
  assert(normalizeState("Ny") === "NY", "Ny (real Neon value)");
  assert(normalizeState("New York") === "NY", "full name");
  assert(normalizeState("new  jersey") === "NJ", "double space");
  assert(normalizeState("Texas") === "TX", "Texas");
  assert(normalizeState("XX") === null, "unknown code");
  assert(normalizeState("") === null && normalizeState(null) === null && normalizeState(5) === null, "empty / wrong type");

  console.log("knownCenter");
  assert(!!knownCenter("Miami", "FL"), "Miami FL");
  assert(!!knownCenter("miami", null), "old app: city only");
  assert(!!knownCenter(" New  York ", "NY"), "spaces");
  assert(knownCenter("Miami", "OH") === null, "wrong state");
  assert(knownCenter("Freeport", "NY") === null, "not a card");

  console.log("validCoords / clampRadius");
  assert(validCoords("25.7", "-80.2")?.latitude === 25.7, "string coords");
  assert(validCoords(91, 0) === null && validCoords(0, 181) === null, "out of range");
  assert(validCoords("abc", 1) === null && validCoords(undefined, 1) === null, "garbage");
  assert(clampRadius(undefined) === DEFAULT_RADIUS_MILES, "default radius");
  assert(clampRadius("10") === 10, "custom radius");
  assert(clampRadius(5000) === MAX_RADIUS_MILES, "capped");
  assert(clampRadius(-3) === DEFAULT_RADIUS_MILES && clampRadius(0) === DEFAULT_RADIUS_MILES, "non-positive → default");
  assert(clampRadius(0.01) === MIN_RADIUS_MILES && clampRadius("1") === MIN_RADIUS_MILES, "tiny radius raised to the minimum");

  console.log("milesBetween");
  const miami = { latitude: 25.7617, longitude: -80.1918 };
  const hialeah = { latitude: 25.8576, longitude: -80.2781 };
  const fortLauderdale = { latitude: 26.1224, longitude: -80.1373 };
  const orlando = { latitude: 28.5384, longitude: -81.3789 };
  assert(milesBetween(miami, miami) === 0, "same point = 0");
  assert(milesBetween(miami, hialeah) < 10, "Hialeah is near Miami", milesBetween(miami, hialeah));
  assert(milesBetween(miami, fortLauderdale) < DEFAULT_RADIUS_MILES, "Fort Lauderdale within default radius", milesBetween(miami, fortLauderdale));
  assert(milesBetween(miami, orlando) > 150, "Orlando far", milesBetween(miami, orlando));
  const nyc = { latitude: 40.7128, longitude: -74.006 };
  const freeport = { latitude: 40.6576, longitude: -73.5832 };
  assert(milesBetween(nyc, freeport) < DEFAULT_RADIUS_MILES, "Freeport counts as New York area", milesBetween(nyc, freeport));

  console.log("resolveSearchArea");
  let calls = 0;
  const geo = async () => { calls++; return { latitude: 40.65, longitude: -73.58 }; };
  const failGeo = async () => { calls++; throw new Error("down"); };
  assert((await resolveSearchArea({}, geo)) === null && calls === 0, "no city → null, no lookup");
  assert((await resolveSearchArea({ city: "   " }, geo)) === null, "blank city → null");
  const card = await resolveSearchArea({ city: "Miami" }, geo);
  assert(!!card?.center && card.center.latitude === 25.7617 && calls === 0, "card city uses known center, no lookup");
  const sent = await resolveSearchArea({ city: "Freeport", state: "NY", lat: "40.6576", lng: "-73.5832" }, geo);
  assert(sent?.center?.latitude === 40.6576 && calls === 0, "client coords win, no lookup");
  const looked = await resolveSearchArea({ city: "Freeport", state: "New York" }, geo);
  assert(looked?.center?.latitude === 40.65 && looked.state === "NY" && calls === 1, "other city geocoded once");
  const failed1 = await resolveSearchArea({ city: "Nowhere", state: "NY" }, failGeo);
  assert(!!failed1 && failed1.center === null, "geocode failure → text match only, no throw");
  const long = await resolveSearchArea({ city: "x".repeat(300) }, async () => null);
  assert(long?.city.length === 100, "city capped at 100 chars");
  const arr = await resolveSearchArea({ city: ["Miami", "Atlanta"] }, geo);
  assert(arr === null, "array query param ignored");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
