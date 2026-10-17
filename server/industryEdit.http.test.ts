/**
 * Changing a business's industry after signup: PATCH /api/vendor/my-business (2026-10-17).
 *
 * Run with: npx tsx server/industryEdit.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres
 * (full schema incl. migration 047). Environment variables:
 *   IE_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   IE_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when IE_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - remove "categoryCode" from VENDOR_MY_BUSINESS_ALLOWED_FIELDS → "change industry saves" fails.
 *  - remove the `updates.category = getCategory(...)` line → "label follows code" fails.
 *  - drop "hasProducts"/"hasServices" from touchesIndustry → "offer switch that breaks picks → 400" fails.
 */
import http from "http";

const BASE = process.env.IE_TEST_BASE_URL;
const PG_URL = process.env.IE_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
    if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json: any = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, body: json }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!BASE) { console.log("⏭  skipped: set IE_TEST_BASE_URL + IE_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "ie-test-jwt";
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `ie${Date.now().toString(36)}`;
  const userIds: string[] = [];
  const bizIds: string[] = [];
  async function seed(s: string, biz: { category: string; code: string | null; specialties: string[]; hasProducts: boolean; hasServices: boolean; other?: string | null }) {
    const [u] = await q(`INSERT INTO users (id, email, name, username, is_vendor) VALUES (gen_random_uuid(), $1, $2, $3, true) RETURNING id`, [`${P}-${s}@test.local`, `Owner ${s}`, `${P}${s}`.slice(0, 20)]);
    const [b] = await q(
      `INSERT INTO businesses (id, owner_id, name, category, category_code, specialties, other_description, has_products, has_services, approval_status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'approved') RETURNING id`,
      [u.id, `${P} ${s}`, biz.category, biz.code, JSON.stringify(biz.specialties), biz.other ?? null, biz.hasProducts, biz.hasServices],
    );
    userIds.push(u.id); bizIds.push(b.id);
    return { userId: u.id, bizId: b.id, token: generateAccessToken({ userId: u.id, isVendor: true, isAdmin: false }) };
  }
  const row = async (id: string) => (await q(`SELECT category, category_code, specialties, other_description, has_products, has_services, tagline FROM businesses WHERE id = $1`, [id]))[0];
  const patch = (token: string, body: unknown, headers?: Record<string, string>) => call("PATCH", "/api/vendor/my-business", { token, body, headers });

  try {
    // A services-only braider, like beautifulbraidsbylana.
    const braids = await seed("br", { category: "Beauty & Personal Care", code: "beauty", specialties: ["beauty.service.braids_locs"], hasProducts: false, hasServices: true });
    // A both business, like Braids With Love.
    const both = await seed("bo", { category: "Beauty & Personal Care", code: "beauty", specialties: ["beauty.service.braids_locs"], hasProducts: true, hasServices: true });
    // A legacy business with no code (like the test accounts that were never mapped).
    const legacy = await seed("lg", { category: "beauty", code: null, specialties: [], hasProducts: false, hasServices: true });

    console.log("\n=== GET returns the stored industry ===");
    let r = await call("GET", "/api/vendor/my-business", { token: braids.token });
    assert(r.status === 200 && r.body?.business?.categoryCode === "beauty" && JSON.stringify(r.body.business.specialties) === '["beauty.service.braids_locs"]', "GET my-business has categoryCode + specialties", r.body?.business && { c: r.body.business.categoryCode, s: r.body.business.specialties });

    console.log("\n=== Changing industry ===");
    r = await patch(braids.token, { categoryCode: "auto", specialties: ["auto.service.detailing"] });
    let b = await row(braids.bizId);
    assert(r.status === 200, "change industry saves → 200", r);
    assert(b.category_code === "auto" && JSON.stringify(b.specialties) === '["auto.service.detailing"]', "change industry saves codes", b);
    assert(b.category === "Auto", "label follows code (category = Auto)", b.category);
    assert(r.body?.business?.categoryCode === "auto" && r.body?.business?.category === "Auto", "response returns the new industry", r.body?.business && { c: r.body.business.categoryCode, l: r.body.business.category });

    const tx = await call("GET", "/api/taxonomy/business-categories");
    const autoSvc = tx.body.categories.find((c: any) => c.code === "auto").specialties.filter((s: any) => s.kind === "service").map((s: any) => s.code);
    const two = autoSvc.slice(0, 2);
    r = await patch(braids.token, { specialties: two });
    b = await row(braids.bizId);
    assert(r.status === 200 && JSON.stringify(b.specialties) === JSON.stringify(two), "specialties alone check against the stored industry → 200", { r: r.status, s: b.specialties, two });

    console.log("\n=== Rejected selections leave the row untouched ===");
    const before = JSON.stringify(await row(braids.bizId));
    const bad: [string, unknown][] = [
      ["specialty from another industry", { specialties: ["beauty.service.nails"] }],
      ["new industry with old picks", { categoryCode: "food" }],
      ["product pick on a services only business", { categoryCode: "beauty", specialties: ["beauty.product.hair_care"] }],
      ["more than 3", { categoryCode: "beauty", specialties: ["beauty.service.nails", "beauty.service.makeup", "beauty.service.barber", "beauty.service.braids_locs"] }],
      ["none picked", { categoryCode: "beauty", specialties: [] }],
      ["unknown industry", { categoryCode: "spaceships", specialties: [] }],
      ["Other without description", { categoryCode: "beauty", specialties: ["beauty.service.other"] }],
      ["empty code", { categoryCode: "  " }],
      ["code not text", { categoryCode: 5 }],
      ["specialties not a list", { specialties: "beauty.service.nails" }],
      ["description too long", { categoryCode: "beauty", specialties: ["beauty.service.other"], otherDescription: "x".repeat(501) }],
      ["bad picks with an unrelated field", { tagline: "should not save", specialties: ["food.product.cakes_sweets"] }],
    ];
    for (const [name, body] of bad) {
      r = await patch(braids.token, body);
      assert(r.status === 400 && r.body?.field === "industry", `${name} → 400 industry`, { status: r.status, body: r.body });
    }
    assert(JSON.stringify(await row(braids.bizId)) === before, "row unchanged after every rejected save (tagline included)");

    console.log("\n=== Other with a description ===");
    r = await patch(braids.token, { categoryCode: "beauty", specialties: ["beauty.service.other"], otherDescription: "  Scalp treatments  " });
    b = await row(braids.bizId);
    assert(r.status === 200 && b.other_description === "Scalp treatments" && b.category === "Beauty & Personal Care", "Other + description saves (trimmed), label Beauty", b);
    r = await patch(braids.token, { categoryCode: "other", specialties: [], otherDescription: "Something new" });
    b = await row(braids.bizId);
    assert(r.status === 200 && b.category_code === "other" && b.other_description === "Something new", "Other industry with no picks + description saves", b);

    console.log("\n=== Offer type switch (decided: reject if the picks no longer fit) ===");
    r = await patch(both.token, { hasServices: false });
    b = await row(both.bizId);
    assert(r.status === 400 && r.body?.field === "industry" && b.has_services === true, "offer switch that breaks picks → 400, row unchanged", { r, b });
    r = await patch(both.token, { hasProducts: false });
    b = await row(both.bizId);
    assert(r.status === 200 && b.has_products === false && b.has_services === true, "offer switch that still fits → 200", { r: r.status, b });
    r = await patch(both.token, { hasProducts: true, hasServices: false, specialties: ["beauty.product.hair_wigs_extensions"] });
    b = await row(both.bizId);
    assert(r.status === 200 && b.has_services === false && JSON.stringify(b.specialties) === '["beauty.product.hair_wigs_extensions"]', "switch offer + new picks together → 200", b);
    r = await patch(both.token, { hasProducts: false, hasServices: false });
    assert(r.status === 400 && r.body?.field === "industry", "neither products nor services → 400", r);
    r = await patch(both.token, { hasProducts: "yes" });
    assert(r.status === 400, "offer flag not true/false → 400", r);

    console.log("\n=== Name always follows the code (decided) ===");
    r = await patch(both.token, { category: "Car Repair" });
    b = await row(both.bizId);
    assert(r.status === 200 && b.category === "Beauty & Personal Care", "category sent alone is replaced by the code's label", b.category);

    console.log("\n=== Saves that don't touch industry are unchanged ===");
    r = await patch(both.token, { tagline: "Fresh look" });
    b = await row(both.bizId);
    assert(r.status === 200 && b.tagline === "Fresh look" && b.category_code === "beauty", "unrelated save → 200, industry untouched", b);

    console.log("\n=== Legacy business with no code ===");
    r = await patch(legacy.token, { category: "Hair", hasProducts: true });
    b = await row(legacy.bizId);
    assert(r.status === 200 && b.category === "Hair" && b.has_products === true && b.category_code === null, "no code: category + offer flags save as before", b);
    r = await patch(legacy.token, { specialties: ["beauty.service.nails"] });
    assert(r.status === 400 && r.body?.field === "industry", "no code: specialties without an industry → 400", r);
    r = await patch(legacy.token, { categoryCode: "beauty", specialties: ["beauty.service.nails"] });
    b = await row(legacy.bizId);
    assert(r.status === 200 && b.category_code === "beauty" && b.category === "Beauty & Personal Care", "no code: choosing an industry saves + sets label", b);

    console.log("\n=== Admin acting for a business (x-business-id) ===");
    let [admin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
    if (!admin) [admin] = await q(`INSERT INTO users (id, email, name, username, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', $1, true) RETURNING id`, [`${P}adm`.slice(0, 20)]);
    const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });
    r = await patch(adminToken, { categoryCode: "home", specialties: ["home.service.moving"] }, { "x-business-id": legacy.bizId });
    b = await row(legacy.bizId);
    assert(r.status === 200 && b.category_code === "home" && b.category === "Home & Living", "admin can change a business's industry", b);
    r = await patch(both.token, { categoryCode: "food", specialties: ["food.product.cakes_sweets"] }, { "x-business-id": legacy.bizId });
    b = await row(legacy.bizId);
    const own = await row(both.bizId);
    assert(r.status === 200 && b.category_code === "home" && own.category_code === "food", "non admin x-business-id only edits their own business", { other: b.category_code, own: own.category_code });
  } finally {
    if (bizIds.length) await q(`DELETE FROM businesses WHERE id = ANY($1)`, [bizIds]);
    if (userIds.length) await q(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
