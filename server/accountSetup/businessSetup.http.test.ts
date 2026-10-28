/**
 * Business setup checklist backend (migration 076) — HTTP integration tests.
 *
 * Run with: npx tsx server/accountSetup/businessSetup.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres (full schema +
 * migration 076) with the Stripe stub preload. Environment variables:
 *
 *   BS_TEST_BASE_URL     e.g. http://localhost:5062   (must be localhost)
 *   BS_TEST_PG_URL       the SAME scratch database (localhost only; seeds + cleans up)
 *   BS_TEST_STRIPE_PORT  port for the Stripe stub started here; boot the server with STRIPE_STUB_PORT=<same>
 *                        and NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
 *   JWT_SECRET           identical to the server's
 *
 * Skips (exit 0) when BS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * What it proves:
 *  - PUT /api/vendor/my-business/cancellation-policy saves the whole policy, stamps cancellation_policy_set_at,
 *    clears parts that are switched off, refuses bad input without writing, never touches services or other businesses
 *  - admin (JWT isAdmin) + x-business-id saves the named business; a vendor's x-business-id is ignored
 *  - apply-cancellation-policy-to-all works with a Bearer token only and stamps the flag
 *  - defaultDepositCents saves through PATCH /api/vendor/my-business ($7 minimum), is never applied to a new
 *    or existing service, and policy fields sent to my-business are still dropped
 *  - GET /api/vendor/setup-status steps for owner and admin, Stripe self-heal for payouts, plan from the subscription
 *  - the public business DTO does not gain the new fields
 */
import http from "http";

