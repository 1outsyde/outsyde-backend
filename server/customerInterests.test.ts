/**
 * Pure tests for customer interests on the shared business list (2026-10-18).
 * Run: DATABASE_URL=<any local url> npx tsx server/customerInterests.test.ts
 */
import {
  normalizeCustomerInterests, interestMatchProfile, interestUpdateFields, customerInterestTaxonomy,
  interestIndustryNames, LEGACY_NICHES, LEGACY_INDUSTRIES, CUSTOMER_VALUE_OPTIONS, VALUE_LABELS,
} from "@shared/customerInterests";
import { BUSINESS_CATEGORIES, getSpecialty, getCategory } from "@shared/businessTaxonomy";
import { buildCustomerSignupSections } from "./customerSignupDetails";

let passed = 0, failed = 0;
const ok = (c: boolean, n: string, d?: unknown) => { if (c) { passed++; console.log("  ✅ " + n); } else { failed++; console.error("  ❌ " + n, d === undefined ? "" : JSON.stringify(d)); } };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n=== Lists are sound ===");
ok(Object.values(LEGACY_NICHES).every((m) => Object.values(m).every((codes) => codes.length && codes.every((c) => !!getSpecialty(c)))), "every older niche maps to real specialties");
ok(Object.values(LEGACY_INDUSTRIES).every((v) => !!getCategory(v.categoryCode)), "every older industry maps to a real industry");
ok(BUSINESS_CATEGORIES.every((c) => (CUSTOMER_VALUE_OPTIONS[c.code] ?? []).length > 0), "every industry has what matters choices");
ok(Object.values(CUSTOMER_VALUE_OPTIONS).flat().every((id) => !!VALUE_LABELS[id]), "every what matters choice has a label");
const tx = customerInterestTaxonomy();
ok(tx.categories.length === BUSINESS_CATEGORIES.length && tx.categories.every((c) => c.specialties.every((s) => !s.code.endsWith(".other"))), "public list: every industry, no Other specialties");
ok(tx.categories.find((c) => c.code === "other")?.specialties.length === 0, "Other industry has no specialties (text box instead)");

console.log("\n=== New codes pass through unchanged ===");
let n = normalizeCustomerInterests({
  selectedIndustries: ["beauty", "food"],
  industryNiches: { beauty: ["beauty.service.braids_locs", "beauty.product.skincare"] },
  industryValues: { beauty: ["skill", "price"], food: ["taste"] },
  interestOther: "  ",
});
ok(eq(n.selectedIndustries, ["beauty", "food"]) && eq(n.industryNiches, { beauty: ["beauty.service.braids_locs", "beauty.product.skincare"] }), "codes kept");
ok(eq(n.industryValues, { beauty: ["skill", "price"], food: ["taste"] }), "values kept");
ok(n.original === null && n.interestOther === null, "nothing mapped → no original; blank Other → null");

console.log("\n=== Older app answers map ===");
n = normalizeCustomerInterests({
  selectedIndustries: ["clothing", "beauty-services", "services"],
  industryNiches: { clothing: ["Streetwear", "Athletic Wear"], "beauty-services": ["Braiding & Locs", "Barbershop"], services: ["Handyman", "Tutoring"] },
  industryValues: { clothing: ["quality", "bogus"], "beauty-services": ["skill"] },
});
ok(eq(n.selectedIndustries, ["fashion", "beauty", "professional", "health_fitness", "home"]), "industries mapped, cross industry niches add their industry", n.selectedIndustries);
ok(eq(n.industryNiches.fashion, ["fashion.product.streetwear"]) && eq(n.industryNiches.health_fitness, ["health_fitness.product.activewear"]), "clothing niches");
ok(eq(n.industryNiches.beauty, ["beauty.service.braids_locs", "beauty.service.barber"]), "beauty niches");
ok(eq(n.industryNiches.home, ["home.service.handyman"]) && eq(n.industryNiches.professional, ["professional.service.tutoring"]), "services niches");
ok(eq(n.industryValues, { fashion: ["quality"], beauty: ["skill"] }), "values follow the mapped industry, unknown dropped", n.industryValues);
ok(n.original !== null && eq((n.original as any).selectedIndustries, ["clothing", "beauty-services", "services"]), "original answers kept");

