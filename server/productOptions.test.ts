/**
 * Product options tests — run with: npx tsx server/productOptions.test.ts
 * Pure functions only: no database.
 */

import assert from "node:assert/strict";
import {
  validateOptionsPayload,
  planVariantSync,
  withEffectivePrice,
  type ExistingVariant,
  type OptionInput,
  type VariantInput,
} from "./productOptions";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const color: OptionInput = { name: "Color", values: [{ value: "Black", swatchHex: "#0A0A0A" }, { value: "Cream" }] };
const size: OptionInput = { name: "Size", values: [{ value: "M" }, { value: "XL" }] };
const v = (o1: string, o2: string, priceCents: number | null = null, extra: Partial<VariantInput> = {}): VariantInput =>
  ({ option1: o1, option2: o2, priceCents, inventory: 5, ...extra });

console.log("productOptions");

test("2 options x 2 values: labels, canonical spelling, order kept", () => {
  const r = validateOptionsPayload([color, size], [v("black", "m"), v("Black", "XL", 4000), v("Cream", "M"), v("Cream", "XL", 4000)]);
  assert.ok(r.ok);
  assert.deepEqual(r.variants.map((x) => x.label), ["Black / M", "Black / XL", "Cream / M", "Cream / XL"]);
  assert.equal(r.variants[0].option1, "Black"); // canonical from the option list
  assert.deepEqual(r.variants.map((x) => x.sortOrder), [0, 1, 2, 3]);
  assert.equal(r.options[1].position, 2);
});

test("blank price means product price (null kept), own price kept", () => {
  const r = validateOptionsPayload([color, size], [v("Black", "M", null), v("Black", "XL", 4000)]);
  assert.ok(r.ok);
  assert.equal(r.variants[0].priceCents, null);
  assert.equal(r.variants[1].priceCents, 4000);
});

test("Dia Lux length ladder: 1 option, 11 values, each its own price", () => {
  const lengths = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];
  const prices = [125, 135, 145, 155, 165, 175, 185, 195, 205, 225, 235];
  const r = validateOptionsPayload(
    [{ name: "Length", values: lengths.map((l) => ({ value: `${l}"` })) }],
    lengths.map((l, i) => ({ option1: `${l}"`, priceCents: prices[i] * 100, inventory: 5 })),
  );
  assert.ok(r.ok);
  assert.equal(r.variants.length, 11);
  assert.equal(r.variants[9].label, '30"');
  assert.equal(r.variants[9].priceCents, 22500);
});

test("refuses more than 3 options", () => {
  const r = validateOptionsPayload([color, size, { name: "Fit", values: [{ value: "Slim" }] }, { name: "X", values: [{ value: "Y" }] }], []);
  assert.ok(!r.ok);
});

test("refuses duplicate option names and duplicate values", () => {
  assert.ok(!validateOptionsPayload([color, { name: "color", values: [{ value: "Red" }] }], []).ok);
  assert.ok(!validateOptionsPayload([{ name: "Size", values: [{ value: "M" }, { value: " m " }] }], []).ok);
});

test("refuses an option with no values, and a bad swatch color", () => {
  assert.ok(!validateOptionsPayload([{ name: "Size", values: [] }], []).ok);
  assert.ok(!validateOptionsPayload([{ name: "Color", values: [{ value: "Red", swatchHex: "red" }] }], []).ok);
});

test("refuses a variant value that isn't in the option list", () => {
  const r = validateOptionsPayload([color, size], [v("Purple", "M")]);
  assert.ok(!r.ok);
  assert.equal(r.error.code, "INVALID_VARIANTS");
});

test("refuses a value for an option that doesn't exist", () => {
  const r = validateOptionsPayload([color], [{ option1: "Black", option2: "M", priceCents: null }]);
  assert.ok(!r.ok);
});

test("refuses the same combination twice", () => {
  const r = validateOptionsPayload([color, size], [v("Black", "M"), v("black", "m")]);
  assert.ok(!r.ok);
});

