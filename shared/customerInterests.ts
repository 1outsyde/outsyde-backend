/**
 * Customer interests (users.selected_industries / industry_niches / industry_values).
 *
 * 2026-10-18 (Legend): interests are shown in their own section on both admin dashboards
 * (never in signup emails) and move onto the shared business list (shared/businessTaxonomy.ts)
 * so customers can later be matched to businesses.
 *
 * Saved values today come from three older lists, all kept readable here:
 *   - app ConsumerSignupScreen codes ("clothing", "beauty-services", ...)
 *   - an older names version of the same app list ("Clothing & Fashion", ...)
 *   - goutsyde.com /consumer-signup names ("Fashion & Apparel", "Travel & Adventure", ...)
 * Anything else is shown exactly as typed, never dropped.
 */
import { getCategory, getSpecialty } from "./businessTaxonomy";

/** Older industry values → readable label + nearest shared business industry (Legend 2026-10-18). */
export const LEGACY_INDUSTRIES: Record<string, { label: string; categoryCode: string }> = {
  // App codes
  "clothing": { label: "Clothing & Fashion", categoryCode: "fashion" },
  "beauty-products": { label: "Beauty Products", categoryCode: "beauty" },
  "beauty-services": { label: "Beauty Services", categoryCode: "beauty" },
  "food": { label: "Food & Dining", categoryCode: "food" },
  "fitness": { label: "Fitness & Wellness", categoryCode: "health_fitness" },
  "home-goods": { label: "Home & Decor", categoryCode: "home" },
  "arts": { label: "Arts & Crafts", categoryCode: "art" },
  "services": { label: "Professional Services", categoryCode: "professional" },
  // Older app names
  "Clothing & Fashion": { label: "Clothing & Fashion", categoryCode: "fashion" },
  "Beauty Products": { label: "Beauty Products", categoryCode: "beauty" },
  "Beauty Services": { label: "Beauty Services", categoryCode: "beauty" },
  "Food & Dining": { label: "Food & Dining", categoryCode: "food" },
  "Fitness & Wellness": { label: "Fitness & Wellness", categoryCode: "health_fitness" },
  "Home & Decor": { label: "Home & Decor", categoryCode: "home" },
  "Arts & Crafts": { label: "Arts & Crafts", categoryCode: "art" },
  "Professional Services": { label: "Professional Services", categoryCode: "professional" },
  // goutsyde.com names (web only ones go to the nearest industry, Legend 2026-10-18)
  "Fashion & Apparel": { label: "Fashion & Apparel", categoryCode: "fashion" },
  "Beauty & Wellness": { label: "Beauty & Wellness", categoryCode: "beauty" },
  "Food & Beverage": { label: "Food & Beverage", categoryCode: "food" },
  "Fitness & Sports": { label: "Fitness & Sports", categoryCode: "health_fitness" },
  "Home & Garden": { label: "Home & Garden", categoryCode: "home" },
  "Technology": { label: "Technology", categoryCode: "professional" },
  "Travel & Adventure": { label: "Travel & Adventure", categoryCode: "other" },
  "Art & Culture": { label: "Art & Culture", categoryCode: "art" },
  "Health & Medical": { label: "Health & Medical", categoryCode: "health_fitness" },
  "Finance": { label: "Finance", categoryCode: "professional" },
  "Education": { label: "Education", categoryCode: "professional" },
  "Entertainment": { label: "Entertainment", categoryCode: "events" },
  "Automotive": { label: "Automotive", categoryCode: "auto" },
  "Pets": { label: "Pets", categoryCode: "pets" },
  "Sustainability": { label: "Sustainability", categoryCode: "other" },
  "Other": { label: "Other", categoryCode: "other" },
};

/** "What matters most" answers (app ids). Labels are generic so they read well in any industry. */
export const VALUE_LABELS: Record<string, string> = {
  quality: "Quality", style: "Style & trends", price: "Fair price", service: "Customer service",
  unique: "Uniqueness", sustainable: "Sustainability", ingredients: "Ingredients", brand: "Brand reputation",
  results: "Results", "cruelty-free": "Cruelty free", skill: "Skill", hospitality: "Hospitality",
  cleanliness: "Cleanliness", convenience: "Convenience", trendy: "Trendy styles", taste: "Taste & flavor",
  presentation: "Presentation", ambiance: "Ambiance", value: "Value for money", speed: "Speed",
  authenticity: "Authenticity", expertise: "Expertise", equipment: "Equipment quality", atmosphere: "Atmosphere",
  community: "Community", design: "Design", handmade: "Handmade", function: "Practical",
  creativity: "Creativity", story: "Story & meaning", local: "Local creators", affordable: "Affordable",
  interactive: "Classes & workshops", reliability: "Reliability", communication: "Communication", trust: "Trust",
};

/** Readable name for one saved industry value: shared list label, older list label, or as typed. */
export function interestIndustryLabel(value: string): string {
  return getCategory(value)?.label ?? LEGACY_INDUSTRIES[value]?.label ?? value;
}

/** Nearest shared business industry code for a saved value (null when unknown). */
export function interestCategoryCode(value: string): string | null {
  if (getCategory(value)) return value;
  return LEGACY_INDUSTRIES[value]?.categoryCode ?? null;
}

export function interestSpecialtyLabel(value: string): string {
  return getSpecialty(value)?.label ?? value;
}

export function interestValueLabel(value: string): string {
  return VALUE_LABELS[value] ?? value;
}

export interface InterestGroup {
  /** The saved key (industry value) and its readable name. */
  industry: string;
  industryLabel: string;
  items: string[];
}

export interface DescribedInterests {
  industries: { value: string; label: string; categoryCode: string | null; categoryLabel: string | null }[];
  niches: InterestGroup[];
  values: InterestGroup[];
}

function groups(map: unknown, itemLabel: (v: string) => string): InterestGroup[] {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>)
    .map(([industry, raw]) => ({
      industry,
      industryLabel: interestIndustryLabel(industry),
      items: (Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === "string" && !!v.trim()).map(itemLabel),
    }))
    .filter((g) => g.items.length > 0);
}

/** Every saved interest answer, readable. Unknown values are shown as typed. */
export function describeCustomerInterests(u: {
  selectedIndustries?: unknown;
  industryNiches?: unknown;
  industryValues?: unknown;
}): DescribedInterests {
  const list = Array.isArray(u.selectedIndustries) ? u.selectedIndustries : [];
  const industries = list
    .filter((v): v is string => typeof v === "string" && !!v.trim())
    .map((value) => {
      const categoryCode = interestCategoryCode(value);
      return { value, label: interestIndustryLabel(value), categoryCode, categoryLabel: categoryCode ? getCategory(categoryCode)?.label ?? null : null };
    });
  return {
    industries,
    niches: groups(u.industryNiches, interestSpecialtyLabel),
    values: groups(u.industryValues, interestValueLabel),
  };
}