const BASE = process.env.BS_TEST_BASE_URL;
const PG_URL = process.env.BS_TEST_PG_URL;
const STUB_PORT = Number(process.env.BS_TEST_STRIPE_PORT || "0");

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(
  method: string,
  path: string,
  o: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": "10.99.7.6", ...(o.headers ?? {}) };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) {
    console.log("⏭  skipped: set BS_TEST_BASE_URL (+ BS_TEST_PG_URL, BS_TEST_STRIPE_PORT) to run");
    process.exit(0);
  }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL) || !STUB_PORT) {
    throw new Error("refusing to run: BASE and PG_URL must both be localhost, BS_TEST_STRIPE_PORT must be set");
  }
  const { generateAccessToken } = await import("../auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  // Stripe stub: only Connect account status is asked for.
  const accountCalls: string[] = [];
  const completeAccounts = new Set<string>();
  const stub = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const m = req.url?.match(/^\/v1\/accounts\/([^/?]+)/);
      if (req.method === "GET" && m) {
        accountCalls.push(m[1]);
        const ok = completeAccounts.has(m[1]);
        return send(200, { id: m[1], object: "account", charges_enabled: ok, payouts_enabled: ok, details_submitted: ok, requirements: { currently_due: [] } });
      }
      send(404, { error: { type: "invalid_request_error", message: `stub: no route ${req.method} ${req.url}` } });
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));

  const P = `bs${Date.now().toString(36)}`;
  const id = (s: string) => `${P}-${s}`;
  const users: string[] = [];
  const biz: string[] = [];
  const tiers: string[] = [];

  const mkUser = async (key: string) => {
    const uid = id(key);
    await q(`INSERT INTO users (id, username, email, is_vendor) VALUES ($1::varchar, $1::text, $2, true)`, [uid, `${uid}@bs.test`]);
    users.push(uid);
    return uid;
  };
  const mkBiz = async (key: string, ownerId: string, o: { approval?: string; account?: string | null; onboarded?: boolean; hasServices?: boolean } = {}) => {
    const bid = id(key);
    await q(
      `INSERT INTO businesses (id, owner_id, name, category, approval_status, stripe_account_id, stripe_onboarding_complete, has_services, has_products)
       VALUES ($1, $2, $3, 'beauty', $4, $5, $6, $7, false)`,
      [bid, ownerId, `Biz ${key}`, o.approval ?? "approved", o.account ?? null, o.onboarded ?? false, o.hasServices ?? true],
    );
    biz.push(bid);
    return bid;
  };
  const mkSvc = async (key: string, bizId: string, o: { image?: string | null; deposit?: number | null; status?: string } = {}) => {
    const sid = id(key);
    await q(
      `INSERT INTO vendor_services (id, business_id, name, price, duration_minutes, deposit_amount_cents, image_url, is_active, status, full_refund_window)
       VALUES ($1, $2, $3, 7000, 60, $4, $5, true, $6, 'never')`,
      [sid, bizId, `Svc ${key}`, o.deposit ?? null, o.image ?? null, o.status ?? "live"],
    );
    return sid;
  };
  const bizRow = async (bid: string) => (await q(`SELECT * FROM businesses WHERE id = $1`, [bid]))[0];
  const tok = (uid: string, bid: string) => generateAccessToken({ userId: uid, isVendor: true, businessId: bid } as any);

  try {
    const ownerA = await mkUser("ownerA");
    const ownerB = await mkUser("ownerB");
    const adminU = await mkUser("admin");
    const bizA = await mkBiz("A", ownerA, { account: `acct_${P}A`, onboarded: false });
    const bizB = await mkBiz("B", ownerB, { approval: "pending" });
    const tA = tok(ownerA, bizA);
    const tB = tok(ownerB, bizB);
    const tAdmin = generateAccessToken({ userId: adminU, isVendor: false, isAdmin: true } as any);
    const svc1 = await mkSvc("s1", bizA, { image: null, deposit: 2000 });
    const svc2 = await mkSvc("s2", bizA, { image: "https://cdn.example/s2.jpg" });
    const svcB = await mkSvc("sB", bizB, {});

    console.log("auth");
    assert((await call("PUT", "/api/vendor/my-business/cancellation-policy", { body: { fullRefundWindow: "never" } })).status === 401, "policy save without sign-in → 401");
    assert((await call("GET", "/api/vendor/setup-status")).status === 401, "setup status without sign-in → 401");
    assert((await call("POST", `/api/vendor/services/${svc1}/apply-cancellation-policy-to-all`)).status === 401, "apply to all without sign-in → 401");

    console.log("policy save");
    let r = await call("PUT", "/api/vendor/my-business/cancellation-policy", { token: tA, body: { fullRefundWindow: "2_days" } });
    let row = await bizRow(bizA);
    assert(r.status === 400 && r.body?.code === "INVALID_POLICY" && row.cancellation_policy_set_at === null, "bad window → 400, nothing saved", r.body);
    r = await call("PUT", "/api/vendor/my-business/cancellation-policy", { token: tA, body: { fullRefundWindow: "1_week", hasCancellationFee: true, cancellationFeeAmount: 500 } });
    row = await bizRow(bizA);
    assert(r.status === 400 && row.cancellation_policy_set_at === null && row.has_cancellation_fee === false, "fee with no type → 400, nothing saved", r.body);

    r = await call("PUT", "/api/vendor/my-business/cancellation-policy", { token: tA, body: { fullRefundWindow: "never" } });
    row = await bizRow(bizA);
    assert(r.status === 200 && row.cancellation_policy_set_at !== null && row.full_refund_window === "never", "'never' chosen → saved and stamped", { s: r.status, at: row.cancellation_policy_set_at });
    assert(r.body?.business?.cancellationPolicySetAt != null && r.body?.business?.id === bizA, "response returns the business with the stamp");
    const firstStamp = new Date(row.cancellation_policy_set_at).getTime();

    r = await call("PUT", "/api/vendor/my-business/cancellation-policy", {
      token: tA,
      body: { fullRefundWindow: "48_hours", hasPartialRefund: true, partialRefundWindow: "24_hours", partialRefundPercentage: 50, hasCancellationFee: true, cancellationFeeType: "flat", cancellationFeeAmount: 1000 },
    });
    row = await bizRow(bizA);
    assert(r.status === 200 && row.full_refund_window === "48_hours" && row.partial_refund_percentage === 50 && row.cancellation_fee_amount === 1000 && row.cancellation_fee_type === "flat",
      "full policy saved", row);
    assert(new Date(row.cancellation_policy_set_at).getTime() >= firstStamp, "stamp moves forward on each save");

    r = await call("PUT", "/api/vendor/my-business/cancellation-policy", { token: tA, body: { fullRefundWindow: "24_hours", hasPartialRefund: false, partialRefundPercentage: 50, hasCancellationFee: false, cancellationFeeAmount: 1000 } });
    row = await bizRow(bizA);
    assert(r.status === 200 && row.has_partial_refund === false && row.partial_refund_percentage === null && row.partial_refund_window === null && row.has_cancellation_fee === false && row.cancellation_fee_amount === null && row.cancellation_fee_type === null,
      "switched off parts are cleared", row);

    const svcRows = await q(`SELECT id, full_refund_window FROM vendor_services WHERE business_id = $1`, [bizA]);
    assert(svcRows.every((s) => s.full_refund_window === "never"), "services are not changed by the business save", svcRows);
    let rowB = await bizRow(bizB);
    assert(rowB.cancellation_policy_set_at === null && rowB.full_refund_window === "never", "other business untouched");

    r = await call("PUT", "/api/vendor/my-business/cancellation-policy", { token: tB, body: { fullRefundWindow: "1_hour" }, headers: { "x-business-id": bizA } });
    row = await bizRow(bizA); rowB = await bizRow(bizB);
    assert(r.status === 200 && row.full_refund_window === "24_hours" && rowB.full_refund_window === "1_hour" && rowB.cancellation_policy_set_at !== null,
      "vendor's x-business-id is ignored (saves their own business)", { a: row.full_refund_window, b: rowB.full_refund_window });

    r = await call("PUT", "/api/vendor/my-business/cancellation-policy", { token: tAdmin, body: { fullRefundWindow: "1_week" }, headers: { "x-business-id": bizB } });
    rowB = await bizRow(bizB);
    assert(r.status === 200 && rowB.full_refund_window === "1_week", "admin + x-business-id saves the named business", r.body?.error);
    r = await call("PUT", "/api/vendor/my-business/cancellation-policy", { token: tAdmin, body: { fullRefundWindow: "1_week" } });
    assert(r.status === 404, "admin without x-business-id and no business → 404", r.status);

    console.log("apply to all (Bearer only)");
    await q(`UPDATE businesses SET cancellation_policy_set_at = NULL WHERE id = $1`, [bizA]);
    await q(`UPDATE vendor_services SET full_refund_window = '1_week', has_cancellation_fee = true, cancellation_fee_type = 'percentage', cancellation_fee_amount = 20 WHERE id = $1`, [svc1]);
    r = await call("POST", `/api/vendor/services/${svc1}/apply-cancellation-policy-to-all`, { token: tA });
    row = await bizRow(bizA);
    const s2 = (await q(`SELECT * FROM vendor_services WHERE id = $1`, [svc2]))[0];
    const sB = (await q(`SELECT * FROM vendor_services WHERE id = $1`, [svcB]))[0];
    assert(r.status === 200 && r.body?.updatedCount === 1, "Bearer token works (was session cookie only)", r);
    assert(row.cancellation_policy_set_at !== null && row.full_refund_window === "1_week" && row.cancellation_fee_amount === 20, "business policy copied and stamped", row);
    assert(s2.full_refund_window === "1_week" && s2.cancellation_fee_type === "percentage" && sB.full_refund_window === "never", "other service updated; other business's service untouched");
    r = await call("POST", `/api/vendor/services/${svcB}/apply-cancellation-policy-to-all`, { token: tA });
    assert(r.status === 404, "another business's service → 404", r.status);

    console.log("default deposit");
    r = await call("PATCH", "/api/vendor/my-business", { token: tA, body: { defaultDepositCents: 500 } });
    row = await bizRow(bizA);
    assert(r.status === 400 && r.body?.code === "INVALID_DEPOSIT" && r.body?.field === "defaultDepositCents" && row.default_deposit_cents === null, "under $7 → 400, nothing saved", r.body);
    r = await call("PATCH", "/api/vendor/my-business", { token: tA, body: { defaultDepositCents: "2500" } });
    assert(r.status === 400, "text value → 400");
    r = await call("PATCH", "/api/vendor/my-business", { token: tA, body: { defaultDepositCents: 2500 } });
    row = await bizRow(bizA);
    assert(r.status === 200 && row.default_deposit_cents === 2500 && r.body?.business?.defaultDepositCents === 2500, "$25 default saved and returned", r.body?.business?.defaultDepositCents);
    const deposits = await q(`SELECT id, deposit_amount_cents FROM vendor_services WHERE business_id = $1 ORDER BY id`, [bizA]);
    assert(deposits.find((d) => d.id === svc1)?.deposit_amount_cents === 2000 && deposits.find((d) => d.id === svc2)?.deposit_amount_cents === null, "existing services keep their deposits", deposits);
    r = await call("POST", "/api/vendor/services", { token: tA, body: { name: "New one", price: 9000, durationMinutes: 30 } });
    assert(r.status === 200 && r.body?.service?.depositAmountCents === null, "new service without a deposit gets none (default is only a pre-fill)", r.body?.service?.depositAmountCents);
    if (r.body?.service?.id) await q(`DELETE FROM vendor_services WHERE id = $1`, [r.body.service.id]);
    r = await call("GET", "/api/vendor/my-business", { token: tA });
    assert(r.status === 200 && r.body?.business?.defaultDepositCents === 2500 && r.body?.business?.cancellationPolicySetAt != null, "GET my-business returns both new fields");
    r = await call("PATCH", "/api/vendor/my-business", { token: tA, body: { defaultDepositCents: null } });
    row = await bizRow(bizA);
    assert(r.status === 200 && row.default_deposit_cents === null, "null clears the default");
    const before = await bizRow(bizA);
    r = await call("PATCH", "/api/vendor/my-business", { token: tA, body: { fullRefundWindow: "never", cancellationFeeAmount: 1, cancellationPolicySetAt: null } });
    row = await bizRow(bizA);
    assert(r.status === 200 && row.full_refund_window === before.full_refund_window && row.cancellation_fee_amount === before.cancellation_fee_amount && row.cancellation_policy_set_at !== null,
      "policy fields and the stamp sent to my-business are still dropped", row);

    console.log("setup status");
    accountCalls.length = 0;
    r = await call("GET", "/api/vendor/setup-status", { token: tA });
    const steps = (b: any) => Object.fromEntries((b?.steps ?? []).map((s: any) => [s.key, s.state]));
    let st = steps(r.body);
    assert(r.status === 200 && r.body?.businessId === bizA, "owner gets their business", r.body);
    assert(JSON.stringify(Object.keys(st)) === JSON.stringify(["first_item", "service_photos", "hours", "cancellation_policy", "terms", "payouts", "plan"]), "steps in order", Object.keys(st));
    assert(st.first_item === "done" && st.service_photos === "todo" && st.hours === "todo" && st.cancellation_policy === "done" && st.terms === "todo", "service business states", st);
    const photoStep = r.body.steps.find((s: any) => s.key === "service_photos");
    assert(photoStep.missingCount === 1 && photoStep.label === `Add a photo to Svc s1` && photoStep.target === "services", "missing photo named", photoStep);
    assert(st.payouts === "todo" && accountCalls.includes(`acct_${P}A`), "payouts todo after asking Stripe", accountCalls);
    assert(st.plan === "todo" && r.body.next === "service_photos" && r.body.complete === false, "plan todo; next = first todo");

    completeAccounts.add(`acct_${P}A`);
    await q(`UPDATE vendor_services SET image_url = 'https://cdn.example/s1.jpg' WHERE id = $1`, [svc1]);
    await q(`UPDATE businesses SET hours_of_operation = $2, vendor_terms_and_conditions = 'Be on time' WHERE id = $1`, [bizA, JSON.stringify({ monday: { open: true, start: "09:00", end: "17:00" } })]);
    const tierId = id("tier");
    await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps) VALUES ($1, $2, 'Test', 2900, 800)`, [tierId, tierId]);
    tiers.push(tierId);
    await q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, stripe_subscription_id, status) VALUES ($1, $2, $3, 'sub_test', 'active')`, [ownerA, bizA, tierId]);
    r = await call("GET", "/api/vendor/setup-status", { token: tA });
    st = steps(r.body);
    row = await bizRow(bizA);
    assert(st.payouts === "done" && row.stripe_onboarding_complete === true, "Stripe self-heal: payouts done and flag saved", { st, flag: row.stripe_onboarding_complete });
    assert(r.body.complete === true && r.body.next === null && r.body.doneCount === r.body.totalCount, "everything set → complete", r.body);
    accountCalls.length = 0;
    await call("GET", "/api/vendor/setup-status", { token: tA });
    assert(accountCalls.length === 0, "no Stripe call once payouts are done");

    console.log("public DTO");
    await q(`UPDATE businesses SET default_deposit_cents = 2500 WHERE id = $1`, [bizA]);
    r = await call("GET", `/api/businesses/${bizA}`);
    const pub = r.body?.business ?? {};
    assert(r.status === 200 && pub.id === bizA && !("defaultDepositCents" in pub) && !("cancellationPolicySetAt" in pub), "public business DTO (visible business) has neither field", { s: r.status, keys: Object.keys(pub).length });

    r = await call("GET", "/api/vendor/setup-status", { token: tAdmin, headers: { "x-business-id": bizB } });
    st = steps(r.body);
    assert(r.status === 200 && r.body?.businessId === bizB && st.approval === "waiting" && !("payouts" in st) && !("plan" in st), "admin + x-business-id: pending business, approval waiting", r.body);
    assert(st.service_photos === "todo" && st.cancellation_policy === "done", "admin sees business B's own facts", st);
    const ownerC = await mkUser("ownerC");
    const bizC = await mkBiz("C", ownerC);
    r = await call("GET", "/api/vendor/setup-status", { token: tok(ownerC, bizC) });
    st = steps(r.body);
    assert(r.status === 200 && st.first_item === "todo" && st.cancellation_policy === "todo" && st.payouts === "todo" && r.body.steps[0].target === "services",
      "new business with no policy chosen → policy todo", st);
    await q(`UPDATE businesses SET full_refund_window = 'never' WHERE id = $1`, [bizC]);
    r = await call("GET", "/api/vendor/setup-status", { token: tok(ownerC, bizC) });
    assert(steps(r.body).cancellation_policy === "todo", "column default 'never' alone is not a choice");

    r = await call("GET", "/api/vendor/setup-status", { token: tB, headers: { "x-business-id": bizA } });
    assert(r.status === 200 && r.body?.businessId === bizB, "vendor's x-business-id is ignored");
  } finally {
    await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [biz]);
    await q(`DELETE FROM subscription_tiers WHERE id = ANY($1)`, [tiers]);
    await q(`DELETE FROM vendor_services WHERE business_id = ANY($1)`, [biz]);
    await q(`DELETE FROM weekly_availability WHERE entity_id = ANY($1)`, [biz]).catch(() => {});
    await q(`DELETE FROM businesses WHERE id = ANY($1)`, [biz]);
    await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await db.end();
    stub.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
