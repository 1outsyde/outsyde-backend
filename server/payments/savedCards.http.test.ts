/**
 * Saved card routes against a local server (p4-applepay step 1).
 *
 * Run with: npx tsx server/payments/savedCards.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres with the Stripe stub
 * preload, and this process must reach the same DB:
 *   EV_TEST_BASE_URL     e.g. http://localhost:5071   (must be localhost)
 *   EV_TEST_PG_URL       the SAME scratch database     (localhost only; seeds + cleans up)
 *   EV_TEST_STRIPE_PORT  port for the Stripe stub started here (server booted with STRIPE_STUB_PORT=<same>)
 *   JWT_SECRET           identical to the server's
 * Plan offer checks run in this process, so it also needs STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY (fake),
 * STRIPE_STUB_PORT=<same port>, DATABASE_URL (local) and
 * NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs".
 * Skips (exit 0) when EV_TEST_BASE_URL is unset; refuses any non-local host. Nothing reaches real Stripe.
 */
import http from "http";
import { SAVED_CARD_RULES_START } from "./savedCards";

const BASE = process.env.EV_TEST_BASE_URL;
const PG_URL = process.env.EV_TEST_PG_URL;
const STUB_PORT = Number(process.env.EV_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)); }
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

/** Stripe's form encoding, flattened: "metadata[outsyde_saved_card]" → value. */
function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set EV_TEST_BASE_URL + EV_TEST_PG_URL + EV_TEST_STRIPE_PORT to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) throw new Error("refusing to run: BASE and PG_URL must be localhost and EV_TEST_STRIPE_PORT set");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ev-test-jwt";
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  // ── Stripe stub ──
  const S = SAVED_CARD_RULES_START;
  type PM = { id: string; customer: string; created: number; allow_redisplay?: string; card: any };
  const pms: Record<string, PM[]> = {};
  const setupIntents: Record<string, any[]> = {};
  const created: { setupIntents: Record<string, string>[]; customerSessions: Record<string, string>[]; paymentIntents: Record<string, string>[] } = { setupIntents: [], customerSessions: [], paymentIntents: [] };
  const updates: { id: string; body: Record<string, string> }[] = [];
  let failSetupList = false;
  const invoiceDefault: Record<string, string> = {};
  const card = (fp: string | null, wallet?: string) => ({ brand: "visa", last4: "4242", exp_month: 8, exp_year: 2030, fingerprint: fp, wallet: wallet ? { type: wallet } : null });
  const addPm = (customer: string, id: string, o: { created: number; mark?: string; fp?: string | null; wallet?: string }) =>
    (pms[customer] ||= []).push({ id, customer, created: o.created, allow_redisplay: o.mark, card: card(o.fp === undefined ? `fp_${id}` : o.fp, o.wallet) });

  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url || "/", "http://stub");
      const body = parseForm(raw);
      if (req.method === "POST" && u.pathname === "/v1/customers") return send(200, { id: `cus_stub_${Date.now()}`, object: "customer" });
      const cust = u.pathname.match(/^\/v1\/customers\/([^/]+)$/);
      if (req.method === "GET" && cust) {
        const def = invoiceDefault[cust[1]];
        const pmObj = def ? (pms[cust[1]] || []).find((p) => p.id === def) : undefined;
        return send(200, { id: cust[1], object: "customer", invoice_settings: { default_payment_method: pmObj ? { object: "payment_method", type: "card", ...pmObj } : null } });
      }
      if (req.method === "POST" && u.pathname === "/v1/payment_intents") {
        created.paymentIntents.push(body);
        const id = `pi_stub_${created.paymentIntents.length}_${Date.now()}`;
        return send(200, { id, object: "payment_intent", client_secret: `${id}_secret`, amount: Number(body.amount), status: "requires_payment_method", customer: body.customer ?? null, capture_method: body.capture_method ?? "automatic", metadata: {} });
      }
      if (req.method === "GET" && u.pathname === "/v1/payment_methods") {
        const list = (pms[u.searchParams.get("customer") || ""] || []).map((p) => ({ object: "payment_method", type: "card", ...p }));
        return send(200, { object: "list", data: list, has_more: false });
      }
      const pmUpdate = u.pathname.match(/^\/v1\/payment_methods\/([^/]+)$/);
      if (req.method === "POST" && pmUpdate) {
        updates.push({ id: pmUpdate[1], body });
        for (const list of Object.values(pms)) for (const p of list) if (p.id === pmUpdate[1] && body.allow_redisplay) p.allow_redisplay = body.allow_redisplay;
        return send(200, { id: pmUpdate[1], object: "payment_method" });
      }
      if (req.method === "GET" && u.pathname === "/v1/setup_intents") {
        if (failSetupList) return send(500, { error: { type: "api_error", message: "stub outage" } });
        return send(200, { object: "list", data: setupIntents[u.searchParams.get("customer") || ""] || [], has_more: false });
      }
      if (req.method === "POST" && u.pathname === "/v1/setup_intents") {
        created.setupIntents.push(body);
        return send(200, { id: `seti_${Date.now()}`, object: "setup_intent", client_secret: "seti_secret_stub" });
      }
      if (req.method === "POST" && u.pathname === "/v1/customer_sessions") {
        created.customerSessions.push(body);
        return send(200, { object: "customer_session", client_secret: `cuss_secret_${body.customer}`, customer: body.customer });
      }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const P = `sc${Date.now().toString(36)}`;
  const userIds: string[] = [];
  const mkUser = async (s: string, customer: string | null) => {
    const id = (await q(
      `INSERT INTO users (id, email, name, first_name, username, stripe_customer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
      [`${P}-${s}@test.local`, `Card ${s}`, `Card${s}`, `${P}${s}`.slice(0, 20), customer],
    ))[0].id as string;
    userIds.push(id);
    return id;
  };
  const tok = (id: string) => generateAccessToken({ userId: id, isVendor: false });

  try {
    console.log("Saved card list");
    const cA = `cus_${P}_a`;
    const uA = await mkUser("a", cA);
    addPm(cA, "pm_always", { created: S + 500, mark: "always" });
    addPm(cA, "pm_limited", { created: S - 900, mark: "limited" });
    addPm(cA, "pm_apple", { created: S + 600, mark: "always", wallet: "apple_pay" });
    addPm(cA, "pm_old", { created: S - 800, mark: "unspecified", fp: "dup" });
    addPm(cA, "pm_old_dup", { created: S - 700, mark: "unspecified", fp: "dup" });
    addPm(cA, "pm_foreign", { created: S + 100, mark: "unspecified" });
    const list = await call("GET", "/api/me/payment-methods", { token: tok(uA) });
    const listIds = (list.body?.paymentMethods || []).map((p: any) => p.id);
    assert(list.status === 200, "list answers 200", list);
    assert(!listIds.includes("pm_limited") && !listIds.includes("pm_apple"), "list hides limited and wallet cards", listIds);
    assert(listIds.filter((i: string) => i === "pm_old" || i === "pm_old_dup").length === 1, "list merges duplicates", listIds);
    assert(JSON.stringify(list.body?.olderPaymentMethodIds) === JSON.stringify(["pm_old_dup"]), "list returns olderPaymentMethodIds", list.body?.olderPaymentMethodIds);
    assert(!listIds.includes("pm_foreign"), "foreign unmarked card after start stays hidden", listIds);
    assert(listIds.join() === "pm_always,pm_old_dup", "list order is chosen then older", listIds);

    console.log("Default card");
    await q(`UPDATE users SET default_payment_method_id = 'pm_apple' WHERE id = $1`, [uA]);
    const withWalletDefault = await call("GET", "/api/me/payment-methods", { token: tok(uA) });
    assert(withWalletDefault.body?.defaultPaymentMethodId === null, "a hidden default is returned as null", withWalletDefault.body?.defaultPaymentMethodId);
    await q(`UPDATE users SET default_payment_method_id = 'pm_old' WHERE id = $1`, [uA]);
    const withOldDefault = await call("GET", "/api/me/payment-methods", { token: tok(uA) });
    const oldDefaultIds = (withOldDefault.body?.paymentMethods || []).map((p: any) => p.id);
    assert(withOldDefault.body?.defaultPaymentMethodId === "pm_old" && oldDefaultIds[0] === "pm_old", "an older default card stays up front", { ids: oldDefaultIds, d: withOldDefault.body?.defaultPaymentMethodId });

    console.log("Shop Save switch");
    const cB = `cus_${P}_b`;
    const uB = await mkUser("b", cB);
    const si = await call("POST", "/api/me/payment-methods/setup-intent", { token: tok(uB) });
    assert(si.status === 200 && created.setupIntents.at(-1)?.["metadata[outsyde_saved_card]"] === "1", "setup intent carries outsyde_saved_card", created.setupIntents.at(-1));
    addPm(cB, "pm_saved_by_switch", { created: S + 1000, mark: "unspecified" });
    addPm(cB, "pm_left_by_booking", { created: S + 1100, mark: "unspecified" });
    setupIntents[cB] = [
      { id: "seti_ok", object: "setup_intent", status: "succeeded", payment_method: "pm_saved_by_switch", metadata: { outsyde_saved_card: "1" } },
      { id: "seti_other", object: "setup_intent", status: "succeeded", payment_method: "pm_left_by_booking", metadata: {} },
    ];
    const listB = await call("GET", "/api/me/payment-methods", { token: tok(uB) });
    const idsB = (listB.body?.paymentMethods || []).map((p: any) => p.id);
    assert(idsB.join() === "pm_saved_by_switch", "card from our setup intent after start is shown", idsB);
    assert(updates.some((x) => x.id === "pm_saved_by_switch" && x.body.allow_redisplay === "always"), "card from our setup intent is promoted to always", updates);
    assert(!updates.some((x) => x.id === "pm_left_by_booking"), "card from another setup intent is not promoted", updates);

    console.log("Stripe outage");
    const cC = `cus_${P}_c`;
    const uC = await mkUser("c", cC);
    addPm(cC, "pm_c_always", { created: S + 5, mark: "always" });
    addPm(cC, "pm_c_new", { created: S + 6, mark: "unspecified" });
    failSetupList = true;
    const listC = await call("GET", "/api/me/payment-methods", { token: tok(uC) });
    failSetupList = false;
    assert(listC.status === 200 && (listC.body?.paymentMethods || []).map((p: any) => p.id).join() === "pm_c_always", "stub outage on setupIntents.list still returns the rest", listC);

    const uNone = await mkUser("none", null);
    const listNone = await call("GET", "/api/me/payment-methods", { token: tok(uNone) });
    assert(listNone.status === 200 && listNone.body?.paymentMethods?.length === 0 && Array.isArray(listNone.body?.olderPaymentMethodIds), "no Stripe customer gives empty lists", listNone.body);

    console.log("Shop payments");
    const vendorId = await mkUser("v", null);
    await q(`UPDATE users SET is_vendor = true WHERE id = $1`, [vendorId]);
    const tier = `${P}t`;
    await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps) VALUES ($1, $2, 'T', 2900, 200)`, [tier, tier]);
    const bizIds: string[] = [];
    const productIds: string[] = [];
    for (const n of ["1", "2"]) {
      const biz = `${P}b${n}`;
      bizIds.push(biz);
      await q(`INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, has_products, subscription_active)
               VALUES ($1, $2, $3, 'food', 'approved', $4, true, true, true)`, [biz, vendorId, `Card Shop ${n}`, `acct_${P}${n}`]);
      await q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, stripe_subscription_id, status) VALUES ($1, $2, $3, $4, 'active')`, [vendorId, biz, tier, `sub_${P}${n}`]);
      const tv = generateAccessToken({ userId: vendorId, isVendor: true, businessId: biz } as any);
      const r = await call("POST", "/api/vendor/products", { token: tv, body: { name: `Item ${n}`, price: 1000, inventory: null, trackInventory: false } });
      productIds.push(r.body?.product?.id);
    }
    for (let i = 0; i < 2; i++) await q(`UPDATE vendor_products SET business_id = $2 WHERE id = $1`, [productIds[i], bizIds[i]]);
    await q(`UPDATE vendor_products SET status = 'live' WHERE id = ANY($1)`, [productIds]);
    const shopper = await mkUser("shop", `cus_${P}_shop`);
    const ship = { line1: "1 Main", city: "Freeport", state: "NY", zipCode: "11520" };
    const item = (i: number) => ({ productId: productIds[i], vendorId: bizIds[i], priceCents: 1000, quantity: 1, name: `Item ${i + 1}` });
    try {
      let before = created.paymentIntents.length;
      let r = await call("POST", "/api/cart/payment-intent", { token: tok(shopper), body: { items: [item(0)], shippingAddress: ship } });
      const one = created.paymentIntents.slice(before);
      assert(r.status === 200 && one.length === 1 && one[0]["metadata[type]"] === "product_purchase", "one shop cart makes a product_purchase payment", { s: r.status, e: r.body?.error, one });
      assert(one.length === 1 && one[0].setup_future_usage === undefined, "one shop cart payment has no setup_future_usage", one[0]);
      before = created.paymentIntents.length;
      r = await call("POST", "/api/cart/payment-intent", { token: tok(shopper), body: { items: [item(0), item(1)], shippingAddress: ship } });
      const multi = created.paymentIntents.slice(before);
      assert(r.status === 200 && multi.length === 1 && multi[0]["metadata[type]"] === "multi_vendor_product_purchase", "two shop cart makes a multi_vendor_product_purchase payment", { s: r.status, e: r.body?.error, multi });
      assert(multi.length === 1 && multi[0].setup_future_usage === undefined, "two shop cart payment has no setup_future_usage", multi[0]);
    } finally {
      await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE business_id = ANY($1))`, [bizIds]).catch(() => {});
      await q(`DELETE FROM orders WHERE business_id = ANY($1)`, [bizIds]).catch(() => {});
      await q(`DELETE FROM order_groups WHERE user_id = $1`, [shopper]).catch(() => {});
      await q(`DELETE FROM vendor_products WHERE business_id = ANY($1)`, [bizIds]).catch(() => {});
      await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizIds]).catch(() => {});
      await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizIds]).catch(() => {});
      await q(`DELETE FROM subscription_tiers WHERE id = $1`, [tier]).catch(() => {});
    }

    console.log("Plan offer card");
    const { findSavedCard } = await import("../subscriptions/planOffers");
    const cD = `cus_${P}_d`;
    addPm(cD, "pm_d_apple", { created: S + 50, mark: "always", wallet: "apple_pay" });
    addPm(cD, "pm_d_old", { created: S - 50, mark: "unspecified" });
    invoiceDefault[cD] = "pm_d_apple";
    const offerCard = await findSavedCard(cD);
    assert(offerCard?.id === "pm_d_old", "plan offer skips an Apple Pay default and keeps the other card", offerCard);
    const cE = `cus_${P}_e`;
    addPm(cE, "pm_e_sub", { created: S + 50, mark: "limited" });
    assert((await findSavedCard(cE))?.id === "pm_e_sub", "plan offer keeps a card its subscription saved (limited)", await findSavedCard(cE));
    const cF = `cus_${P}_f`;
    addPm(cF, "pm_f_apple", { created: S + 50, mark: "always", wallet: "apple_pay" });
    assert((await findSavedCard(cF)) === null, "plan offer with only an Apple Pay card has no one tap card");
  } finally {
    if (userIds.length) await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [userIds]).catch((e: any) => console.error("cleanup", e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
