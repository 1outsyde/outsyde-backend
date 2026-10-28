/**
 * Profile / brand color rules (color wheel build, 2026-10-28) — run with:
 *   npx tsx server/profileColor.test.ts
 * Pure unit test, no database or server needed.
 */
import { decideColorUpdate, SOLID_COLOR_IDS } from "../shared/profileColor";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const PRESET = { type: "solid", id: "royal_purple" };
const WHEEL = { type: "custom", hex: "#12AB9F" };

console.log("Accepted shapes");
for (const id of SOLID_COLOR_IDS) {
  const d = decideColorUpdate({ type: "solid", id }, null);
  assert(d.ok && d.apply && same(d.value, { type: "solid", id }), `preset ${id} (old app shape) is stored`);
}
{
  const d = decideColorUpdate({ type: "custom", hex: "#12ab9f", v: 2 }, null);
  assert(d.ok && d.apply && same(d.value, { type: "custom", hex: "#12AB9F" }), "wheel hex stored uppercase, v not stored", d);
}
{
  const d = decideColorUpdate({ type: "solid", id: "teal", v: 2 }, WHEEL);
  assert(d.ok && d.apply && same(d.value, { type: "solid", id: "teal" }), "new app can switch wheel color back to a preset", d);
}
{
  const d = decideColorUpdate(null, WHEEL);
  assert(d.ok && d.apply && d.value === null, "null always clears to gold", d);
}

console.log("Every color saved in production today still passes (Neon, 2026-10-28)");
for (const id of ["royal_purple", "sunset_gold", "sky_cyan", "coral", "ocean_blue", "rose_pink"]) {
  const d = decideColorUpdate({ id, type: "solid" }, { id, type: "solid" });
  assert(d.ok && d.apply, `stored ${id} re-saved unchanged`);
}

console.log("Old app versions never overwrite a wheel color");
{
  const d = decideColorUpdate({ type: "solid", id: "sunset_gold" }, WHEEL);
  assert(d.ok && !d.apply, "old Storefront Editor branding save (gold fallback) leaves wheel color alone", d);
}
{
  const d = decideColorUpdate({ type: "solid", id: "teal" }, PRESET);
  assert(d.ok && d.apply && same(d.value, { type: "solid", id: "teal" }), "old app still changes preset to preset", d);
}

console.log("Rejected shapes");
const bad: unknown[] = [
  { type: "solid", id: "not_a_color" },
  { type: "solid" },
  { type: "gradient", id: "dusk_fade" },
  { type: "custom", hex: "12AB9F" },
  { type: "custom", hex: "#12AB9" },
  { type: "custom", hex: "#GGGGGG" },
  { type: "custom", hex: "red" },
  { type: "custom", hex: "#12AB9F", v: 3 },
  { primary: "#eab308" },
  "#12AB9F",
  42,
];
for (const b of bad) {
  const d = decideColorUpdate(b, null);
  assert(!d.ok, `rejects ${JSON.stringify(b)}`, d);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
