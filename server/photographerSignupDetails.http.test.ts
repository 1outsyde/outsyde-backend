/**
 * Photographer signup details (migration 053, 2026-10-18): HTTP integration tests.
 *
 * Run with: npx tsx server/photographerSignupDetails.http.test.ts
 *
 * SCRATCH ONLY. Needs a backend booted on localhost against a LOCAL scratch Postgres
 * (full schema + migration 053). Environment variables:
 *   PS_TEST_BASE_URL   e.g. http://localhost:5062   (must be localhost)
 *   PS_TEST_PG_URL     the SAME scratch database    (localhost only; seeds + cleans up)
 *   JWT_SECRET         identical to the server's
 * Skips (exit 0) when PS_TEST_BASE_URL is unset; refuses any non-local host.
 *
 * Mutation checks:
 *  - remove `toStringList` from shootLocation in the signup route → "one shoot location as text saves" fails (500).
 *  - remove the db.delete(users) on a failed insert → "failed insert leaves no login behind" fails.
 *  - drop the Stripe field strip in adminPhotographerRow → "list has no Stripe ids" fails.
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
async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE!);
    const data = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    // A fresh address per call keeps the signup rate limiter out of the way.
    const headers: Record<string, string> = { "X-Forwarded-For": `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` };
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

  const P = `ps${Date.now().toString(36)}`;
  const email = (s: string) => `${P}-${s}@test.local`;
  const uname = (s: string) => `${P}${s}`.slice(0, 20);
  const row = async (s: string) => (await q(
    `SELECT p.*, u.phone AS owner_phone FROM photographers p JOIN users u ON u.id = p.user_id WHERE u.email = $1`, [email(s)],
  ))[0];
  const userCount = async (s: string) => Number((await q(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [email(s)]))[0].n);
  const body = (s: string, over: Record<string, unknown> = {}) => ({
    email: email(s), password: "secret123", name: `Owner ${s}`, username: uname(s), phone: "5165550123",
    displayName: `${P} ${s}`, city: "Freeport", state: "NY", hourlyRate: 150, portfolioUrl: "", skipStripe: true, ...over,
  });

  let [admin] = await q(`SELECT id FROM users WHERE email = 'info@goutsyde.com'`);
  if (!admin) {
    [admin] = await q(`INSERT INTO users (id, email, name, username, is_admin) VALUES (gen_random_uuid(), 'info@goutsyde.com', 'Admin', $1, true) RETURNING id`, [uname("adm")]);
  } else {
    await q(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id]);
  }
  const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });

  try {
    console.log("\n=== Shared list ===");
    let r = await call("GET", "/api/taxonomy/photographer");
    assert(r.status === 200 && r.body?.maxSpecialties === 5 && r.body?.specialties?.length === 18, "list served: 18 specialties, max 5", r.body && { n: r.body.specialties?.length, m: r.body.maxSpecialties });
    assert(r.body?.specialties?.some((s: any) => s.code === "photo.other") && r.body?.options?.experienceLevel?.length === 5, "Other + answer choices included");

    console.log("\n=== App style signup with every answer ===");
    r = await call("POST", "/api/auth/photographer/signup", { body: body("app", {
      bio: "I shoot people", specialtyCodes: ["photo.weddings", "photo.family_newborn", "photo.other"], specialtyOther: "  Pet portraits  ",
      shootLocation: ["on-location", "studio"], studioName: "Light Room", studioAddress: "1 Main St", usesSharedStudio: true,
      travelRadius: "25_miles", pricingType: "per_session", startingPrice: 175.5, minimumBooking: "2_hours",
      additionalServices: ["Drone photography", "Rush delivery"], experienceLevel: "3_5_years", equipmentLevel: "pro_studio", deliveryTime: "3_5_days",
    }) });
    let p = await row("app");
    assert(r.status === 201 || r.status === 200, "signup succeeds", r);
    assert(JSON.stringify(p?.specialty_codes) === '["photo.weddings","photo.family_newborn","photo.other"]', "codes saved", p?.specialty_codes);
    assert(JSON.stringify(p?.specialties) === JSON.stringify(["Weddings & engagements", "Family, newborn & maternity", "Other"]), "readable names follow codes", p?.specialties);
    assert(p?.specialty_other === "Pet portraits", "Other description saved trimmed", p?.specialty_other);
    assert(p?.bio === "I shoot people" && p?.owner_phone === "5165550123", "bio and phone saved");
    assert(JSON.stringify(p?.shoot_location) === '["on-location","studio"]' && p?.studio_name === "Light Room" && p?.uses_shared_studio === true, "where they shoot saved");
    assert(p?.travel_radius === "25_miles" && p?.pricing_type === "per_session" && p?.starting_price === 17550 && p?.minimum_booking === "2_hours", "pricing + travel saved", p && { t: p.travel_radius, s: p.starting_price });
    assert(JSON.stringify(p?.additional_services) === '["Drone photography","Rush delivery"]' && p?.experience_level === "3_5_years" && p?.equipment_level === "pro_studio" && p?.delivery_time === "3_5_days", "details saved");

    console.log("\n=== Website style signup (older names, one shoot location as text) ===");
    r = await call("POST", "/api/auth/photographer/signup", { body: body("web", {
      specialties: ["Portraits", "Concerts", "Underwater"], shootLocation: "Studio only", travelRadius: "40", experienceLevel: "Hobbyist", startingPrice: "250",
    }) });
    p = await row("web");
    assert(r.status === 201 || r.status === 200, "one shoot location as text saves (no 500)", r);
    assert(JSON.stringify(p?.shoot_location) === '["Studio only"]', "shoot location stored as a list", p?.shoot_location);
    assert(JSON.stringify(p?.specialty_codes) === '["photo.portraits","photo.concerts"]', "known names mapped to codes", p?.specialty_codes);
    assert(JSON.stringify(p?.specialties) === JSON.stringify(["Portraits & headshots", "Concerts & nightlife", "Underwater"]), "unknown name kept as typed", p?.specialties);
    assert(p?.starting_price === 25000, "starting price text parsed", p?.starting_price);

    console.log("\n=== Old app build (no specialties, no extras) still works ===");
    r = await call("POST", "/api/auth/photographer/signup", { body: body("old", { city: "Unknown", state: "NA", portfolioUrl: "https://outsyde.app", hourlyRate: 5000 }) });
    p = await row("old");
    assert((r.status === 201 || r.status === 200) && JSON.stringify(p?.specialty_codes) === "[]", "old payload accepted, empty codes", r.status);

    console.log("\n=== Bad picks are rejected before any account is made ===");
    const bad: [string, Record<string, unknown>][] = [
      ["unknown code", { specialtyCodes: ["photo.spaceships"] }],
      ["more than 5", { specialtyCodes: ["photo.weddings", "photo.portraits", "photo.events", "photo.fashion", "photo.sports", "photo.travel"] }],
      ["Other without description", { specialtyCodes: ["photo.other"] }],
      ["duplicates", { specialtyCodes: ["photo.sports", "photo.sports"] }],
      ["codes not a list", { specialtyCodes: "photo.sports" }],
      ["description too long", { specialtyCodes: ["photo.other"], specialtyOther: "x".repeat(501) }],
    ];
    for (const [i, [name, over]] of bad.entries()) {
      r = await call("POST", "/api/auth/photographer/signup", { body: body(`bad${i}`, over) });
      assert(r.status === 400 && r.body?.field === "specialties" && (await userCount(`bad${i}`)) === 0, `${name} → 400, no account`, { status: r.status, body: r.body });
    }

    console.log("\n=== A failed profile insert leaves no login behind ===");
    r = await call("POST", "/api/auth/photographer/signup", { body: body("fail", { hourlyRate: 99_999_999_999 }) });
    assert(r.status >= 400 && (await userCount("fail")) === 0, "failed insert leaves no login behind", { status: r.status, users: await userCount("fail") });
    r = await call("POST", "/api/auth/photographer/signup", { body: body("fail") });
    assert(r.status === 201 || r.status === 200, "same email can sign up again after a failure", r.status);

    console.log("\n=== Admin list ===");
    r = await call("GET", "/api/admin/photographers", { token: adminToken });
    const listed = Array.isArray(r.body) ? r.body.find((x: any) => x.displayName === `${P} app`) : null;
    assert(r.status === 200 && Array.isArray(r.body) && !!listed, "still a bare array, includes the new photographer", r.status);
    assert(listed && listed.ownerEmail === email("app") && listed.ownerPhone === "5165550123" && listed.ownerUsername === uname("app") && listed.email === email("app"), "owner contact included", listed && { e: listed.ownerEmail, p: listed.ownerPhone });
    assert(Array.isArray(r.body) && r.body.every((x: any) => !("stripeAccountId" in x) && !("stripeOnboardingUrl" in x) && !("password" in x)), "list has no Stripe ids or password");
    assert(listed && "stripeOnboardingComplete" in listed && "visibilityStatus" in listed && Array.isArray(listed.specialtyLabels), "fields the web list reads still there");
    const consumer = await q(`INSERT INTO users (id, email, name, username) VALUES (gen_random_uuid(), $1, 'Plain', $2) RETURNING id`, [email("plain"), uname("plain")]);
    const plainToken = generateAccessToken({ userId: consumer[0].id, isVendor: false, isAdmin: false });
    r = await call("GET", "/api/admin/photographers", { token: plainToken });
    assert(r.status === 403 || r.status === 401, "non admin blocked from the list", r.status);

    console.log("\n=== Admin detail ===");
    const appId = (await row("app")).id;
    r = await call("GET", `/api/admin/photographers/${appId}`, { token: adminToken });
    const sections = r.body?.signupDetails?.sections ?? [];
    const rowsText = JSON.stringify(sections);
    assert(r.status === 200 && sections.map((s: any) => s.title).join("|") === "Profile|Pricing|Where they shoot|Owner|Status", "detail has every section", sections.map((s: any) => s.title));
    assert(rowsText.includes("Family, newborn & maternity") && rowsText.includes("Pet portraits") && rowsText.includes("3 to 5 years") && rowsText.includes("Up to 25 miles") && rowsText.includes("$175.50"), "answers shown with readable labels");
    assert(JSON.stringify(r.body?.signupDetails?.specialties?.labels) === JSON.stringify(["Weddings & engagements", "Family, newborn & maternity", "Other"]), "labels with commas stay whole");
    assert(!JSON.stringify(r.body).includes("stripeAccountId") && !JSON.stringify(r.body).includes("acct_"), "detail has no Stripe ids");
    const webId = (await row("web")).id;
    r = await call("GET", `/api/admin/photographers/${webId}`, { token: adminToken });
    assert(JSON.stringify(r.body?.signupDetails?.sections).includes("40 miles") && JSON.stringify(r.body?.signupDetails?.sections).includes("Hobbyist"), "website answers shown as typed / readable");
    const oldId = (await row("old")).id;
    r = await call("GET", `/api/admin/photographers/${oldId}`, { token: adminToken });
    const portfolio = (r.body?.signupDetails?.sections?.[0]?.rows ?? []).find((x: any) => x.label === "Portfolio");
    assert(portfolio?.value === "Not provided", "placeholder portfolio shown as Not provided", portfolio);
    r = await call("GET", `/api/admin/photographers/00000000-0000-0000-0000-000000000000`, { token: adminToken });
    assert(r.status === 404, "unknown id → 404", r.status);
    r = await call("GET", `/api/admin/photographers/${appId}`, { token: plainToken });
    assert(r.status === 403 || r.status === 401, "non admin blocked from detail", r.status);
    r = await call("GET", `/api/admin/photographers/${appId}`);
    assert(r.status === 401, "no login → 401", r.status);

    console.log("\n=== Profile saves keep codes in sync ===");
    const webOwner = (await q(`SELECT id FROM users WHERE email = $1`, [email("web")]))[0].id;
    const webToken = generateAccessToken({ userId: webOwner, isVendor: false, isAdmin: false, isPhotographer: true } as any);
    r = await call("PATCH", "/api/photographers/me", { token: webToken, body: { specialties: ["Weddings", "Food"] } });
    p = await row("web");
    assert(r.status === 200 && JSON.stringify(p.specialty_codes) === '["photo.weddings","photo.food"]' && JSON.stringify(p.specialties) === JSON.stringify(["Weddings & engagements", "Food & drink"]), "older editor sends names → codes + names updated", { status: r.status, c: p.specialty_codes });
    r = await call("PATCH", "/api/photographers/me", { token: webToken, body: { specialtyCodes: ["photo.nope"] } });
    p = await row("web");
    assert(r.status === 400 && r.body?.field === "specialties" && JSON.stringify(p.specialty_codes) === '["photo.weddings","photo.food"]', "bad code on profile save → 400, unchanged", r);
    r = await call("PATCH", "/api/photographers/me", { token: webToken, body: { bio: "Only the bio" } });
    p = await row("web");
    assert(r.status === 200 && p.bio === "Only the bio" && JSON.stringify(p.specialty_codes) === '["photo.weddings","photo.food"]', "save without specialties leaves them alone");
    r = await call("PATCH", `/api/admin/photographers/${webId}`, { token: adminToken, body: { specialties: ["Sports"] } });
    p = await row("web");
    assert(r.status === 200 && JSON.stringify(p.specialty_codes) === '["photo.sports"]' && JSON.stringify(p.specialties) === '["Sports"]', "admin edit keeps codes in sync", { status: r.status, c: p.specialty_codes });
  } finally {
    const ids = (await q(`SELECT id FROM users WHERE email LIKE $1`, [`${P}-%`])).map((x) => x.id);
    if (ids.length) {
      await q(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await q(`DELETE FROM photographers WHERE user_id = ANY($1)`, [ids]);
      await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
    }
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
