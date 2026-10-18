/**
 * Pure tests for the customer signup rows on the admin user screens (2026-10-18).
 * Run: DATABASE_URL=<any local url> npx tsx server/customerSignupDetails.test.ts
 */
import { buildCustomerSignupSections, buildCustomerSignupDetailsPayload, birthdayText } from "./customerSignupDetails";
import { NOT_PROVIDED } from "./adminApplicationDetails";
import { describeCustomerInterests, interestCategoryCode, LEGACY_INDUSTRIES } from "@shared/customerInterests";
import { getCategory } from "@shared/businessTaxonomy";

let passed = 0, failed = 0;
const ok = (c: boolean, n: string, d?: unknown) => { if (c) { passed++; console.log("  ✅ " + n); } else { failed++; console.error("  ❌ " + n, d ?? ""); } };

const appUser: any = {
  name: "Kat X", firstName: "Kat", lastName: "X", email: "kat@test.local", phone: "5165550100", username: "katx",
  address: "1 Main St", aptUnit: null, city: "Freeport", state: "NY", zipCode: "11520", country: "United States",
  billingSameAsHome: true, dateOfBirth: new Date("1999-03-04T00:00:00Z"), gender: "Female", shoppingFrequency: "Weekly",
  ethnicity: "SECRET_ETHNICITY", password: "SECRET_HASH", resetTokenHash: "SECRET_RESET", stripeCustomerId: "cus_SECRET",
  selectedIndustries: ["clothing", "beauty-services", "Travel & Adventure", "mystery"],
  industryNiches: { clothing: ["Vintage", "Streetwear"], "beauty-services": [] },
  industryValues: { clothing: ["quality", "price", "weird_id"] },
  source: "outsyde-web", createdAt: new Date("2026-10-01T12:00:00Z"), isActive: true, isVendor: false, isPhotographer: false, isAdmin: false,
  loyaltyPoints: 1200, deletionStatus: "active",
};

const sections = buildCustomerSignupSections(appUser);
const flat = JSON.stringify(sections);
const row = (title: string, label: string) => sections.find((s) => s.title === title)?.rows.find((r) => r.label === label)?.value;

ok(sections.map((s) => s.title).join("|") === "Interests|About them|Contact|Account", "sections in order, interests first");
ok(row("Interests", "Industries") === "Clothing & Fashion, Beauty Services, Travel & Adventure, mystery", "app codes readable, web names and unknown values kept as typed");
ok(row("Interests", "Matches business industries") === "Fashion & Accessories, Beauty & Personal Care, Other", "nearest business industry, unknown left out");
ok(row("Interests", "Into (Clothing & Fashion)") === "Vintage, Streetwear", "niches by industry, empty groups hidden");
ok(row("Interests", "What matters (Clothing & Fashion)") === "Quality, Fair price, weird_id", "what matters readable, unknown kept");
ok(row("About them", "Birthday") === "Mar 4, 1999", "birthday shown as the saved date (UTC)");
ok(row("Contact", "Billing address") === "Same as home", "billing same as home");
ok(row("Contact", "Home address") === "1 Main St, Freeport, NY 11520, United States", "home address");
ok(row("Account", "Signed up from") === "outsyde-web" && row("Account", "Type") === "Customer", "account rows");
ok(!flat.includes("SECRET") && !flat.includes("cus_"), "no ethnicity, password, reset or Stripe values");
ok(!/[–—]/.test(flat), "no dashes in the copy");

const empty = buildCustomerSignupSections({ ...appUser, selectedIndustries: [], industryNiches: {}, industryValues: null, gender: null,
  dateOfBirth: null, shoppingFrequency: null, phone: null, address: null, city: null, state: null, zipCode: null, source: null } as any);
const emptyRow = (t: string, l: string) => empty.find((s) => s.title === t)?.rows.find((r) => r.label === l)?.value;
ok(emptyRow("Interests", "Industries") === NOT_PROVIDED && emptyRow("Interests", "What they're into") === NOT_PROVIDED &&
  emptyRow("Interests", "What matters most") === NOT_PROVIDED, "no interests → Not provided");
ok(emptyRow("Contact", "Home address") === NOT_PROVIDED && emptyRow("Contact", "Billing address") === NOT_PROVIDED, "no address → Not provided");
ok(emptyRow("About them", "Birthday") === NOT_PROVIDED && birthdayText("not a date") === NOT_PROVIDED, "bad or empty birthday");

const sep = buildCustomerSignupSections({ ...appUser, billingSameAsHome: false, billingStreet: "9 Pine", billingCity: "Hempstead", billingState: "NY", billingZip: "11550", billingCountry: "United States" } as any);
ok(sep.find((s) => s.title === "Contact")?.rows.find((r) => r.label === "Billing address")?.value === "9 Pine, Hempstead, NY 11550, United States", "separate billing address");

const del = buildCustomerSignupSections({ ...appUser, isActive: false, deletionStatus: "pending_deletion", scheduledDeletionAt: new Date("2026-11-01T12:00:00Z") } as any);
ok(JSON.stringify(del).includes("Deletion scheduled") && JSON.stringify(del).includes("Disabled"), "disabled + deletion scheduled shown");

// Every older value maps to a real shared business industry.
ok(Object.values(LEGACY_INDUSTRIES).every((v) => !!getCategory(v.categoryCode)), "every older value maps to a real industry");
ok(interestCategoryCode("beauty") === "beauty" && interestCategoryCode("nope") === null, "shared codes pass through, unknown is null");
const d = describeCustomerInterests({ selectedIndustries: "bad", industryNiches: ["bad"], industryValues: { x: "bad" } });
ok(d.industries.length === 0 && d.niches.length === 0 && d.values.length === 0, "bad shapes never throw");
const payload = buildCustomerSignupDetailsPayload(appUser);
ok(payload.interests.industries[0].categoryCode === "fashion" && Array.isArray(payload.sections), "payload shape");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
