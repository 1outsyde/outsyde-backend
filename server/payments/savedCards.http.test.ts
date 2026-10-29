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
      if (req.method === "GET" && cust) return send(200, { id: cust[1], object: "customer" });
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
  } finally {
    if (userIds.length) await q(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [userIds]).catch((e: any) => console.error("cleanup", e.message));
    await db.end();
    stub.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
