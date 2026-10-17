/**
 * Business signup details (2026-10-17): shared industry list, admin email rows and rendering.
 * Pure tests, no database or network (Resend is intercepted at fetch).
 *
 * Run with: DATABASE_URL=postgresql://unused npx tsx server/adminApplicationDetails.test.ts
 * (db.ts throws on import without DATABASE_URL; nothing here connects.)
 *
 * Mutation checks:
 *  - remove escapeHtml() around r.value in renderSectionsHtml → "<script> is escaped" fails.
 *  - drop the offerType check in validateIndustrySelection → "services-only rejects product" fails.
 */
import type { Business, User } from "@shared/schema";
import {
  BUSINESS_CATEGORIES,
  MAX_SPECIALTIES,
  validateIndustrySelection,
  describeIndustry,
} from "@shared/businessTaxonomy";
import {
  buildVendorApplicationSections,
  renderSectionsHtml,
  renderSectionsText,
  buildSignupDetailsPayload,
  NOT_PROVIDED,
} from "./adminApplicationDetails";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}

function business(over: Partial<Business> = {}): Business {
  return {
    id: "biz-1", ownerId: "user-1", name: "Braids By Test", category: "Beauty & Personal Care",
    description: "Knotless braids", isStartup: true, yearsInBusiness: "10+", employeeCount: "Just me",
    businessType: "llc", hasPhysicalLocation: true, address: "1 Main St", city: "Freeport", state: "NY",
    zipCode: "11520", country: null, latitude: null, longitude: null, websiteUrl: "https://braids.test",
    socialMedia: "@braidsbytest", coverImage: null, coverMediaType: null, logoImage: "https://cdn.test/logo.png",
    rating: 0, reviewCount: 0, subscriptionActive: false, tagline: null, hoursOfOperation: null,
    contactEmail: null, contactPhone: null, brandColors: null, knownFor: [],
    categoryCode: "beauty", specialties: ["beauty.service.braids_locs", "beauty.product.hair_wigs_extensions"],
    otherDescription: null, hasProducts: true, hasServices: true, isMultiStaff: false,
    stripeAccountId: "acct_SECRET123", stripeOnboardingComplete: false, stripeOnboardingUrl: "https://connect.stripe.com/SECRET",
    stripeOnboardingLastEventAt: null,
    billingAddress: { line1: "2 Bill Rd", city: "Hempstead", state: "NY", postalCode: "11550", country: "United States" },
    approvalStatus: "pending", approvalNotes: null, approvedAt: null, approvedBy: null,
    vendorAgreementAccepted: true, vendorAgreementAcceptedAt: new Date("2026-10-17T16:00:00Z"),
    createdAt: new Date("2026-10-17T16:00:00Z"),
    ...over,
  } as unknown as Business;
}

const owner = {
  name: "Dede Test", email: "dede@test.local", phone: "5165550101", username: "dedetest",
  address: "9 Home Ave", city: "Freeport", state: "NY", zipCode: "11520",
  createdAt: new Date("2026-10-17T15:59:00Z"), source: "outsyde-web",
  password: "$2b$hash-SECRET", resetToken: "reset-SECRET",
} as unknown as Pick<User, "name" | "email" | "phone" | "username" | "address" | "city" | "state" | "zipCode" | "createdAt"> & { source: string };

const rowsOf = (b: Business, o: typeof owner | null = owner) =>
  Object.fromEntries(buildVendorApplicationSections(b, o).flatMap((s) => s.rows.map((r) => [r.label, r.value])));

