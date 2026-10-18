/**
 * Customer signup details on GET /api/admin/users/:id (2026-10-18): HTTP integration tests.
 *
 * Run with: npx tsx server/customerSignupDetails.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres.
 *   PS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when PS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation check: remove `signupDetails: buildCustomerSignupDetailsPayload(user)` from the
 * route → every "signupDetails" check fails.
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

let ipCounter = 1;
async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const headers: Record<string, string> = { "X-Forwarded-For": `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` };
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

  const P = `cs${Date.now().toString(36)}`;
  const email = (s: string) => `${P}-${s}@test.local`;
  const uname = (s: string) => `${P}${s}`.slice(0, 20);

  let [admin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
  if (!admin) {
    [admin] = await q(`INSERT INTO users (id, email, name, username, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', $1, true) RETURNING id`, [uname("adm")]);
  } else {
    await q(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id]);
  }
  const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });

  try {
    console.log("\n=== Signup as the app does (codes + niches + what matters) ===");
    let r = await call("POST", "/api/auth/customer/signup", { body: {
      email: email("app"), password: "secret123", name: "App Person", firstName: "App", lastName: "Person", username: uname("app"),
      phone: "5165550100", city: "Freeport", state: "NY", gender: "Female", dateOfBirth: "1999-03-04", shoppingFrequency: "Weekly",
      ethnicity: "SECRET_ETHNICITY",
      selectedIndustries: ["clothing", "beauty-services"],
      industryNiches: { clothing: ["Vintage", "Streetwear"] },
      industryValues: { clothing: ["quality", "price"] },
    } });
    assert(r.status === 200, "app style signup works", r.status);
    const appId = r.body?.user?.id;

    console.log("\n=== Signup as goutsyde.com does (names, address) ===");
    r = await call("POST", "/api/auth/customer/signup", { body: {
      email: email("web"), password: "secret123", name: "Web Person", firstName: "Web", lastName: "Person", username: uname("web"),
      phone: "5165550101", address: "1 Main St", city: "Freeport", state: "NY", zipCode: "11520", country: "United States",
      billingSameAsHome: true, selectedIndustries: ["Fashion & Apparel", "Travel & Adventure"], industryNiches: {}, industryValues: {},
      source: "outsyde-web",
    } });
    assert(r.status === 200, "web style signup works", r.status);
    const webId = r.body?.user?.id;

    console.log("\n=== Only admins ===");
    const userToken = generateAccessToken({ userId: appId, isVendor: false, isAdmin: false });
    const a = await call("GET", `/api/admin/users/${appId}`);
    const b = await call("GET", `/api/admin/users/${appId}`, { token: userToken });
    assert([401, 403].includes(a.status) && [401, 403].includes(b.status), "refused without admin", { a: a.status, b: b.status });
    r = await call("GET", `/api/admin/users/00000000-0000-0000-0000-000000000000`, { token: adminToken });
    assert(r.status === 404, "unknown user is 404", r.status);

    console.log("\n=== App customer detail ===");
    r = await call("GET", `/api/admin/users/${appId}`, { token: adminToken });
    const rows = (t: string) => r.body?.signupDetails?.sections?.find((s: any) => s.title === t)?.rows ?? [];
    const val = (t: string, l: string) => rows(t).find((x: any) => x.label === l)?.value;
    assert(r.status === 200 && Array.isArray(r.body?.signupDetails?.sections), "signupDetails.sections present", r.status);
    assert(r.body?.signupDetails?.sections?.[0]?.title === "Interests", "Interests is the first section");
    assert(val("Interests", "Industries") === "Fashion & Accessories, Beauty & Personal Care", "app codes saved on the shared list, shown readable", val("Interests", "Industries"));
    assert(val("Interests", "Originally picked") === "Clothing & Fashion, Beauty Services", "original app answers shown");
    assert(val("Interests", "Matches business industries") === "Fashion & Accessories, Beauty & Personal Care", "matched to business industries");
    assert(val("Interests", "Into (Fashion & Accessories)") === "Clothing, Streetwear", "niches shown on the shared list", rows("Interests"));
    assert(val("Interests", "Originally into (Clothing & Fashion)") === "Vintage, Streetwear", "original niches shown");
    assert(val("Interests", "What matters (Fashion & Accessories)") === "Quality, Fair price", "what matters shown");
    assert(val("About them", "Gender") === "Female" && val("About them", "Birthday") === "Mar 4, 1999" && val("About them", "Shopping frequency") === "Weekly", "about them rows");
    assert(val("Contact", "Phone") === "5165550100" && val("Contact", "Username") === `@${uname("app")}`, "phone + username rows");
    assert(r.body?.user?.username === uname("app") && r.body?.user?.phone === "5165550100", "user.username (new) + user.phone sent");
    assert(Array.isArray(r.body?.signupDetails?.interests?.industries) && r.body.signupDetails.interests.industries[0]?.categoryCode === "fashion", "interests JSON with category codes");
    // Old keys kept (app reads these)
    for (const k of ["id", "email", "name", "firstName", "lastName", "phone", "city", "state", "isVendor", "isPhotographer", "isAdmin", "isActive", "createdAt", "loyaltyPoints"]) {
      assert(k in (r.body?.user ?? {}), `user.${k} still sent`);
    }
    assert("orders" in r.body && "bookings" in r.body && "business" in r.body && "photographer" in r.body, "orders, bookings, business, photographer still sent");
    assert(!r.raw.includes("SECRET_ETHNICITY") && !/"password"|resetTokenHash|resetCodeHash|stripeCustomerId|"ethnicity"/.test(r.raw), "no ethnicity, password, reset or Stripe customer fields");

    console.log("\n=== Web customer detail ===");
    r = await call("GET", `/api/admin/users/${webId}`, { token: adminToken });
    assert(val("Interests", "Industries") === "Fashion & Accessories, Other" && val("Interests", "Originally picked") === "Fashion & Apparel, Travel & Adventure", "web names on the shared list, original words shown", val("Interests", "Industries"));
    assert(val("Interests", "Matches business industries") === "Fashion & Accessories, Other", "web only interest goes to Other");
    assert(val("Interests", "What they're into") === "Not provided" && val("Interests", "What matters most") === "Not provided", "no niches → Not provided");
    assert(val("Contact", "Home address") === "1 Main St, Freeport, NY 11520, United States" && val("Contact", "Billing address") === "Same as home", "address rows");
    assert(val("Account", "Signed up from") === "outsyde-web" && val("Account", "Type") === "Customer", "account rows");

    console.log("\n=== Users list unchanged ===");
    r = await call("GET", `/api/admin/users?search=${encodeURIComponent(P)}`, { token: adminToken });
    const listKeys = Object.keys(r.body?.users?.[0] ?? {}).sort().join(",");
    assert(r.status === 200 && r.body?.users?.length === 2 && listKeys === "city,createdAt,deletionStatus,email,firstName,id,isActive,isAdmin,isPhotographer,isVendor,lastName,loyaltyPoints,name,scheduledDeletionAt,state", "list keys unchanged", listKeys);
  } finally {
    await q(`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM notifications WHERE reference_id IN (SELECT id::text FROM users WHERE email LIKE $1)`, [`${P}-%`]).catch(() => {});
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${P}-%`]).catch((e) => console.error("cleanup", e.message));
    await db.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
