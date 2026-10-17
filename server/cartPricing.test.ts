/**
 * Cart pricing tests — run with: npx tsx server/cartPricing.test.ts
 * In-memory lookups only: no database, no Stripe.
 */

import assert from "node:assert/strict";
import { priceCartLines, toOrderItem, type ProductRow, type VariantRow, type CartPricingDeps } from "./cartPricing";

const LOTUS = "biz-lotus";
const CRASH = "biz-crash";

const products: Record<string, ProductRow> = {
  tea: { id: "tea", businessId: LOTUS, name: "Dream Temple Tea Box", price: 1200, inventory: 50, trackInventory: true, isActive: true, status: "live" },
  herbs: { id: "herbs", businessId: LOTUS, name: "Heart Flow Loose-Herbs", price: 1875, inventory: 2, trackInventory: true, isActive: true, status: "live" },
  draft: { id: "draft", businessId: LOTUS, name: "Draft Product", price: 500, inventory: 10, trackInventory: true, isActive: true, status: "draft" },
  bundle: { id: "bundle", businessId: CRASH, name: "Raw Straight Bundle", price: 12500, inventory: 0, trackInventory: true, isActive: true, status: "live" },
};
const variants: Record<string, VariantRow[]> = {
  bundle: [
    { id: "v18", productId: "bundle", label: '18"', priceCents: 15500, inventory: 3, trackInventory: true, isActive: true },
    { id: "v30", productId: "bundle", label: '30"', priceCents: 22500, inventory: 0, trackInventory: true, isActive: true },
    { id: "v32", productId: "bundle", label: '32"', priceCents: 23500, inventory: null, trackInventory: true, isActive: true },
  ],
};

const legacyLogged: unknown[] = [];
const deps: CartPricingDeps = {
  getProduct: async (id) => products[id],
  getActiveVariants: async (pid) => variants[pid] ?? [],
  logLegacyLine: (l) => legacyLogged.push(l),
};

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log("cartPricing");

  await test("tampered price on a real product is replaced by the database price", async () => {
    const r = await priceCartLines([{ productId: "tea", vendorId: LOTUS, priceCents: 1, quantity: 2, name: "x" }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].priceCents, 1200);
    assert.equal(r.lines[0].name, "Dream Temple Tea Box");
    assert.equal(r.lines[0].dbPriced, true);
  });

  await test("picked variant is priced from the variant and kept on the order item", async () => {
    const r = await priceCartLines([{ productId: "bundle", variantId: "v18", vendorId: CRASH, priceCents: 100, quantity: 1 }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].priceCents, 15500);
    assert.deepEqual(toOrderItem(r.lines[0]), { productId: "bundle", name: "Raw Straight Bundle", quantity: 1, price: 15500, variantId: "v18", variantLabel: '18"' });
  });

  await test("product with variants and no variant picked is refused (VARIANT_REQUIRED)", async () => {
    const r = await priceCartLines([{ productId: "bundle", vendorId: CRASH, priceCents: 12500, quantity: 1 }], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "VARIANT_REQUIRED");
  });

  await test("variant from another product or inactive is refused (INVALID_VARIANT)", async () => {
    const r = await priceCartLines([{ productId: "bundle", variantId: "nope", vendorId: CRASH, priceCents: 1, quantity: 1 }], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "INVALID_VARIANT");
  });

  await test("sold-out variant is refused even though the product row says 0 too", async () => {
    const r = await priceCartLines([{ productId: "bundle", variantId: "v30", vendorId: CRASH, priceCents: 22500, quantity: 1 }], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "INSUFFICIENT_STOCK");
  });

  await test("variant with no stock count of its own falls back to product stock (0 here)", async () => {
    const r = await priceCartLines([{ productId: "bundle", variantId: "v32", vendorId: CRASH, priceCents: 23500, quantity: 1 }], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "INSUFFICIENT_STOCK");
  });

  await test("stock is counted across duplicate lines of the same variant", async () => {
    const line = { productId: "bundle", variantId: "v18", vendorId: CRASH, priceCents: 15500, quantity: 2 };
    const r = await priceCartLines([line, line], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "INSUFFICIENT_STOCK");
    assert.equal(r.error.available, 3);
  });

  await test("quantity over product stock is refused", async () => {
    const r = await priceCartLines([{ productId: "herbs", vendorId: LOTUS, priceCents: 1875, quantity: 3 }], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "INSUFFICIENT_STOCK");
  });

  await test("product sent with another store's vendorId is refused", async () => {
    const r = await priceCartLines([{ productId: "tea", vendorId: CRASH, priceCents: 1200, quantity: 1 }], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "PRODUCT_VENDOR_MISMATCH");
  });

  await test("product that is not live is refused", async () => {
    const r = await priceCartLines([{ productId: "draft", vendorId: LOTUS, priceCents: 500, quantity: 1 }], deps);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "PRODUCT_UNAVAILABLE");
  });

  await test("goutsyde.com line with no productId keeps the client price (legacy) and is logged", async () => {
    legacyLogged.length = 0;
    const r = await priceCartLines([{ isExternalProduct: true, vendorId: LOTUS, priceCents: 1875, quantity: 1, name: "Heart Flow Loose-Herbs" }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].priceCents, 1875);
    assert.equal(r.lines[0].dbPriced, false);
    assert.equal(legacyLogged.length, 1);
    assert.deepEqual(toOrderItem(r.lines[0]), { productId: undefined, name: "Heart Flow Loose-Herbs", quantity: 1, price: 1875 });
  });

  await test("app production-shoot line (productId 'shoot_booking') keeps the client price", async () => {
    const r = await priceCartLines([{ productId: "shoot_booking", vendorId: LOTUS, priceCents: 25000, quantity: 1, name: "Production Shoot Booking" }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].priceCents, 25000);
    assert.equal(r.lines[0].dbPriced, false);
  });

  await test("a variantId on a legacy line is dropped, never trusted", async () => {
    const r = await priceCartLines([{ productId: "unknown", variantId: "v18", vendorId: LOTUS, priceCents: 999, quantity: 1, name: "X" }], deps);
    assert.ok(r.ok);
    assert.equal(r.lines[0].variantId, undefined);
    assert.equal(toOrderItem(r.lines[0]).variantId, undefined);
  });

  await test("mixed multi-vendor cart: real lines priced from db, totals per vendor correct", async () => {
    const r = await priceCartLines([
      { productId: "tea", vendorId: LOTUS, priceCents: 1, quantity: 2 },
      { productId: "bundle", variantId: "v18", vendorId: CRASH, priceCents: 1, quantity: 1 },
    ], deps);
    assert.ok(r.ok);
    const sum = (v: string) => r.lines.filter((l) => l.vendorId === v).reduce((s, l) => s + l.priceCents * l.quantity, 0);
    assert.equal(sum(LOTUS), 2400);
    assert.equal(sum(CRASH), 15500);
  });

  await test("plain product order item has no variant keys (unchanged shape)", async () => {
    const r = await priceCartLines([{ productId: "tea", vendorId: LOTUS, priceCents: 1200, quantity: 1 }], deps);
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(toOrderItem(r.lines[0])).sort(), ["name", "price", "productId", "quantity"]);
  });

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
