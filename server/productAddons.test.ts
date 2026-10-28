/**
 * Product add-on tests — run with: npx tsx server/productAddons.test.ts
 * Pure functions plus checkout pricing with in-memory lookups. No database, no Stripe.
 */

import assert from "node:assert/strict";
import {
  assembleGroups,
  validateAddonGroupsPayload,
  checkPayloadIds,
  toPublicGroups,
  summarizeAddons,
  priceLineAddons,
  addonsLabel,
  orderItemDetail,
  type AddonGroupRow,
  type AddonRow,
} from "./productAddons";
import { priceCartLines, toOrderItem, type CartPricingDeps, type ProductRow, type VariantRow } from "./cartPricing";

const BIZ = "biz-jazzy";
const cake: ProductRow = { id: "cake", businessId: BIZ, name: "Fresh Fruit Cake", price: 8500, inventory: 4, trackInventory: true, isActive: true, status: "live" };
const cookie: ProductRow = { id: "cookie", businessId: BIZ, name: "Apple Pie Cookies", price: 1100, inventory: null, trackInventory: true, isActive: true, status: "live" };
const cakeVariants: VariantRow[] = [
  { id: "pink", productId: "cake", label: "Pink", priceCents: null, inventory: null, trackInventory: true, isActive: true },
  { id: "white", productId: "cake", label: "White", priceCents: 9000, inventory: null, trackInventory: true, isActive: true },
];

const g = (id: string, name: string, minSelect: number, maxSelect: number | null, sortOrder: number, isActive = true): AddonGroupRow =>
  ({ id, productId: "cake", name, minSelect, maxSelect, sortOrder, isActive });
const a = (id: string, groupId: string, name: string, priceCents: number, sortOrder: number, extra: Partial<AddonRow> = {}): AddonRow =>
  ({ id, groupId, productId: "cake", name, description: null, priceCents, acceptsText: false, textLabel: null, textMaxLength: 40, isActive: true, sortOrder, ...extra });

const groupRows = [
  g("fruit", "Fruit", 1, 3, 0),
  g("extras", "Extras", 0, null, 1),
  g("old", "Old group", 1, 1, 2, false),
];
const addonRows = [
  a("strawberry", "fruit", "Strawberry", 0, 0),
  a("kiwi", "fruit", "Kiwi", 0, 1),
  a("mango", "fruit", "Mango", 200, 2),
  a("blueberry", "fruit", "Blueberry", 0, 3),
  a("dragonfruit", "fruit", "Dragon fruit", 500, 4, { isActive: false }),
  a("sprinkles", "extras", "Sprinkles", 300, 1),
  a("topper", "extras", "Cake topper", 1000, 0),
  a("name", "extras", "Name frosting", 500, 2, { acceptsText: true, textLabel: "Name on the cake", textMaxLength: 12 }),
  a("ghost", "old", "Ghost", 100, 0),
];
const groups = assembleGroups(groupRows, addonRows);

