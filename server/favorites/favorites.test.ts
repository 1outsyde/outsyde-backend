/**
 * Saved businesses, photographers and products — run with: npx tsx server/favorites/favorites.test.ts
 */
import assert from "node:assert/strict";
import { parseImportItems, parseTarget, placeLine, productImage, MAX_IMPORT_ITEMS } from "./favorites";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

test("targets", () => {
  assert.deepEqual(parseTarget("business", "abc-123"), { type: "business", id: "abc-123" });
  assert.deepEqual(parseTarget("product", 42), { type: "product", id: "42" });
  assert.equal(parseTarget("post", "x"), null);
  assert.equal(parseTarget("business", ""), null);
  assert.equal(parseTarget("business", "a'; drop"), null);
  assert.equal(parseTarget("business", "x".repeat(37)), null);
  assert.equal(parseTarget(undefined, "x"), null);
});

test("import list from the phone", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const items = parseImportItems({
    items: [
      { type: "business", id: "b1", name: "A", savedAt: "2026-01-02T00:00:00.000Z" },
      { type: "business", id: "b1", savedAt: "2026-03-02T00:00:00.000Z" },
      { type: "photographer", id: "p1", savedAt: "not a date" },
      { type: "product", id: "x1", savedAt: "2030-01-01T00:00:00Z" },
      { type: "post", id: "z" },
      null,
      "junk",
    ],
  }, now)!;
  assert.deepEqual(items.map((i) => `${i.type}:${i.id}`), ["business:b1", "photographer:p1", "product:x1"]);
  assert.equal(items[0].savedAt?.toISOString(), "2026-01-02T00:00:00.000Z");
  assert.equal(items[1].savedAt, null);
  assert.equal(items[2].savedAt, null, "future date dropped");
  assert.equal(parseImportItems({}), null);
  assert.equal(parseImportItems(null), null);
  assert.deepEqual(parseImportItems({ items: [] }), []);
  const many = Array.from({ length: MAX_IMPORT_ITEMS + 50 }, (_, i) => ({ type: "business", id: `b${i}` }));
  assert.equal(parseImportItems({ items: many })!.length, MAX_IMPORT_ITEMS);
});

test("display helpers", () => {
  assert.equal(placeLine("Freeport", "NY"), "Freeport, NY");
  assert.equal(placeLine("", "NY"), "NY");
  assert.equal(placeLine(null, null), "");
  assert.equal(productImage("https://a/1.jpg", ["https://a/2.jpg"]), "https://a/1.jpg");
  assert.equal(productImage("", ["", "https://a/2.jpg"]), "https://a/2.jpg");
  assert.equal(productImage(null, null), null);
});

console.log(`\n${passed} passed`);