console.log("\n=== goutsyde.com names map, web only go to nearest ===");
n = normalizeCustomerInterests({ selectedIndustries: ["Fashion & Apparel", "Travel & Adventure", "Finance", "Entertainment", "Sustainability", "Pets"], industryNiches: {}, industryValues: {} });
ok(eq(n.selectedIndustries, ["fashion", "other", "professional", "events", "pets"]), "names mapped and de duplicated", n.selectedIndustries);
ok(n.original !== null, "original kept");

console.log("\n=== Junk never throws or saves ===");
n = normalizeCustomerInterests({ selectedIndustries: ["nope", 5, null, " beauty "], industryNiches: { beauty: ["fashion.product.shoes", "beauty.product.makeup", "made up"] }, industryValues: { nope: ["quality"] } });
ok(eq(n.selectedIndustries, ["beauty"]), "unknown and non text dropped, spaces trimmed", n.selectedIndustries);
ok(eq(n.industryNiches, { beauty: ["beauty.product.makeup"] }), "a specialty from another industry under a new code is dropped", n.industryNiches);
ok(eq(n.industryValues, {}) && n.original !== null, "values for an unpicked industry dropped; original kept");
n = normalizeCustomerInterests({ selectedIndustries: "x", industryNiches: [1], industryValues: "y", interestOther: "a".repeat(900) });
ok(eq(n.selectedIndustries, []) && n.interestOther?.length === 500, "bad shapes → empty, Other cut to 500");
n = normalizeCustomerInterests({});
ok(eq(n, { selectedIndustries: [], industryNiches: {}, industryValues: {}, interestOther: null, original: null }), "nothing sent → empty, no original");

console.log("\n=== Update routes change only the keys sent ===");
ok(eq(Object.keys(interestUpdateFields({ industryNiches: { beauty: ["beauty.service.nails"] } })), ["industryNiches"]), "only niches");
const up = interestUpdateFields({ selectedIndustries: ["food"] });
ok(eq(up, { selectedIndustries: ["food"] }), "a value that is already a shared code saves as is", up);
ok("interestsOriginal" in interestUpdateFields({ selectedIndustries: ["Finance"] }), "older words keep the original");

console.log("\n=== Matching profile ===");
let m = interestMatchProfile({ selectedIndustries: ["beauty", "other"], industryNiches: { beauty: ["beauty.service.braids_locs"] } });
ok(eq(m.categoryCodes, ["beauty", "other"]) && eq(m.specialtyCodes, ["beauty.service.braids_locs"]), "codes");
ok(eq(m.industryTerms, ["beauty & personal care"]) && eq(m.nicheTerms, ["braids & locs"]), "readable terms, Other left out of text matching");
m = interestMatchProfile({ selectedIndustries: ["Pets", "beauty-services"], industryNiches: { "beauty-services": ["Hair Coloring"] } });
ok(m.categoryCodes.includes("pets") && m.categoryCodes.includes("beauty") && m.specialtyCodes.includes("beauty.service.hair_styling"), "older words matched by code");
ok(m.industryTerms.includes("pets") && m.industryTerms.includes("beauty services") && m.nicheTerms.includes("hair coloring"), "older words kept as text terms");
ok(eq(interestIndustryNames(["clothing", "Fashion & Apparel", "Travel & Adventure"]), ["Fashion & Accessories"]), "analytics names: mapped, de duplicated, Other left out");

console.log("\n=== Admin rows show Other text and original answers ===");
const secs = buildCustomerSignupSections({
  selectedIndustries: ["other", "fashion"], industryNiches: {}, industryValues: {}, interestOther: "Vintage cars",
  interestsOriginal: { selectedIndustries: ["Travel & Adventure", "clothing"], industryNiches: { clothing: ["Vintage"] }, industryValues: {} },
  isActive: true, loyaltyPoints: 0,
} as any);
const rows = secs[0].rows;
const v = (l: string) => rows.find((r) => r.label === l)?.value;
ok(v("Industries") === "Other, Fashion & Accessories" && v("Their own words (Other)") === "Vintage cars", "codes readable + Other text");
ok(v("Originally picked") === "Travel & Adventure, Clothing & Fashion" && v("Originally into (Clothing & Fashion)") === "Vintage", "original answers shown");
const none = buildCustomerSignupSections({ selectedIndustries: [], isActive: true } as any)[0].rows;
ok(none.find((r) => r.label === "Their own words (Other)")?.value === "Not provided" && !none.some((r) => r.label === "Originally picked"), "no Other text → Not provided; no original rows");
ok(!/[–—]/.test(JSON.stringify(secs)), "no dashes");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
