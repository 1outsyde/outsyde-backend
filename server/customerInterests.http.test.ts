/**
 * Customer interests on the shared business list (2026-10-18): HTTP integration tests.
 *
 * Run with: npx tsx server/customerInterests.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres that has
 * migration 058 (customer interests) applied.
 *   PS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when PS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - signup saving data.selectedIndustries (raw) instead of interests.* → "app answers saved as codes" fails.
 *  - in unifiedSearchWithScope use viewer.selectedIndustries raw again (old code) and drop the code
 *    match → "Health & Fitness customer gets the gym first" fails.
 * Note: interests change the order only in scope=all (scoped searches sort by text match, unchanged).
 */
import http from "http";

const BASE = process.env.PS_TEST_BASE_URL;
const PG_URL = process.env.PS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);
// Postgres jsonb reorders object keys, so compare objects with sorted keys.
const norm = (v: any): any => Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
const eq = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

let ipCounter = 1;
async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": `10.96.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json, raw: b }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set PS_TEST_BASE_URL + PS_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ps-test-jwt";
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `ci${Date.now().toString(36)}`;
  const email = (s: string) => `${P}-${s}@test.local`;
  const uname = (s: string) => `${P}${s}`.slice(0, 20);
  const row = async (s: string) => (await q(`SELECT * FROM users WHERE email=$1`, [email(s)]))[0];
  const signup = (s: string, extra: Record<string, unknown>) => call("POST", "/api/auth/customer/signup", { body: {
    email: email(s), password: "secret123", name: `Person ${s}`, username: uname(s), ...extra,
  } });
  const bizIds: string[] = [];
  let tierId: string | null = null;

  try {
    console.log("\n=== Public list ===");
    let r = await call("GET", "/api/taxonomy/customer-interests");
    const beauty = r.body?.categories?.find((c: any) => c.code === "beauty");
    assert(r.status === 200 && r.body?.categories?.length === 11 && r.body?.otherMax === 500, "11 industries, Other max 500", r.body && { n: r.body.categories?.length });
    assert(beauty?.specialties?.some((s: any) => s.code === "beauty.service.braids_locs" && s.kind === "service") && beauty?.values?.some((v: any) => v.id === "skill" && v.label === "Skill"), "specialties + what matters per industry");
    assert(!r.raw.includes(".other\""), "no Other specialties in the public list");

    console.log("\n=== Older app answers saved as codes ===");
    r = await signup("app", {
      selectedIndustries: ["clothing", "beauty-services"],
      industryNiches: { clothing: ["Streetwear"], "beauty-services": ["Braiding & Locs"] },
      industryValues: { clothing: ["quality"], "beauty-services": ["skill"] },
    });
    let u = await row("app");
    assert(r.status === 200, "signup works", r.status);
    assert(eq(u?.selected_industries, ["fashion", "beauty"]), "app answers saved as codes", u?.selected_industries);
    assert(eq(u?.industry_niches, { fashion: ["fashion.product.streetwear"], beauty: ["beauty.service.braids_locs"] }), "niches saved as specialty codes", u?.industry_niches);
    assert(eq(u?.industry_values, { fashion: ["quality"], beauty: ["skill"] }), "what matters follows the mapped industry", u?.industry_values);
    assert(eq(u?.interests_original?.selectedIndustries, ["clothing", "beauty-services"]), "original answers kept", u?.interests_original);

    console.log("\n=== goutsyde.com names saved as codes ===");
    r = await signup("web", { selectedIndustries: ["Fashion & Apparel", "Travel & Adventure", "Finance"], industryNiches: {}, industryValues: {}, source: "outsyde-web" });
    u = await row("web");
    assert(r.status === 200 && eq(u?.selected_industries, ["fashion", "other", "professional"]), "web names mapped, web only to nearest", u?.selected_industries);
    assert(eq(u?.interests_original?.selectedIndustries, ["Fashion & Apparel", "Travel & Adventure", "Finance"]), "original words kept");

    console.log("\n=== New picker answers ===");
    r = await signup("new", {
      firstName: "New", lastName: "Picker", aptUnit: "2B", country: "United States",
      billingSameAsHome: false, billingStreet: "9 Pine", billingCity: "Hempstead", billingState: "NY", billingZip: "11550",
      selectedIndustries: ["beauty", "other"], industryNiches: { beauty: ["beauty.service.braids_locs"] }, industryValues: { beauty: ["skill"] },
      interestOther: "Vintage cars",
    });
    u = await row("new");
    assert(r.status === 200 && eq(u?.selected_industries, ["beauty", "other"]) && u?.interest_other === "Vintage cars" && u?.interests_original === null, "codes + Other text, no original", u && { s: u.selected_industries, o: u.interest_other, g: u.interests_original });
    assert(u?.first_name === "New" && u?.last_name === "Picker" && u?.apt_unit === "2B", "first name, last name, apt now saved (were dropped)", u && { f: u.first_name, l: u.last_name, a: u.apt_unit });
    assert(u?.billing_same_as_home === false && u?.billing_street === "9 Pine" && u?.billing_city === "Hempstead" && u?.billing_zip === "11550", "separate billing address now saved (was dropped)", u && { b: u.billing_same_as_home, s: u.billing_street });
    assert(r.body?.user?.interestOther === "Vintage cars", "the person sees their own Other text in the signup response");

    console.log("\n=== Junk never blocks a signup ===");
    r = await signup("junk", { selectedIndustries: ["nope", "beauty"], industryNiches: { beauty: ["fashion.product.shoes"] }, industryValues: { nope: ["quality"] } });
    u = await row("junk");
    assert(r.status === 200 && eq(u?.selected_industries, ["beauty"]) && eq(u?.industry_niches, {}) && eq(u?.industry_values, {}), "unknown dropped, kept in original", u && { s: u.selected_industries });
    r = await signup("none", {});
    u = await row("none");
    assert(r.status === 200 && eq(u?.selected_industries, []) && u?.interests_original === null && u?.billing_same_as_home === true && u?.country === "United States", "nothing sent → empty, defaults kept");

    console.log("\n=== Admin detail shows the mapped answers ===");
    let [admin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
    if (!admin) [admin] = await q(`INSERT INTO users (id, email, name, username, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', $1, true) RETURNING id`, [uname("adm")]);
    const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });
    r = await call("GET", `/api/admin/users/${(await row("web")).id}`, { token: adminToken });
    const ir = r.body?.signupDetails?.sections?.[0]?.rows ?? [];
    const v = (l: string) => ir.find((x: any) => x.label === l)?.value;
    assert(v("Industries") === "Fashion & Accessories, Other, Professional Services" && v("Originally picked") === "Fashion & Apparel, Travel & Adventure, Finance", "admin: codes readable + original words", ir);

    console.log("\n=== Matching businesses ranked first ===");
    [{ id: tierId }] = await q(`INSERT INTO subscription_tiers (id, name, display_name, price_in_cents, platform_fee_bps) VALUES (gen_random_uuid(), $1, 'Test', 0, 0) RETURNING id`, [`${P}tier`]);
    const owner = (await row("none")).id;
    for (const [name, cat, code, specs] of [
      [`${P} Food Spot`, "Food & Drink", "food", ["food.service.restaurant"]],
      [`${P} Braid Spot`, "Beauty & Personal Care", "beauty", ["beauty.service.braids_locs"]],
      [`${P} Gym Spot`, "Health & Fitness", "health_fitness", ["health_fitness.service.personal_training"]],
    ] as const) {
      // Search only shows complete businesses (approved + active plan + working payouts, 2026-10-21).
      const [b] = await q(`INSERT INTO businesses (id, owner_id, name, category, category_code, specialties, approval_status, stripe_onboarding_complete, stripe_account_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, 'approved', true, 'acct_test_ps') RETURNING id`, [owner, name, cat, code, JSON.stringify(specs)]);
      bizIds.push(b.id);
      await q(`INSERT INTO vendor_subscriptions (vendor_id, business_id, tier_id, status) VALUES ($1, $2, $3, 'active')`, [owner, b.id, tierId]);
    }
    const viewer = (await row("new")).id;
    const plain = await call("GET", `/api/search?q=${encodeURIComponent(P)}&scope=all`);
    const pers = await call("GET", `/api/search?q=${encodeURIComponent(P)}&scope=all&personalized=true&viewerUserId=${viewer}`);
    const names = (x: any) => (x.body?.results ?? x.body?.data?.results ?? []).filter((y: any) => y.type === "business").map((y: any) => y.title);
    assert(names(plain)[0] === `${P} Food Spot`, "without interests the first match is first", names(plain));
    assert(names(pers)[0] === `${P} Braid Spot`, "matching business ranked first for a beauty customer", names(pers));
    const legacyViewer = (await row("app")).id; // saved as codes from older app words
    const pers2 = await call("GET", `/api/search?q=${encodeURIComponent(P)}&scope=all&personalized=true&viewerUserId=${legacyViewer}`);
    assert(names(pers2)[0] === `${P} Braid Spot`, "same for a customer who signed up on the old app", names(pers2));
    await signup("fit", { selectedIndustries: ["fitness"], industryNiches: {}, industryValues: {} });
    const pers3 = await call("GET", `/api/search?q=${encodeURIComponent(P)}&scope=all&personalized=true&viewerUserId=${(await row("fit")).id}`);
    assert(names(pers3)[0] === `${P} Gym Spot`, "Health & Fitness customer gets the gym first (code has no text overlap)", names(pers3));
  } finally {
    if (bizIds.length) {
      await q(`DELETE FROM vendor_subscriptions WHERE business_id = ANY($1)`, [bizIds]).catch(() => {});
      await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizIds]).catch((e) => console.error("cleanup biz", e.message));
    }
    if (tierId) await q(`DELETE FROM subscription_tiers WHERE id=$1`, [tierId]).catch(() => {});
    await q(`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM notifications WHERE reference_id IN (SELECT id::text FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]).catch((e) => console.error("cleanup", e.message));
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
