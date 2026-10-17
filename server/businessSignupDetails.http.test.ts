/**
 * Business signup details (migration 047): HTTP integration tests.
 *
 * Run with: npx tsx server/businessSignupDetails.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres
 * (full schema + migration 047). Environment variables:
 *   BS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   BS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when BS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation check: remove the `data.deferAdminNotification !== true` guard in the vendor signup
 * route → "deferred signup creates no admin notification" fails.
 */
import http from "http";

const BASE = process.env.BS_TEST_BASE_URL;
const PG_URL = process.env.BS_TEST_PG_URL;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); }
}
const isLocal = (u: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(u).hostname);

let ipCounter = 1;
async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    // A fresh address per call keeps the signup rate limiter out of the way.
    const headers: Record<string, string> = { "X-Forwarded-For": `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` };
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
  if (!BASE) { console.log("⏭  skipped: set BS_TEST_BASE_URL + BS_TEST_PG_URL to run"); process.exit(0); }
  if (!PG_URL || !isLocal(BASE) || !isLocal(PG_URL)) throw new Error("refusing to run: BASE and PG_URL must both be localhost");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "bs-test-jwt";
  const { generateAccessToken } = await import("./auth");
  const pgMod: any = await import("pg");
  const pg = pgMod.default ?? pgMod;
  pg.types.setTypeParser(1114, (v: string) => v);
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  const q = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];

  const P = `bs${Date.now().toString(36)}`;
  const email = (s: string) => `${P}-${s}@test.local`;
  const uname = (s: string) => `${P}${s}`.slice(0, 20);

  // Admin (must be an allowed admin email; scratch DB only). Reuse if a previous run left one.
  let [admin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
  if (!admin) {
    [admin] = await q(`INSERT INTO users (id, email, name, username, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', $1, true) RETURNING id`, [uname("adm")]);
  } else {
    await q(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id]);
  }
  const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });

  const baseBody = (s: string, over: Record<string, unknown> = {}) => ({
    email: email(s), password: "secret123", name: `Owner ${s}`, phone: "5165550101",
    businessName: `${P} ${s}`, businessCategory: "Beauty & Hair", businessDescription: "We braid",
    offerType: "both", isStartup: true, isMultiStaff: false, yearsInBusiness: "1-2 years", employeeCount: "Just me",
    businessType: "LLC", hasPhysicalLocation: true, address: "1 Main St", city: "Freeport", state: "NY", zipCode: "11520",
    billingAddress: "2 Bill Rd", billingCity: "Hempstead", billingState: "NY", billingZipCode: "11550",
    websiteUrl: "https://braids.test", socialMedia: "@braidstest", username: uname(s),
    acceptedSubscription: true, vendorAgreementAccepted: true,
    ...over,
  });
  const bizRow = async (s: string) => (await q(`SELECT * FROM businesses WHERE name = $1`, [`${P} ${s}`]))[0];
  const userCount = async (s: string) => (await q(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [email(s)]))[0].n;
  const adminNotes = async (bizId: string) =>
    (await q(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'new_vendor_application' AND reference_id = $2`, [admin.id, bizId]))[0].n;

  try {
    console.log("GET /api/taxonomy/business-categories");
    const tx = await call("GET", "/api/taxonomy/business-categories");
    assert(tx.status === 200 && tx.body?.categories?.length === 11, "200 with 11 categories", tx.body?.categories?.length);
    assert(tx.body?.maxSpecialties === 3 && tx.body?.version === 1, "version + max");
    const beauty = tx.body?.categories?.find((c: any) => c.code === "beauty");
    assert(beauty?.label === "Beauty & Personal Care" && beauty.specialties.some((s: any) => s.code === "beauty.product.hair_wigs_extensions" && s.kind === "product"), "beauty has product + service specialties");
    assert(tx.body?.categories?.every((c: any) => c.specialties.some((s: any) => s.code.endsWith(".service.other")) && c.specialties.some((s: any) => s.code.endsWith(".product.other"))), "every category offers Other");

    console.log("Signup: older clients without industry");
    const legacy = await call("POST", "/api/auth/vendor/signup", { body: baseBody("legacy") });
    assert(legacy.status === 200, "legacy signup 200", legacy.body);
    const lb = await bizRow("legacy");
    assert(lb?.category === "Beauty & Hair" && lb?.category_code === null && Array.isArray(lb?.specialties) && lb.specialties.length === 0, "legacy: category as sent, no codes", lb && { c: lb.category, cc: lb.category_code, s: lb.specialties });
    assert(lb && (await adminNotes(lb.id)) === 1, "legacy: admin notified once (unchanged behavior)");

    console.log("Signup: with industry");
    const good = await call("POST", "/api/auth/vendor/signup", {
      body: baseBody("good", { categoryCode: "beauty", specialties: ["beauty.service.braids_locs", "beauty.product.hair_wigs_extensions"] }),
    });
    assert(good.status === 200, "valid industry 200", good.body);
    const gb = await bizRow("good");
    assert(gb?.category === "Beauty & Personal Care", "readable label stored in category", gb?.category);
    assert(gb?.category_code === "beauty" && JSON.stringify(gb?.specialties) === JSON.stringify(["beauty.service.braids_locs", "beauty.product.hair_wigs_extensions"]), "codes stored", gb && { cc: gb.category_code, s: gb.specialties });
    assert(gb?.is_startup === true && gb?.years_in_business === "1-2 years" && gb?.social_media === "@braidstest" && gb?.billing_address?.line1 === "2 Bill Rd", "other answers still saved");

    const rejects: Array<[string, Record<string, unknown>]> = [
      ["wrongcat", { categoryCode: "beauty", specialties: ["food.service.catering"] }],
      ["kind", { offerType: "services", categoryCode: "beauty", specialties: ["beauty.product.hair_care"] }],
      ["toomany", { categoryCode: "beauty", specialties: ["beauty.service.nails", "beauty.service.makeup", "beauty.service.barber", "beauty.service.waxing"] }],
      ["unknown", { categoryCode: "spaceships", specialties: [] }],
      ["none", { categoryCode: "beauty", specialties: [] }],
      ["otherdesc", { categoryCode: "beauty", specialties: ["beauty.service.other"] }],
    ];
    for (const [s, over] of rejects) {
      const r = await call("POST", "/api/auth/vendor/signup", { body: baseBody(s, over) });
      assert(r.status === 400 && r.body?.field === "industry" && typeof r.body?.error === "string", `rejects ${s} with 400 field=industry`, r);
      assert((await userCount(s)) === 0, `rejects ${s}: no user created`);
    }
    const long = await call("POST", "/api/auth/vendor/signup", { body: baseBody("long", { categoryCode: "beauty", specialties: ["beauty.service.other"], otherDescription: "x".repeat(501) }) });
    assert(long.status === 400 && (await userCount("long")) === 0, "description over 500 rejected, no user", long.status);

    const other = await call("POST", "/api/auth/vendor/signup", { body: baseBody("other", { categoryCode: "other", specialties: [], otherDescription: "  Boat detailing on the water  " }) });
    const ob = await bizRow("other");
    assert(other.status === 200 && ob?.category === "Other" && ob?.other_description === "Boat detailing on the water", "Other category saves trimmed description", ob && { c: ob.category, d: ob.other_description });

    console.log("Deferred admin alert (app uploads the logo first)");
    const def = await call("POST", "/api/auth/vendor/signup", {
      body: baseBody("deferred", { categoryCode: "beauty", specialties: ["beauty.service.nails"], deferAdminNotification: true }),
    });
    const db2 = await bizRow("deferred");
    assert(def.status === 200 && db2 && (await adminNotes(db2.id)) === 0, "deferred signup creates no admin notification");
    const ownerToken = generateAccessToken({ userId: db2.owner_id, isVendor: true, businessId: db2.id });
    await q(`UPDATE businesses SET logo_image = 'https://cdn.test/logo.png' WHERE id = $1`, [db2.id]);
    const n1 = await call("POST", "/api/admin/notifications/business-application", { token: ownerToken, body: { businessId: db2.id } });
    assert(n1.status === 200 && (await adminNotes(db2.id)) === 1, "owner trigger sends it once", n1);
    const n2 = await call("POST", "/api/admin/notifications/business-application", { token: ownerToken, body: { businessId: db2.id } });
    assert(n2.status === 200 && (await adminNotes(db2.id)) === 1, "retry does not send twice", { n2, n: await adminNotes(db2.id) });
    const strangerToken = generateAccessToken({ userId: gb.owner_id, isVendor: true });
    const n3 = await call("POST", "/api/admin/notifications/business-application", { token: strangerToken, body: { businessId: db2.id } });
    assert(n3.status === 403, "another owner gets 403", n3.status);
    const gbToken = generateAccessToken({ userId: gb.owner_id, isVendor: true, businessId: gb.id });
    await q(`UPDATE businesses SET approval_status = 'approved' WHERE id = $1`, [gb.id]);
    const n4 = await call("POST", "/api/admin/notifications/business-application", { token: gbToken, body: { businessId: gb.id } });
    assert(n4.status === 409, "approved business cannot re-send (409)", n4);
    await q(`UPDATE businesses SET approval_status = 'pending' WHERE id = $1`, [gb.id]);
    await q(`UPDATE businesses SET created_at = now() - interval '2 days' WHERE id = $1`, [lb.id]);
    const lbToken = generateAccessToken({ userId: lb.owner_id, isVendor: true, businessId: lb.id });
    const n5 = await call("POST", "/api/admin/notifications/business-application", { token: lbToken, body: { businessId: lb.id } });
    assert(n5.status === 409, "older than 24 hours cannot re-send (409)", n5);
    const n6 = await call("POST", "/api/admin/notifications/business-application", { body: { businessId: lb.id } });
    assert(n6.status === 401, "no login → 401", n6.status);

    console.log("Admin APIs");
    await q(`UPDATE businesses SET stripe_account_id = 'acct_SECRET', stripe_onboarding_url = 'https://connect.stripe.com/SECRET' WHERE id = $1`, [gb.id]);
    const list = await call("GET", "/api/admin/applications?status=pending", { token: adminToken });
    const item = list.body?.applications?.find((a: any) => a.id === gb.id);
    assert(list.status === 200 && !!item, "pending list contains the business", list.status);
    assert(item && !("stripeAccountId" in item) && !("stripeOnboardingUrl" in item) && !JSON.stringify(list.body).includes("SECRET"), "list has no Stripe ids");
    assert(item && !("owner" in item) && !JSON.stringify(list.body).includes("$2b$"), "list has no raw owner row or password hash");
    assert(item?.ownerUsername === uname("good") && item?.ownerPhone === "5165550101", "owner username + phone");
    const titles = item?.signupDetails?.sections?.map((s: any) => s.title);
    assert(JSON.stringify(titles) === JSON.stringify(["Business", "Location", "Owner", "Status"]), "signupDetails sections", titles);
    assert(item?.signupDetails?.industry?.categoryLabel === "Beauty & Personal Care" && item?.signupDetails?.industry?.specialties?.[0]?.label === "Braids & locs", "signupDetails industry labels");
    const legacyItem = list.body?.applications?.find((a: any) => a.id === lb.id);
    assert(legacyItem?.signupDetails?.industry?.categoryLabel === "Beauty & Hair", "legacy business shows its old category");

    const detail = await call("GET", `/api/admin/applications/${gb.id}`, { token: adminToken });
    assert(detail.status === 200 && !("stripeAccountId" in (detail.body?.application ?? {})) && !JSON.stringify(detail.body).includes("SECRET"), "detail has no Stripe ids");
    assert(detail.body?.application?.signupDetails?.sections?.length === 4 && detail.body?.application?.ownerUsername === uname("good"), "detail has signupDetails + username");
    assert(detail.body?.application?.ownerCreatedAt && detail.body?.application?.ownerName === "Owner good", "detail keeps existing owner fields");

    const biz = await call("GET", `/api/admin/businesses/${gb.id}`, { token: adminToken });
    assert(biz.status === 200 && biz.body?.signupDetails?.sections?.length === 4, "app admin business detail has signupDetails");
    assert(biz.body?.owner?.username === uname("good") && biz.body?.owner?.zipCode === "11520" && biz.body?.owner?.phone === "5165550101", "app admin owner block extended");
    assert(biz.body?.websiteUrl === "https://braids.test" && biz.body?.stripeOnboardingComplete === false, "existing fields unchanged");

    const nonAdmin = await call("GET", "/api/admin/applications?status=pending", { token: ownerToken });
    assert(nonAdmin.status === 403, "non-admin blocked", nonAdmin.status);
  } finally {
    await q(`DELETE FROM notifications WHERE reference_id IN (SELECT id FROM businesses WHERE name LIKE $1)`, [`${P} %`]);
    await q(`DELETE FROM businesses WHERE name LIKE $1`, [`${P} %`]);
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]);
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
