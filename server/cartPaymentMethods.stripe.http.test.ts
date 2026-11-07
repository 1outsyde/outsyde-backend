/**
 * Product checkout payment methods (app payment methods, Step 1 Task 3).
 * POST /api/cart/payment-intent opens redirect methods only for `redirectCapable: true` (new app build).
 *
 * Run with: npx tsx server/cartPaymentMethods.stripe.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with the Stripe stub
 * preload, and this process must reach the same DB:
 *   EV_TEST_BASE_URL     e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL       the SAME scratch database     (localhost only; seeds + cleans up)
 *   EV_TEST_STRIPE_PORT  port for the Stripe stub started here (server booted with STRIPE_STUB_PORT=<same>)
 *   JWT_SECRET           identical to the server's
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

  // ── Stripe stub: records every PaymentIntent form ──
  const posted: URLSearchParams[] = [];
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(raw);
      if (req.method === "POST" && req.url === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
      if (req.method === "GET" && req.url?.startsWith("/v1/customers/")) return send(200, { id: req.url.split("/")[3], object: "customer" });
      if (req.method === "POST" && req.url === "/v1/payment_intents") {
        posted.push(form);
        const piId = `pi_stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        return send(200, { id: piId, object: "payment_intent", amount: Number(form.get("amount") || 0), currency: "usd", status: "requires_payment_method", client_secret: `${piId}_secret_stub`, metadata: {} });
      }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));
  const last = () => posted[posted.length - 1];

  // ── seed: two shops, one product each, one customer ──
  const P = `cm${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const mkUser = async (key: string, isVendor: boolean) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, $3)`, [uid, `${uid}@cm.test`, isVendor]);
    return uid;
  };
  const vendorA = await mkUser("va", true);
  const vendorB = await mkUser("vb", true);
  const customer = await mkUser("cu", false);
  const bizA = id("bizA");
  const bizB = id("bizB");
  await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete) VALUES ($1,$2,'Shop A','retail','approved','acct_cmA',true),($3,$4,'Shop B','retail','approved','acct_cmB',true)`, [bizA, vendorA, bizB, vendorB]);
  const prodA = id("pa");
  const prodB = id("pb");
  await q(`INSERT INTO vendor_products (id, business_id, name, price, inventory, track_inventory, is_active, status) VALUES ($1,$2,'Herbs',1875,100,true,true,'live'),($3,$4,'Candle',2400,100,true,true,'live')`, [prodA, bizA, prodB, bizB]);
  const token = generateAccessToken({ userId: customer, isVendor: false, isAdmin: false } as any);
  const shippingAddress = { line1: "1 Main St", city: "Freeport", state: "NY", zipCode: "11520" };
  const one = [{ productId: prodA, vendorId: bizA, priceCents: 1875, quantity: 1, name: "Herbs" }];
  const two = [...one, { productId: prodB, vendorId: bizB, priceCents: 2400, quantity: 1, name: "Candle" }];
  const pay = (items: unknown[], extra: Record<string, unknown> = {}) => call("POST", "/api/cart/payment-intent", { token, body: { items, shippingAddress, ...extra } });

  try {
    console.log("one shop");
    const a = await pay(one);
    assert(a.status === 200, "old request still works", a.body);
    assert(last()?.get("automatic_payment_methods[allow_redirects]") === "never", "old request keeps allow_redirects never", last() && Object.fromEntries(last()));
    assert(!last()?.has("setup_future_usage"), "shop payment still never saves a card on its own");
    const b = await pay(one, { redirectCapable: true });
    assert(b.status === 200, "new app request works", b.body);
    assert(last()?.get("automatic_payment_methods[enabled]") === "true" && !last()?.has("automatic_payment_methods[allow_redirects]"), "new app request opens redirect methods", last() && Object.fromEntries(last()));
    assert(last()?.get("transfer_data[destination]") === "acct_cmA", "still a destination charge to the shop");
    assert(!last()?.has("setup_future_usage"), "new app request saves no card on its own");
    assert(JSON.stringify(a.body?.feeBreakdown) === JSON.stringify(b.body?.feeBreakdown), "same fee breakdown with or without the flag", { a: a.body?.feeBreakdown, b: b.body?.feeBreakdown });
    const c = await pay(one, { redirectCapable: "true" });
    assert(c.status === 200 && last()?.get("automatic_payment_methods[allow_redirects]") === "never", "the string \"true\" does not open them");

    console.log("two shops");
    const before = posted.length;
    const m1 = await pay(two);
    assert(m1.status === 200, "old multi shop request works", m1.body);
    assert(last()?.get("automatic_payment_methods[allow_redirects]") === "never", "old multi shop request keeps never");
    const m2 = await pay(two, { redirectCapable: true });
    assert(m2.status === 200, "new app multi shop request works", m2.body);
    assert(posted.length === before + 2, "one PaymentIntent per checkout", posted.length - before);
    assert(!last()?.has("automatic_payment_methods[allow_redirects]") && !last()?.has("transfer_data[destination]"), "multi shop: redirect methods on, still a platform charge", Object.fromEntries(last()));
    const rowsFor = async (res: any) =>
      q(`SELECT business_id, total_amount, order_group_id FROM orders WHERE order_group_id = $1 ORDER BY business_id`, [res.body?.orderGroupId ?? "none"]);
    const r1 = await rowsFor(m1);
    const r2 = await rowsFor(m2);
    assert(r1.length === 2 && r2.length === 2, "one order per shop either way", { r1, r2 });
    assert(JSON.stringify(r1.map((r: any) => [r.business_id, r.total_amount])) === JSON.stringify(r2.map((r: any) => [r.business_id, r.total_amount])), "same per shop totals either way", { r1, r2 });
    assert(r2.every((r: any) => r.order_group_id && r.order_group_id === r2[0].order_group_id), "shared order group with the flag", r2);
    assert(JSON.stringify(m1.body?.feeBreakdown) === JSON.stringify(m2.body?.feeBreakdown), "same multi shop fee breakdown either way");
  } finally {
    await q(`DELETE FROM orders WHERE business_id IN ($1,$2)`, [bizA, bizB]).catch((e) => console.error("cleanup", e.message));
    await q(`DELETE FROM order_groups WHERE customer_id = $1`, [customer]).catch((e) => console.error("cleanup", e.message));
    await q(`DELETE FROM vendor_products WHERE id IN ($1,$2)`, [prodA, prodB]).catch((e) => console.error("cleanup", e.message));
    await q(`DELETE FROM businesses WHERE id IN ($1,$2)`, [bizA, bizB]).catch((e) => console.error("cleanup", e.message));
    await q(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [vendorA, vendorB, customer]).catch((e) => console.error("cleanup", e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
