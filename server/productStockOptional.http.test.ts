/**
 * Optional stock (2026-10-28) — HTTP checks for POST/PATCH /api/vendor/products and checkout.
 *
 * Run with: npx tsx server/productStockOptional.http.test.ts
 * SCRATCH ONLY: ST_TEST_BASE_URL + ST_TEST_PG_URL must both be localhost; the server must run with the
 * Stripe stub preload (STRIPE_STUB_PORT) and the same JWT_SECRET. Skips when ST_TEST_BASE_URL is unset.
 *
 * Proves: a product can be saved with no stock number (inventory null) and tracking off; numbers and
 * sold out (0) save as before; checkout never refuses a no-limit product and still refuses a sold out one.
 */
import http from "http";

const BASE = process.env.ST_TEST_BASE_URL;
const PG_URL = process.env.ST_TEST_PG_URL;
let passed = 0;
let failed = 0;
const assert = (c: boolean, n: string, d?: unknown) => {
  if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.error(`  ❌ ${n}`, d === undefined ? "" : JSON.stringify(d)); }
};
const isLocal = (u: string) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname);

function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Forwarded-For": "10.99.8.8" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j: any = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set ST_TEST_BASE_URL + ST_TEST_PG_URL"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing: localhost only");
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
  const P = `st${Date.now().toString(36)}`;
  const vendor = `${P}v`, customer = `${P}c`, biz = `${P}b`, tier = `${P}t`;
  try {
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [vendor, `${vendor}@st.test`]);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, false)`, [customer, `${customer}@st.test`]);
    await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, has_products, subscription_active)
             VALUES ($1, $2, 'Stock Test', 'food', 'approved', 'acct_st', true, true, true)`, [biz, vendor]);
    await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps) VALUES ($1, $2, 'T', 2900, 200)`, [tier, tier]);
    await q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, stripe_subscription_id, status) VALUES ($1, $2, $3, 'sub_st', 'active')`, [vendor, biz, tier]);
    const tv = generateAccessToken({ userId: vendor, isVendor: true, businessId: biz } as any);
    const tc = generateAccessToken({ userId: customer, isVendor: false } as any);
    const row = async (id: string) => (await q(`SELECT inventory, track_inventory FROM vendor_products WHERE id = $1`, [id]))[0];

    let r = await call("POST", "/api/vendor/products", tv, { name: "Cookies", price: 1000, inventory: null, trackInventory: false });
    const cookies = r.body?.product?.id;
    let x = await row(cookies);
    assert(r.status === 200 && x.inventory === null && x.track_inventory === false, "create with no stock number: inventory null, tracking off", { s: r.status, x });

    r = await call("POST", "/api/vendor/products", tv, { name: "Plain", price: 1000 });
    x = await row(r.body?.product?.id);
    assert(r.status === 200 && x.inventory === 0 && x.track_inventory === true, "create without the fields: same as before (0, tracking on)", x);
    await q(`DELETE FROM vendor_products WHERE id = $1`, [r.body?.product?.id]);

    r = await call("POST", "/api/vendor/products", tv, { name: "Mugs", price: 1500, inventory: 4, trackInventory: true });
    const mugs = r.body?.product?.id;
    x = await row(mugs);
    assert(r.status === 200 && x.inventory === 4 && x.track_inventory === true, "create with a count: saved as before", x);

    r = await call("PATCH", `/api/vendor/products/${mugs}`, tv, { inventory: 0, trackInventory: true });
    x = await row(mugs);
    assert(r.status === 200 && x.inventory === 0, "patch to sold out (0)", x);
    r = await call("PATCH", `/api/vendor/products/${mugs}`, tv, { inventory: null, trackInventory: false });
    x = await row(mugs);
    assert(r.status === 200 && x.inventory === null && x.track_inventory === false, "patch to no limit (null, tracking off)", x);
    r = await call("PATCH", `/api/vendor/products/${mugs}`, tv, { inventory: 7, trackInventory: true });
    x = await row(mugs);
    assert(r.status === 200 && x.inventory === 7 && x.track_inventory === true, "patch back to a count", x);
    r = await call("PATCH", `/api/vendor/products/${mugs}`, tv, { name: "Mugs 2" });
    x = await row(mugs);
    assert(r.status === 200 && x.inventory === 7, "patch without the field leaves stock alone", x);
    r = await call("PATCH", `/api/vendor/products/${mugs}`, tv, { inventory: "lots" });
    assert(r.status === 400, "text stock still refused", r.status);

    await q(`UPDATE vendor_products SET status = 'live' WHERE id = ANY($1)`, [[cookies, mugs]]);
    const pi = (items: unknown[]) => call("POST", "/api/cart/payment-intent", tc, { items, shippingAddress: { line1: "1 Main", city: "Freeport", state: "NY", zipCode: "11520" } });
    r = await pi([{ productId: cookies, vendorId: biz, priceCents: 1000, quantity: 500, name: "Cookies" }]);
    assert(r.status === 200 && r.body?.feeBreakdown?.basePriceCents === 500000, "no-limit product: 500 at checkout, never refused", { s: r.status, e: r.body?.error });
    r = await call("GET", `/api/products/${cookies}`, tc);
    assert(r.status === 200 && r.body?.inventory === null && r.body?.trackInventory === false, "public product route returns null stock + tracking off", { inv: r.body?.inventory, t: r.body?.trackInventory });

    await q(`UPDATE vendor_products SET inventory = 0, track_inventory = true WHERE id = $1`, [mugs]);
    r = await pi([{ productId: mugs, vendorId: biz, priceCents: 1500, quantity: 1, name: "Mugs 2" }]);
    assert(r.status === 400 && r.body?.error?.code === "INSUFFICIENT_STOCK" && r.body?.error?.message === "Mugs 2 is out of stock", "sold out still refused, no count in the message", r.body?.error);
  } finally {
    await q(`DELETE FROM orders WHERE business_id = $1`, [biz]).catch(() => {});
    await q(`DELETE FROM vendor_products WHERE business_id = $1`, [biz]);
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = $1`, [biz]);
    await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tier]);
    await q(`DELETE FROM businesses WHERE id = $1`, [biz]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [[vendor, customer]]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