const deps: CartPricingDeps = {
  getProduct: async (id) => ({ cake, cookie } as Record<string, ProductRow>)[id],
  getActiveVariants: async (pid) => (pid === "cake" ? cakeVariants : []),
  getAddonGroups: async (pid) => (pid === "cake" ? groups : []),
};

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log("productAddons: vendor save");

  await test("valid payload is normalized: trimmed names, sort order from position, defaults", () => {
    const r = validateAddonGroupsPayload({ groups: [{ name: "  Fruit ", minSelect: 1, maxSelect: 3, addons: [{ name: " Kiwi " }, { name: "Mango", priceCents: 200 }] }] });
    assert.ok(r.ok);
    assert.equal(r.groups[0].name, "Fruit");
    assert.deepEqual(r.groups[0].addons.map((x) => [x.name, x.priceCents, x.sortOrder, x.isActive]), [["Kiwi", 0, 0, true], ["Mango", 200, 1, true]]);
    assert.equal(r.groups[0].addons[0].acceptsText, false);
  });

  await test("max below min, empty group, duplicate choice and bad price are refused", () => {
    const bad = [
      { groups: [{ name: "Fruit", minSelect: 3, maxSelect: 2, addons: [{ name: "A" }, { name: "B" }, { name: "C" }] }] },
      { groups: [{ name: "Fruit", addons: [] }] },
      { groups: [{ name: "Fruit", addons: [{ name: "Kiwi" }, { name: "kiwi" }] }] },
      { groups: [{ name: "Fruit", addons: [{ name: "Kiwi", priceCents: -1 }] }] },
      { groups: [{ name: "Fruit", addons: [{ name: "Kiwi", priceCents: 1.5 }] }] },
      { groups: [{ name: "", addons: [{ name: "Kiwi" }] }] },
      { nope: true },
    ];
    for (const b of bad) assert.equal(validateAddonGroupsPayload(b).ok, false, JSON.stringify(b));
  });

  await test("a required group needs at least as many switched-on choices as its minimum", () => {
    const r = validateAddonGroupsPayload({ groups: [{ name: "Fruit", minSelect: 2, addons: [{ name: "Kiwi" }, { name: "Mango", isActive: false }] }] });
    assert.equal(r.ok, false);
    const off = validateAddonGroupsPayload({ groups: [{ name: "Fruit", minSelect: 2, isActive: false, addons: [{ name: "Kiwi" }] }] });
    assert.equal(off.ok, true, "a switched-off group can be saved as a draft");
  });

  await test("text settings are kept only when the choice asks for text", () => {
    const r = validateAddonGroupsPayload({ groups: [{ name: "Extras", addons: [
      { name: "Name frosting", acceptsText: true, textLabel: "Name", textMaxLength: 20 },
      { name: "Sprinkles", textLabel: "ignored", textMaxLength: 5 },
    ] }] });
    assert.ok(r.ok);
    assert.deepEqual([r.groups[0].addons[0].textLabel, r.groups[0].addons[0].textMaxLength], ["Name", 20]);
    assert.deepEqual([r.groups[0].addons[1].textLabel, r.groups[0].addons[1].textMaxLength], [null, 40]);
    assert.equal(validateAddonGroupsPayload({ groups: [{ name: "E", addons: [{ name: "N", acceptsText: true, textMaxLength: 500 }] }] }).ok, false);
  });

  await test("ids from another product or another group are refused", () => {
    const own = validateAddonGroupsPayload({ groups: [{ id: "fruit", name: "Fruit", addons: [{ id: "kiwi", name: "Kiwi" }] }] });
    assert.ok(own.ok);
    assert.equal(checkPayloadIds(own.groups, groups), null);
    const foreignGroup = validateAddonGroupsPayload({ groups: [{ id: "someone-else", name: "Fruit", addons: [{ name: "Kiwi" }] }] });
    assert.ok(foreignGroup.ok);
    assert.equal(checkPayloadIds(foreignGroup.groups, groups)?.code, "INVALID_ADDON_ID");
    const moved = validateAddonGroupsPayload({ groups: [{ id: "extras", name: "Extras", addons: [{ id: "kiwi", name: "Kiwi" }] }] });
    assert.ok(moved.ok);
    assert.equal(checkPayloadIds(moved.groups, groups)?.code, "INVALID_ADDON_ID");
  });

  console.log("productAddons: public product");

  await test("customers see only switched-on groups and choices, in order", () => {
    const pub = toPublicGroups(groups);
    assert.deepEqual(pub.map((x) => x.id), ["fruit", "extras"]);
    assert.deepEqual(pub[0].addons.map((x) => x.id), ["strawberry", "kiwi", "mango", "blueberry"]);
    assert.deepEqual(pub[1].addons.map((x) => x.id), ["topper", "sprinkles", "name"]);
    assert.equal(pub[0].required, true);
    assert.equal(pub[1].required, false);
    assert.equal(pub[1].addons[2].textLabel, "Name on the cake");
    assert.ok(!("isActive" in pub[0].addons[0]), "no internal fields");
    assert.ok(!JSON.stringify(pub).includes("inventory") && !JSON.stringify(pub).includes("stock"), "no stock on add-ons");
  });

  await test("product list summary", () => {
    assert.deepEqual(summarizeAddons(groups), { groupCount: 2, hasRequired: true });
    assert.equal(summarizeAddons([]), null);
    assert.equal(summarizeAddons(assembleGroups([g("x", "X", 0, null, 0, false)], [a("y", "x", "Y", 0, 0)])), null);
  });

  console.log("productAddons: checkout");

  await test("picks are priced from the database in group and choice order", () => {
    const r = priceLineAddons(groups, [{ addonId: "sprinkles" }, { addonId: "mango" }, { addonId: "topper" }], "Cake");
    assert.ok(r.ok);
    assert.equal(r.perUnitCents, 1500);
    assert.deepEqual(r.addons.map((x) => x.addonId), ["mango", "topper", "sprinkles"]);
    assert.equal(addonsLabel(r.addons), "Mango, Cake topper, Sprinkles");
  });

  await test("required group, max limit, unknown, switched-off and duplicate picks are refused", () => {
    const code = (picks: unknown) => { const r = priceLineAddons(groups, picks, "Cake"); return r.ok ? "ok" : r.error.code; };
    assert.equal(code([]), "ADDON_REQUIRED");
    assert.equal(code([{ addonId: "sprinkles" }]), "ADDON_REQUIRED");
    assert.equal(code([{ addonId: "kiwi" }, { addonId: "mango" }, { addonId: "strawberry" }, { addonId: "blueberry" }]), "ADDON_LIMIT");
    assert.equal(code([{ addonId: "kiwi" }, { addonId: "nope" }]), "INVALID_ADDON");
    assert.equal(code([{ addonId: "kiwi" }, { addonId: "dragonfruit" }]), "INVALID_ADDON");
    assert.equal(code([{ addonId: "kiwi" }, { addonId: "ghost" }]), "INVALID_ADDON");
    assert.equal(code([{ addonId: "kiwi" }, { addonId: "kiwi" }]), "INVALID_ADDON");
    assert.equal(code("kiwi"), "INVALID_ADDON");
    assert.equal(code([{ addonId: "kiwi" }, { addonId: "mango" }, { addonId: "strawberry" }]), "ok");
  });

  await test("text: required when picked, limited, cleaned of line breaks, counted by character", () => {
    const run = (text: unknown) => priceLineAddons(groups, [{ addonId: "kiwi" }, { addonId: "name", text }], "Cake");
    const missing = run("   ");
    assert.equal(missing.ok ? "ok" : missing.error.code, "ADDON_TEXT_REQUIRED");
    const long = run("Happy Birthday Mia");
    assert.equal(long.ok ? "ok" : long.error.code, "ADDON_TEXT_TOO_LONG");
    const ok = run(" Mia\n🎉 ");
    assert.ok(ok.ok);
    assert.equal(ok.addons[1].text, "Mia 🎉");
    assert.equal(addonsLabel(ok.addons), 'Kiwi, Name frosting: "Mia 🎉"');
    const emoji = run("🎉".repeat(12));
    assert.ok(emoji.ok, "12 emoji fit a 12 character limit");
    const noText = priceLineAddons(groups, [{ addonId: "kiwi" }, { addonId: "sprinkles", text: "ignored" }], "Cake");
    assert.ok(noText.ok);
    assert.equal(noText.addons[1].text, undefined, "text on a choice that doesn't ask for it is dropped");
  });

  await test("order detail line joins variant and add-ons", () => {
    assert.equal(orderItemDetail({ variantLabel: "Pink", addonsLabel: "Kiwi, Sprinkles" }), "Pink · Kiwi, Sprinkles");
    assert.equal(orderItemDetail({ addonsLabel: "Kiwi" }), "Kiwi");
    assert.equal(orderItemDetail({ variantLabel: "Pink" }), "Pink");
    assert.equal(orderItemDetail({}), undefined);
  });

  console.log("cartPricing with add-ons");

  await test("line with a variant and add-ons: unit price = variant + add-ons, client price ignored", async () => {
    const r = await priceCartLines([{ productId: "cake", variantId: "white", vendorId: BIZ, priceCents: 1, quantity: 2, addons: [{ addonId: "kiwi" }, { addonId: "topper" }, { addonId: "name", text: "Mia" }] }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].priceCents, 9000 + 1000 + 500);
    assert.equal(r.lines[0].basePriceCents, 9000);
    assert.deepEqual(toOrderItem(r.lines[0]), {
      productId: "cake", name: "Fresh Fruit Cake", quantity: 2, price: 10500, variantId: "white", variantLabel: "White",
      basePrice: 9000,
      addons: [
        { addonId: "kiwi", groupName: "Fruit", name: "Kiwi", priceCents: 0 },
        { addonId: "topper", groupName: "Extras", name: "Cake topper", priceCents: 1000 },
        { addonId: "name", groupName: "Extras", name: "Name frosting", priceCents: 500, text: "Mia" },
      ],
      addonsLabel: 'Kiwi, Cake topper, Name frosting: "Mia"',
    });
  });

  await test("old app line (no addons key) on a product with a required group is priced as before and not refused", async () => {
    const r = await priceCartLines([{ productId: "cake", variantId: "pink", vendorId: BIZ, priceCents: 1, quantity: 1 }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].priceCents, 8500);
    assert.deepEqual(toOrderItem(r.lines[0]), { productId: "cake", name: "Fresh Fruit Cake", quantity: 1, price: 8500, variantId: "pink", variantLabel: "Pink" });
  });

  await test("new app line with a missing required pick is refused with the product id", async () => {
    const r = await priceCartLines([{ productId: "cake", variantId: "pink", vendorId: BIZ, priceCents: 8500, quantity: 1, addons: [] }], deps);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "ADDON_REQUIRED");
      assert.equal(r.error.productId, "cake");
    }
  });

  await test("empty add-ons on a product without groups stays byte-identical to an old line", async () => {
    const r = await priceCartLines([{ productId: "cookie", vendorId: BIZ, priceCents: 1, quantity: 3, addons: [] }], deps);
    assert.ok(r.ok);
    assert.deepEqual(toOrderItem(r.lines[0]), { productId: "cookie", name: "Apple Pie Cookies", quantity: 3, price: 1100 });
    assert.ok(!("addons" in r.lines[0]), "client addons key is not passed through");
  });

  await test("an add-on id from another product is refused", async () => {
    const r = await priceCartLines([{ productId: "cookie", vendorId: BIZ, priceCents: 1, quantity: 1, addons: [{ addonId: "sprinkles" }] }], deps);
    assert.equal(r.ok ? "ok" : r.error.code, "INVALID_ADDON");
  });

  await test("legacy line (unknown product) drops a client addons key and keeps its client price", async () => {
    const r = await priceCartLines([{ productId: "external-1", vendorId: BIZ, priceCents: 999, quantity: 1, addons: [{ addonId: "x" }] }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].priceCents, 999);
    assert.ok(!("addons" in r.lines[0]));
  });

  await test("stock message no longer tells the customer how many are left", async () => {
    const r = await priceCartLines([{ productId: "cake", variantId: "pink", vendorId: BIZ, priceCents: 1, quantity: 5 }], deps);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "INSUFFICIENT_STOCK");
      assert.ok(!/\d/.test(r.error.message), r.error.message);
    }
  });

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