(async () => {
  console.log("Shared list");
  const codes = BUSINESS_CATEGORIES.flatMap((c) => [c.code, ...c.specialties.map((s) => s.code)]);
  assert(new Set(codes).size === codes.length, "every code is unique");
  assert(BUSINESS_CATEGORIES.length === 11, "11 categories (10 + Other)", BUSINESS_CATEGORIES.length);
  assert(
    BUSINESS_CATEGORIES.every((c) => c.specialties.some((s) => s.code === `${c.code}.service.other`) && c.specialties.some((s) => s.code === `${c.code}.product.other`)),
    "every category has Other service and Other product",
  );
  assert(BUSINESS_CATEGORIES.every((c) => c.specialties.every((s) => s.code.startsWith(`${c.code}.${s.kind}.`))), "specialty codes are <category>.<kind>.<slug>");
  assert(MAX_SPECIALTIES === 3, "max 3 specialties");

  console.log("Validation");
  const ok = (o: Partial<Parameters<typeof validateIndustrySelection>[0]>) =>
    validateIndustrySelection({ categoryCode: "beauty", specialties: ["beauty.service.braids_locs"], offerType: "services", otherDescription: null, ...o });
  assert(ok({}).length === 0, "valid services selection passes");
  assert(ok({ specialties: ["beauty.product.hair_care"] }).length > 0, "services-only rejects a product specialty");
  assert(ok({ offerType: "products" }).length > 0, "products-only rejects a service specialty");
  assert(ok({ offerType: "both", specialties: ["beauty.service.nails", "beauty.product.hair_care"] }).length === 0, "both accepts service + product");
  assert(ok({ specialties: ["food.service.catering"] }).length > 0, "rejects a specialty from another category");
  assert(ok({ specialties: [] }).length > 0, "rejects zero specialties for a normal category");
  assert(ok({ offerType: "both", specialties: ["beauty.service.nails", "beauty.service.makeup", "beauty.service.barber", "beauty.service.waxing"] }).length > 0, "rejects more than 3");
  assert(ok({ specialties: ["beauty.service.nails", "beauty.service.nails"] }).length > 0, "rejects duplicates");
  assert(ok({ categoryCode: "made_up" }).length > 0, "rejects unknown category");
  assert(ok({ specialties: ["beauty.service.other"] }).length > 0, "Other specialty needs a description");
  assert(ok({ specialties: ["beauty.service.other"], otherDescription: "Loc jewelry installs" }).length === 0, "Other specialty with description passes");
  assert(ok({ categoryCode: "other", specialties: [], otherDescription: "Mobile car wash for boats" }).length === 0, "Other category with only a description passes");
  assert(ok({ categoryCode: "other", specialties: [] }).length > 0, "Other category without description fails");
  assert(ok({ specialties: ["beauty.service.other"], otherDescription: "x".repeat(501) }).length > 0, "description over 500 fails");

  console.log("Labels");
  const d = describeIndustry("beauty", ["beauty.service.braids_locs", "legacy.unknown"]);
  assert(d.categoryLabel === "Beauty & Personal Care", "category label");
  assert(d.specialties[0].label === "Braids & locs" && d.specialties[0].kind === "service", "specialty label + kind");
  assert(d.specialties[1].label === "legacy.unknown" && d.specialties[1].kind === null, "unknown code shown raw, not dropped");

  console.log("Email rows: every answer");
  const r = rowsOf(business());
  const expected = ["Business name", "Logo", "Industry", "What they do", "Their own words (Other)", "Offers", "Description",
    "Startup", "Multi staff", "Years in business", "Employees", "Business type", "Website", "Social media", "Look them up",
    "Physical location", "Business address", "Billing address", "Name", "Email", "Phone", "Username", "Home address",
    "Signed up from", "Account created", "Applied", "Approval", "Vendor agreement"];
  assert(expected.every((k) => k in r), "all 28 rows present", expected.filter((k) => !(k in r)));
  assert(r["Industry"] === "Beauty & Personal Care", "industry label");
  assert(r["What they do"] === "Braids & locs (service), Hair, wigs & extensions (product)", "what they do with kinds", r["What they do"]);
  assert(r["Offers"] === "Products and services", "offers");
  assert(r["Startup"] === "Yes" && r["Multi staff"] === "No", "yes/no");
  assert(r["Years in business"] === "10+ years" && r["Business type"] === "LLC", "web codes mapped to labels");
  assert(rowsOf(business({ yearsInBusiness: "5-10 years", businessType: "Sole Proprietor" }))["Years in business"] === "5-10 years", "app labels shown as typed");
  assert(r["Phone"] === "5165550101" && r["Username"] === "@dedetest", "owner phone + username");
  assert(r["Business address"] === "1 Main St, Freeport, NY 11520", "business address", r["Business address"]);
  assert(r["Billing address"] === "2 Bill Rd, Hempstead, NY 11550", "billing address", r["Billing address"]);
  assert(r["Home address"] === "9 Home Ave, Freeport, NY 11520", "owner home address");
  assert(r["Signed up from"] === "outsyde-web", "signup source");
  assert(r["Their own words (Other)"] === NOT_PROVIDED, "empty → Not provided");
  const legacy = rowsOf(business({ categoryCode: null, specialties: [], category: "Hair & Beauty" }), null);
  assert(legacy["Industry"] === "Hair & Beauty" && legacy["What they do"] === NOT_PROVIDED && legacy["Name"] === NOT_PROVIDED, "legacy business without codes or owner");

  console.log("Email HTML safety");
  const evil = business({
    name: `<script>alert(1)</script>"'`, description: "<img src=x onerror=alert(1)>",
    websiteUrl: "javascript:alert(1)", logoImage: "javascript:alert(2)",
  });
  const html = renderSectionsHtml(buildVendorApplicationSections(evil, owner));
  assert(!html.includes("<script>") && html.includes("&lt;script&gt;"), "<script> is escaped");
  assert(!html.includes("<img src=x"), "injected img is escaped");
  assert(!html.toLowerCase().includes('href="javascript:') && !html.toLowerCase().includes('src="javascript:'), "javascript: URLs never linked or loaded");
  const goodHtml = renderSectionsHtml(buildVendorApplicationSections(business(), owner));
  assert(goodHtml.includes('<img src="https://cdn.test/logo.png"'), "logo rendered as image");
  assert(goodHtml.includes('href="https://braids.test/"'), "website linked");
  const all = goodHtml + renderSectionsText(buildVendorApplicationSections(business(), owner)) + JSON.stringify(buildSignupDetailsPayload(business(), owner));
  assert(!/SECRET|acct_|\$2b\$/.test(all), "no Stripe ids, password hash or tokens anywhere");

  console.log("Full email through sendNewVendorApplicationEmail (Resend intercepted)");
  process.env.RESEND_API_KEY = "re_test_dummy";
  process.env.FRONTEND_URL = "https://www.goutsyde.com";
  const sent: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "email_test_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const { sendNewVendorApplicationEmail } = await import("./emailService");
  const okSend = await sendNewVendorApplicationEmail({
    adminEmail: "info@goutsyde.com", businessName: "Braids By Test", businessCategory: "Beauty & Personal Care",
    ownerName: "Dede Test", ownerEmail: "dede@test.local", location: "Freeport, NY", businessId: "biz-1",
    business: business(), owner,
  });
  assert(okSend === true && sent.length === 1, "one email sent", sent.length);
  const mail = sent[0] ?? {};
  assert(mail.subject === "New Vendor Application: Braids By Test", "subject unchanged", mail.subject);
  assert(String(mail.html).includes('href="https://www.goutsyde.com/admin/applications/biz-1"'), "Review button → goutsyde.com detail page");
  assert(String(mail.text).includes("Review: https://www.goutsyde.com/admin/applications/biz-1"), "text part has review link");
  assert(expected.every((label) => String(mail.text).includes(`${label}:`)), "text part lists every answer");
  assert(String(mail.html).includes("5165550101") && String(mail.html).includes("@braidsbytest"), "phone + social in html");

  sent.length = 0;
  await sendNewVendorApplicationEmail({
    adminEmail: "info@goutsyde.com", businessName: "Fallback Biz", businessCategory: "Beauty",
    ownerName: "Owner", ownerEmail: "o@test.local", location: null, businessId: "biz-2",
  });
  assert(sent.length === 1 && String(sent[0].text).includes("Business name: Fallback Biz") && String(sent[0].text).includes(`Location: ${NOT_PROVIDED}`), "fallback email when records not loaded");
  globalThis.fetch = realFetch;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
