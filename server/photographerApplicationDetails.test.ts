/**
 * Pure tests for the photographer admin email rows (2026-10-18).
 * Run: DATABASE_URL=<any local url> npx tsx server/photographerApplicationDetails.test.ts
 */
import { buildPhotographerApplicationSections, photographerSpecialtyNames } from "./photographerApplicationDetails";
import { renderSectionsHtml, renderSectionsText, NOT_PROVIDED } from "./adminApplicationDetails";
import { resolvePhotographerSpecialties, codesFromNames, optionLabel } from "@shared/photographerTaxonomy";

let passed = 0, failed = 0;
const ok = (c: boolean, n: string, d?: unknown) => { if (c) { passed++; console.log("  ✅ " + n); } else { failed++; console.error("  ❌ " + n, d ?? ""); } };

const base: any = {
  id: "p1", userId: "u1", displayName: `Bad "Name" <script>alert(1)</script>`, bio: "<img src=x onerror=alert(1)>", city: "Freeport", state: "NY",
  portfolioUrl: "javascript:alert(1)", hourlyRate: 150, specialties: ["Weddings & engagements"], specialtyCodes: ["photo.weddings"], specialtyOther: null,
  logoImage: null, shootLocation: null, studioName: null, studioAddress: null, usesSharedStudio: false, travelRadius: null, pricingType: null,
  startingPrice: null, minimumBooking: null, additionalServices: null, experienceLevel: null, equipmentLevel: null, deliveryTime: null,
  stripeAccountId: "acct_SECRET", stripeOnboardingUrl: "https://connect.stripe.com/secret", stripeOnboardingComplete: false,
  visibilityStatus: "public", adminNotes: null, createdAt: new Date("2026-10-18T12:00:00Z"),
};
const owner: any = { name: "Owner", email: "o@test.local", phone: null, username: "owner1", source: null, createdAt: new Date("2026-10-18T12:00:00Z") };

const sections = buildPhotographerApplicationSections(base, owner);
const html = renderSectionsHtml(sections);
const text = renderSectionsText(sections);
ok(!html.includes("<script>") && html.includes("&lt;script&gt;"), "names are escaped in the email");
ok(!html.includes("<img src=x") && !html.includes("javascript:"), "bio escaped and only http links are linked");
ok(!html.includes("acct_SECRET") && !text.includes("acct_SECRET") && !html.includes("connect.stripe.com"), "no Stripe ids in the email");
ok(sections.flatMap((s) => s.rows).filter((r) => r.value === NOT_PROVIDED).length >= 10, "blanks show Not provided");
ok(text.includes("Phone: Not provided") && text.includes("Username: @owner1"), "owner rows present");
ok(!/[–—]/.test(html) && !/[–—]/.test(text), "no dashes in the email copy");

ok(JSON.stringify(photographerSpecialtyNames({ specialtyCodes: [], specialties: ["Portraits"] } as any)) === '["Portraits"]', "older rows without codes show saved names");
ok(JSON.stringify(codesFromNames(["Concert", "nature", "real_estate", "Newborn & Family", "Food & Product", "??"])) ===
  JSON.stringify({ codes: ["photo.concerts", "photo.landscape", "photo.real_estate", "photo.family_newborn", "photo.product"], unknown: ["??"] }), "every older list name maps");
const r = resolvePhotographerSpecialties({ specialtyCodes: ["photo.sports"], specialtyOther: "ignored" });
ok("codes" in r && r.other === null, "Other text dropped when Other is not picked");
ok(optionLabel("travelRadius", "50") === "50 miles" && optionLabel("experienceLevel", "Hobbyist") === "Hobbyist" && optionLabel("deliveryTime", "24_48_hours") === "24 to 48 hours", "labels for app and website values");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