test("refuses zero/negative/fractional price, negative stock, non-https photo", () => {
  assert.ok(!validateOptionsPayload([color, size], [v("Black", "M", 0)]).ok);
  assert.ok(!validateOptionsPayload([color, size], [v("Black", "M", 10.5)]).ok);
  assert.ok(!validateOptionsPayload([color, size], [v("Black", "M", null, { inventory: -1 })]).ok);
  assert.ok(!validateOptionsPayload([color, size], [v("Black", "M", null, { imageUrl: "http://x.com/a.jpg" })]).ok);
  assert.ok(validateOptionsPayload([color, size], [v("Black", "M", null, { imageUrl: "https://res.cloudinary.com/a.jpg" })]).ok);
});

test("refuses variations without any option", () => {
  assert.ok(!validateOptionsPayload([], [{ priceCents: 100 }]).ok);
  const clear = validateOptionsPayload([], []);
  assert.ok(clear.ok);
});

const existing: ExistingVariant[] = [
  { id: "legacy-red", label: "Red", priceCents: 2500, inventory: null, isActive: true, option1: null, option2: null, option3: null },
  { id: "bm", label: "Black / M", priceCents: null, inventory: 5, isActive: true, option1: "Black", option2: "M", option3: null },
  { id: "bxl-off", label: "Black / XL", priceCents: 4000, inventory: 0, isActive: false, option1: "Black", option2: "XL", option3: null },
  { id: "cm", label: "Cream / M", priceCents: null, inventory: 5, isActive: true, option1: "Cream", option2: "M", option3: null },
];

test("sync: match by combination, re-activate a switched-off row, insert new, switch off the rest", () => {
  const r = validateOptionsPayload([color, size], [v("Black", "M"), v("Black", "XL", 4000), v("Cream", "XL", 4000)]);
  assert.ok(r.ok);
  const p = planVariantSync(existing, r.variants);
  assert.ok(p.ok);
  assert.deepEqual(p.plan.updates.map((u) => u.id), ["bm", "bxl-off"]);
  assert.equal(p.plan.updates[1].values.isActive, true);
  assert.equal(p.plan.inserts.length, 1);
  assert.equal(p.plan.inserts[0].label, "Cream / XL");
  assert.deepEqual(p.plan.deactivateIds.sort(), ["cm", "legacy-red"]); // never deleted
});

test("sync: an id claims its row even when a new row has its old combination", () => {
  // "bm" is renamed to Cream / M, and a new Black / M is added without an id.
  const r = validateOptionsPayload([color, size], [v("Black", "M"), { ...v("Cream", "M"), id: "bm" }]);
  assert.ok(r.ok);
  const p = planVariantSync(existing, r.variants);
  assert.ok(p.ok);
  assert.deepEqual(p.plan.updates.map((u) => u.id), ["bm"]);
  assert.equal(p.plan.inserts.length, 1);
  assert.equal(p.plan.inserts[0].label, "Black / M");
});

test("sync: refuses an id from another product", () => {
  const r = validateOptionsPayload([color, size], [{ ...v("Black", "M"), id: "someone-elses" }]);
  assert.ok(r.ok);
  const p = planVariantSync(existing, r.variants);
  assert.ok(!p.ok);
  assert.equal(p.error.code, "INVALID_VARIANT_ID");
});

test("sync: clearing all options switches every variation off", () => {
  const p = planVariantSync(existing, []);
  assert.ok(p.ok);
  assert.deepEqual(p.plan.deactivateIds.sort(), ["bm", "cm", "legacy-red"]);
  assert.equal(p.plan.updates.length + p.plan.inserts.length, 0);
});

test("public price is always a number: blank uses the product price", () => {
  assert.deepEqual(withEffectivePrice({ priceCents: null, label: "Black / M" }, 3500), { priceCents: 3500, label: "Black / M", hasOwnPrice: false });
  assert.deepEqual(withEffectivePrice({ priceCents: 4000, label: "Black / XL" }, 3500), { priceCents: 4000, label: "Black / XL", hasOwnPrice: true });
});

console.log(`\n${passed} passed`);
