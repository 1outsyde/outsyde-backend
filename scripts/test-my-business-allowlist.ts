/**
 * Allowlist tests for PATCH /api/vendor/my-business.
 *
 * Local Postgres only. Refuses any other DATABASE_URL.
 *
 *   DATABASE_URL=<localhost postgres url> \
 *   NODE_OPTIONS="--import ./.dev/neon-preload.mjs" \
 *   JWT_SECRET=<dev secret> \
 *   npx tsx scripts/test-my-business-allowlist.ts
 */
import { randomUUID } from "node:crypto";

const dbUrl = process.env.DATABASE_URL || "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
  console.error("Refusing to run: DATABASE_URL must point at a local database.");
  process.exit(2);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.includes("127.0.0.1") || url.includes("localhost")) return realFetch(input, init);
  return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const warns: string[] = [];
const origWarn = console.warn;
console.warn = (...args: any[]) => {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  if (line.startsWith("[my-business]")) warns.push(line);
  origWarn(...args);
};

type CaseResult = { name: string; pass: boolean; detail: string };
const results: CaseResult[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonical((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
  }
  return value;
}

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

async function main() {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const { db } = await import("../server/db");
  const schema = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const { registerRoutes } = await import("../server/routes");
  const { generateAccessToken } = await import("../server/auth");

  const tag = randomUUID().slice(0, 8);
  const [owner] = await db.insert(schema.users).values({
    username: `al_${tag}`,
    email: `allow-${tag}@example.com`,
    name: "Allow Owner",
  } as any).returning();
  const [admin] = await db.insert(schema.users).values({
    username: `ad_${tag}`,
    email: `allow-admin-${tag}@example.com`,
    name: "Allow Admin",
  } as any).returning();
  const [biz] = await db.insert(schema.businesses).values({
    ownerId: owner.id,
    name: `Allow Biz ${tag}`,
    category: "beauty",
    autoAcceptBookings: true,
    stripeAccountId: "acct_original",
    stripeOnboardingComplete: false,
    approvalStatus: "approved",
    subscriptionActive: false,
    rating: 10,
    reviewCount: 2,
    isDemo: false,
    cancellationFeeAmount: 500,
  } as any).returning();

  const app = express();
  app.use(express.json());
  const server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const vendorToken = generateAccessToken({ userId: owner.id, isVendor: true, businessId: biz.id });
  const adminToken = generateAccessToken({ userId: admin.id, isVendor: false, isAdmin: true });

  const row = async () =>
    (await db.select().from(schema.businesses).where(eq(schema.businesses.id, biz.id)))[0] as any;

  async function call(
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`http://127.0.0.1:${port}/api/vendor/my-business`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  }

  try {
    const allowed = {
      name: `Salon ${tag}`,
      category: "Beauty",
      description: "Desc",
      tagline: "Tag",
      city: "Atlanta",
      state: "GA",
      zipCode: "30301",
      address: "10 Peachtree",
      hasPhysicalLocation: false,
      hasProducts: true,
      hasServices: true,
      yearsInBusiness: "5",
      contactEmail: "vendor@example.com",
      contactPhone: "404-555-0199",
      websiteUrl: "https://example.com",
      brandColors: { primary: "#eab308" },
      logoImage: "https://cdn.example/logo.png",
      knownFor: ["Knotless"],
      hoursOfOperation: { monday: { open: true, start: "09:00", end: "17:00" } },
      defaultServiceLocationType: "customer",
      vendorTermsAndConditions: "No refunds",
      responseTimeValue: 2,
      responseTimeUnit: "hours",
      showResponseTime: false,
      showEmail: false,
      showPhone: false,
      showWebsite: false,
      showStoreHours: false,
      showAddress: false,
      siteConfig: { stylistPhoto: "https://cdn.example/stylist.jpg", galleryPhotos: ["https://cdn.example/g.jpg", null, null, null] },
      ctaConfig: { buttonType: "book_now" },
      coverImage: "https://cdn.example/cover.jpg",
      coverMediaType: "image",
    };

    warns.length = 0;
    let r = await call(vendorToken, allowed);
    let saved = await row();
    const missing = Object.keys(allowed).filter((key) => !same(saved[key], (allowed as any)[key]));
    record(
      "a) 29 keys + siteConfig + ctaConfig + coverImage/coverMediaType",
      r.status === 200 && missing.length === 0,
      r.status === 200 && missing.length === 0 ? "saved" : `status ${r.status} missing ${missing.join(",")} storedHours=${JSON.stringify(saved.hoursOfOperation)}`,
    );

    const beforeDrop = await row();
    const forbidden = {
      stripeAccountId: "acct_stolen",
      stripeOnboardingComplete: true,
      approvalStatus: "pending",
      approvedBy: admin.id,
      subscriptionActive: true,
      rating: 99,
      reviewCount: 99,
      ownerId: admin.id,
      id: randomUUID(),
      isDemo: true,
      createdAt: "2000-01-01T00:00:00.000Z",
      cancellationFeeAmount: 1,
    };
    warns.length = 0;
    r = await call(vendorToken, forbidden);
    const afterDrop = await row();
    const changed = Object.keys(forbidden).filter((key) => !same(afterDrop[key], beforeDrop[key]));
    const warnLine = warns.find((w) => w.startsWith("[my-business] dropped keys:")) ?? "";
    const logged = Object.keys(forbidden).filter((key) => !warnLine.includes(key));
    record(
      "b) sensitive keys not saved and logged as dropped",
      r.status === 200 && changed.length === 0 && logged.length === 0,
      `status ${r.status}; changed ${changed.join(",") || "none"}; unlogged ${logged.join(",") || "none"}; warn ${warnLine}`,
    );

    warns.length = 0;
    const onboarding = {
      name: `Onboard ${tag}`,
      category: "beauty",
      description: "A salon",
      tagline: "Hello",
      city: "Atlanta",
      state: "GA",
      hasProducts: false,
      hasServices: true,
      yearsInBusiness: 3,
      numberOfEmployees: 4,
      businessStructure: "LLC",
      hasPhysicalLocation: true,
      address: "1 Main",
      contactEmail: "onboard@example.com",
      contactPhone: "404-555-0100",
      websiteUrl: "https://onboard.example.com",
    };
    r = await call(vendorToken, onboarding);
    saved = await row();
    const onboardingOk =
      r.status === 200 &&
      saved.name === onboarding.name &&
      saved.category === onboarding.category &&
      saved.description === onboarding.description &&
      saved.tagline === onboarding.tagline &&
      saved.city === onboarding.city &&
      saved.state === onboarding.state &&
      saved.hasProducts === false &&
      saved.hasServices === true &&
      String(saved.yearsInBusiness) === "3" &&
      saved.hasPhysicalLocation === true &&
      saved.address === onboarding.address &&
      saved.contactEmail === onboarding.contactEmail &&
      saved.contactPhone === onboarding.contactPhone &&
      saved.websiteUrl === onboarding.websiteUrl &&
      saved.employeeCount == null &&
      saved.businessType == null &&
      warns.some((w) => w.includes("numberOfEmployees") && w.includes("businessStructure"));
    record(
      "c) onboarding payload saves real columns, drops unknown keys",
      onboardingOk,
      `status ${r.status}; years=${saved.yearsInBusiness}; employeeCount=${saved.employeeCount}; businessType=${saved.businessType}; warn ${warns.filter((w) => w.startsWith("[my-business]")).join(" | ")}`,
    );

    warns.length = 0;
    const siteConfig = { stylistPhoto: "https://cdn.example/lana.jpg", galleryPhotos: [null, null, null, null] };
    r = await call(adminToken, { siteConfig }, { "x-business-id": biz.id });
    saved = await row();
    const siteOk = r.status === 200 && same(saved.siteConfig, siteConfig);
    record(
      "d1) Lana siteConfig via x-business-id",
      siteOk,
      `status ${r.status}; siteConfig ${JSON.stringify(saved.siteConfig)}`,
    );

    const cover = { coverImage: "https://cdn.example/lana-cover.jpg", coverMediaType: "image" };
    r = await call(adminToken, cover, { "x-business-id": biz.id });
    saved = await row();
    const coverOk = r.status === 200 && saved.coverImage === cover.coverImage && saved.coverMediaType === "image";
    record(
      "d2) Lana coverImage/coverMediaType via x-business-id",
      coverOk,
      `status ${r.status}; cover ${saved.coverImage} ${saved.coverMediaType}`,
    );

    warns.length = 0;
    const nameBeforeFlag = (await row()).name;
    r = await call(vendorToken, { name: `Still Auto ${tag}`, autoAcceptBookings: false });
    saved = await row();
    const flagLogged = warns.some((w) => w.includes("autoAcceptBookings"));
    record(
      "e) autoAcceptBookings in body is not persisted",
      r.status === 200 && saved.autoAcceptBookings === true && saved.name === `Still Auto ${tag}` && !flagLogged,
      `status ${r.status}; autoAccept=${saved.autoAcceptBookings}; name=${saved.name}; previous=${nameBeforeFlag}; logged=${flagLogged}`,
    );

    const beforeInvalid = await row();
    r = await call(vendorToken, { city: "" });
    const city400 = r.status === 400 && r.body?.error === "city must be a non-empty string (max 100 chars)";
    r = await call(vendorToken, { contactEmail: "not-an-email" });
    const email400 = r.status === 400 && r.body?.error === "contactEmail must be a valid email address";
    r = await call(vendorToken, { websiteUrl: "not a url" });
    const url400 = r.status === 400 && r.body?.error === "websiteUrl must be a valid URL";
    saved = await row();
    const unchanged =
      saved.city === beforeInvalid.city &&
      saved.contactEmail === beforeInvalid.contactEmail &&
      saved.websiteUrl === beforeInvalid.websiteUrl;
    record(
      "f) invalid city / contactEmail / websiteUrl still 400",
      city400 && email400 && url400 && unchanged,
      `city400=${city400} email400=${email400} url400=${url400} unchanged=${unchanged}`,
    );
  } finally {
    await db.delete(schema.weeklyAvailability).where(eq(schema.weeklyAvailability.providerId, biz.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, biz.id));
    await db.delete(schema.users).where(eq(schema.users.id, owner.id));
    await db.delete(schema.users).where(eq(schema.users.id, admin.id));
    server.close();
  }

  const failed = results.filter((c) => !c.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
