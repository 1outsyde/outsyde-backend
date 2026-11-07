/**
 * Cart price preview (app payment methods, Step 1 Task 6).
 * POST /api/cart/price-preview answers the same total and fee breakdown POST /api/cart/payment-intent would
 * charge, and writes nothing (no order, no order group, no points code hold, no Stripe call).
 *
 * Run with: npx tsx server/cartPricePreview.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with the Stripe stub
 * preload, and this process must reach the same DB:
 *   EV_TEST_BASE_URL, EV_TEST_PG_URL, EV_TEST_STRIPE_PORT, JWT_SECRET (identical to the server's)
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe.
 */
import http from "http";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL + EV_TEST_STRIPE_PORT to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and EV_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  let stripeCalls = 0;
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "POST" && (req.url === "/v1/payment_intents" || req.url === "/v1/customers")) stripeCalls++;
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === "POST" && req.url === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
      if (req.method === "GET" && req.url?.startsWith("/v1/customers/")) return send(200, { id: req.url.split("/")[3], object: "customer" });
      if (req.method === "POST" && req.url === "/v1/payment_intents") {
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        return send(200, { id: piId, object: "payment_intent", amount: Number(form.get("amount") || 0), currency: "usd", status: "requires_payment_method", client_secret: `${piId}_secret_stub`, metadata: {} });
      }
      if (req.method === "POST" && req.url?.startsWith("/v1/payment_intents/") && req.url.endsWith("/cancel")) return send(200, { id: req.url.split("/")[3], object: "payment_intent", status: "canceled" });
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const P = `pp${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@pp.test`, isVendor]);
    return uid;
  };
  const vendorA = await mkUser("va", true);
  const vendorB = await mkUser("vb", true);
  const customer = await mkUser("cu", false);
  const bizA = id("bizA");
  const bizB = id("bizB");
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1,$2,'Shop A','retail','approved','acct_ppA',true),($3,$4,'Shop B','retail','approved','acct_ppB',true)`, [bizA, vendorA, bizB, vendorB]);
  const prodA = id("pa");
  const prodB = id("pb");
  await q(`INSERT INTO vendor_products (id, business_id, name, price, inventory, track_inventory, is_active, status) VALUES ($1,$2,'Herbs',1875,100,true,true,'live'),($3,$4,'Big Candle',7500,100,true,true,'live')`, [prodA, bizA, prodB, bizB]);
  const promo = id("promo");
  await q(`INSERT INTO promo_codes (id, code, user_id, points_cost, discount_cents, status, created_at, expires_at) VALUES ($1, $2, $3, 2500, 500, 'active', now(), now() + interval '30 days')`, [promo, `PP${Date.now().toString(36).toUpperCase()}`, customer]);
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false } as any);
  const shippingAddress = { line1: "1 Main St", city: "Freeport", state: "NY", zipCode: "11520" };
  // Client prices are deliberately wrong: both routes must price from the database.
  const oneA = [{ productId: prodA, vendorId: bizA, priceCents: 1, quantity: 2, name: "x" }];
  const oneB = [{ productId: prodB, vendorId: bizB, priceCents: 1, quantity: 1, name: "x" }];
  const two = [...oneA, ...oneB];
  const preview = (body: Record<string, unknown>, signedIn = true) => call("POST", "/api/cart/price-preview", { token: signedIn ? token : undefined, body });
  const charge = (body: Record<string, unknown>) => call("POST", "/api/cart/payment-intent", { token, body: { shippingAddress, ...body } });
  const counts = async () => ({
    orders: (await q(`SELECT count(*)::int n FROM orders WHERE customer_id = $1`, [customer]))[0].n,
    groups: (await q(`SELECT count(*)::int n FROM order_groups WHERE customer_id = $1`, [customer]))[0].n,
    promo: (await q(`SELECT status, used_on_order_id FROM promo_codes WHERE id = $1`, [promo]))[0],
  });

  try {
    console.log("auth and input");
    assert((await preview({ items: oneA }, false)).status === 401, "needs sign in");
    assert((await preview({ items: [] })).status === 400, "empty cart refused like checkout");
    const tooMany = [{ productId: prodA, vendorId: bizA, priceCents: 1875, quantity: 500, name: "x" }];
    const gone = await preview({ items: tooMany });
    const goneCharge = await charge({ items: tooMany });
    assert(gone.status === 400 && gone.status === goneCharge.status && gone.body?.error?.code === goneCharge.body?.error?.code, "over stock refused the same way as checkout", { p: gone.body, c: goneCharge.body });

    console.log("writes nothing");
    const c0 = await counts();
    const s0 = stripeCalls;
    const pv1 = await preview({ items: oneB, promoCodeId: promo });
    const pv2 = await preview({ items: two });
    const c1 = await counts();
    assert(pv1.status === 200 && pv2.status === 200, "previews answer", { pv1: pv1.body, pv2: pv2.body });
    assert(JSON.stringify(c0) === JSON.stringify(c1), "no order, no order group, the code isn't held", { c0, c1 });
    assert(stripeCalls === s0, "no PaymentIntent or customer made", stripeCalls - s0);

    console.log("matches the real charge: one shop, no code");
    const p1 = await preview({ items: oneA });
    const r1 = await charge({ items: oneA });
    assert(r1.status === 200 && p1.body?.amountChargedCents === r1.body?.feeBreakdown?.amountChargedCents, "same amount charged", { p: p1.body, r: r1.body?.feeBreakdown });
    assert(JSON.stringify(p1.body?.feeBreakdown) === JSON.stringify(r1.body?.feeBreakdown), "same fee breakdown", { p: p1.body?.feeBreakdown, r: r1.body?.feeBreakdown });
    assert(p1.body?.feeBreakdown?.basePriceCents === 3750, "priced from the database (2 x $18.75)", p1.body?.feeBreakdown);

    console.log("matches the real charge: one shop with a points code");
    const pB = await preview({ items: oneB, promoCodeId: promo });
    const rB = await charge({ items: oneB, promoCodeId: promo });
    assert(rB.status === 200 && pB.body?.amountChargedCents === rB.body?.feeBreakdown?.amountChargedCents && pB.body?.feeBreakdown?.discountCents === 500, "same discounted amount", { p: pB.body, r: rB.body?.feeBreakdown });
    assert(JSON.stringify(pB.body?.feeBreakdown) === JSON.stringify(rB.body?.feeBreakdown), "same fee breakdown with the code", { p: pB.body?.feeBreakdown, r: rB.body?.feeBreakdown });
    const small = await preview({ items: oneA.map((l) => ({ ...l, quantity: 1 })), promoCodeId: promo });
    const smallCharge = await charge({ items: oneA.map((l) => ({ ...l, quantity: 1 })), promoCodeId: promo });
    assert(small.status === 400 && small.body?.error?.code === smallCharge.body?.error?.code && small.body?.error?.code === "PROMO_MINIMUM_NOT_MET", "code below its minimum refused the same way", { small: small.body, smallCharge: smallCharge.body });

    console.log("matches the real charge: two shops");
    const p2 = await preview({ items: two });
    const r2 = await charge({ items: two });
    assert(r2.status === 200 && p2.body?.amountChargedCents === r2.body?.feeBreakdown?.totalChargedToConsumerCents, "same multi shop total", { p: p2.body, r: r2.body?.feeBreakdown });
    const multiPromo = await preview({ items: two, promoCodeId: promo });
    assert(multiPromo.status === 400 && multiPromo.body?.error?.code === "PROMO_SINGLE_SHOP_ONLY", "codes on two shops refused like checkout", multiPromo.body);
  } finally {
    const clean = async (sql: string, p: unknown[]) => q(sql, p).catch((e: any) => console.error("cleanup", e.message));
    await clean(`DELETE FROM orders WHERE customer_id = $1`, [customer]);
    await clean(`DELETE FROM order_groups WHERE customer_id = $1`, [customer]);
    await clean(`DELETE FROM promo_codes WHERE id = $1`, [promo]);
    await clean(`DELETE FROM vendor_products WHERE id IN ($1,$2)`, [prodA, prodB]);
    await clean(`DELETE FROM businesses WHERE id IN ($1,$2)`, [bizA, bizB]);
    await clean(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [vendorA, vendorB, customer]);
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
