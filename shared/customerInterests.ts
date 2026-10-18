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
import { BUSINESS_CATEGORIES, getCategory, getSpecialty } from "./businessTaxonomy";

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

/* =====================================================================================
 * Shared list for the customer picker (Legend 2026-10-18): industries from the business
 * list, then what they're into (that industry's service and product specialties), then
 * what matters most. Codes never change (same rules as shared/businessTaxonomy.ts).
 * ===================================================================================== */
export const CUSTOMER_INTERESTS_VERSION = 1;
export const INTEREST_OTHER_MAX = 500;

/** "What matters most" choices per industry (ids from VALUE_LABELS). */
export const CUSTOMER_VALUE_OPTIONS: Record<string, string[]> = {
  beauty: ["skill", "hospitality", "cleanliness", "price", "convenience", "trendy", "quality", "ingredients", "results", "cruelty-free"],
  fashion: ["quality", "style", "price", "service", "unique", "sustainable"],
  food: ["taste", "presentation", "service", "hospitality", "ambiance", "value", "speed", "authenticity"],
  health_fitness: ["expertise", "equipment", "atmosphere", "community", "cleanliness", "results"],
  home: ["quality", "design", "price", "unique", "handmade", "function", "reliability"],
  auto: ["reliability", "expertise", "price", "communication", "trust", "convenience"],
  events: ["creativity", "reliability", "communication", "price", "unique", "atmosphere"],
  art: ["creativity", "skill", "story", "local", "affordable", "interactive"],
  professional: ["reliability", "expertise", "communication", "price", "trust", "convenience"],
  pets: ["trust", "expertise", "cleanliness", "convenience", "price", "communication"],
  other: ["quality", "price", "service", "convenience", "unique", "local"],
};

/** Public list for both signups (GET /api/taxonomy/customer-interests). "Other" specialties are left out: Other is picked as an industry with a text box. */
export function customerInterestTaxonomy() {
  return {
    version: CUSTOMER_INTERESTS_VERSION,
    otherMax: INTEREST_OTHER_MAX,
    categories: BUSINESS_CATEGORIES.filter((c) => !c.retired).map((c) => ({
      code: c.code,
      label: c.label,
      specialties: c.specialties
        .filter((s) => !s.retired && !s.code.endsWith(".other"))
        .map((s) => ({ code: s.code, label: s.label, kind: s.kind })),
      values: (CUSTOMER_VALUE_OPTIONS[c.code] ?? []).map((id) => ({ id, label: VALUE_LABELS[id] ?? id })),
    })),
  };
}

const B = (cat: string, kind: "service" | "product", slug: string) => `${cat}.${kind}.${slug}`;

/** Older app niche names → shared specialty codes (any industry; its industry is added). Keyed by the older industry. */
export const LEGACY_NICHES: Record<string, Record<string, string[]>> = {
  "clothing": {
    "Streetwear": [B("fashion", "product", "streetwear")],
    "Vintage": [B("fashion", "product", "clothing")], "Designer": [B("fashion", "product", "clothing")],
    "Casual": [B("fashion", "product", "clothing")], "Athletic Wear": [B("health_fitness", "product", "activewear")],
    "Formal Wear": [B("fashion", "product", "clothing")], "Children's Clothing": [B("fashion", "product", "clothing")],
    "Plus Size": [B("fashion", "product", "clothing")], "Sustainable Fashion": [B("fashion", "product", "clothing")],
    "Accessories & Jewelry": [B("fashion", "product", "jewelry"), B("fashion", "product", "bags_accessories")],
    "Shoes & Footwear": [B("fashion", "product", "shoes")],
    "Custom/Tailored": [B("fashion", "service", "custom_design"), B("fashion", "service", "tailoring")],
  },
  "beauty-products": {
    "Skincare": [B("beauty", "product", "skincare")], "Anti-aging": [B("beauty", "product", "skincare")],
    "Acne Care": [B("beauty", "product", "skincare")], "K-Beauty": [B("beauty", "product", "skincare")],
    "Makeup": [B("beauty", "product", "makeup")], "Haircare": [B("beauty", "product", "hair_care")],
    "Men's Grooming": [B("beauty", "product", "hair_care")], "Fragrances": [B("beauty", "product", "fragrance")],
    "Nail Products": [B("beauty", "product", "nail_products")], "Body Care": [B("beauty", "product", "body_care")],
  },
  "beauty-services": {
    "Hair Styling": [B("beauty", "service", "hair_styling")], "Hair Coloring": [B("beauty", "service", "hair_styling")],
    "Barbershop": [B("beauty", "service", "barber")], "Nail Salon": [B("beauty", "service", "nails")],
    "Spa & Massage": [B("beauty", "service", "spa_massage")], "Facials": [B("beauty", "service", "skincare_facials")],
    "Med Spa": [B("beauty", "service", "skincare_facials")], "Waxing": [B("beauty", "service", "waxing")],
    "Lash Extensions": [B("beauty", "service", "lashes_brows")], "Brow Services": [B("beauty", "service", "lashes_brows")],
    "Makeup Artist": [B("beauty", "service", "makeup")], "Braiding & Locs": [B("beauty", "service", "braids_locs")],
  },
  "food": {
    "Bakery & Sweets": [B("food", "product", "cakes_sweets"), B("food", "product", "baked_goods")],
    "Desserts": [B("food", "product", "cakes_sweets")], "Coffee & Cafe": [B("food", "product", "drinks")],
    "Food Trucks": [B("food", "service", "food_truck")],
    ...Object.fromEntries(["Italian", "Soul Food", "Mexican", "Asian Fusion", "Caribbean", "BBQ", "Vegan/Vegetarian",
      "Seafood", "Fine Dining", "Fast Casual", "Healthy/Organic"].map((n) => [n, [B("food", "service", "restaurant")]])),
  },
  "fitness": {
    "Yoga": [B("health_fitness", "service", "yoga_pilates")], "Pilates": [B("health_fitness", "service", "yoga_pilates")],
    "Personal Training": [B("health_fitness", "service", "personal_training")],
    ...Object.fromEntries(["CrossFit", "Boxing/MMA", "Dance Fitness", "Swimming", "Cycling/Spin", "Group Classes"]
      .map((n) => [n, [B("health_fitness", "service", "group_classes")]])),
    "Meditation": [B("health_fitness", "service", "wellness_coaching")], "Physical Therapy": [B("health_fitness", "service", "wellness_coaching")],
    "Nutrition Coaching": [B("health_fitness", "service", "nutrition_coaching")],
  },
  "home-goods": {
    "Furniture": [B("home", "product", "furniture")], "Antiques": [B("home", "product", "furniture")],
    ...Object.fromEntries(["Home Decor", "Kitchenware", "Bedding & Linens", "Organization"].map((n) => [n, [B("home", "product", "home_decor")]])),
    "Wall Art": [B("art", "product", "paintings_prints")], "Handmade Items": [B("art", "product", "handmade_crafts")],
    "Plants & Garden": [B("home", "product", "plants")], "Outdoor Living": [B("home", "product", "plants")],
    "Candles & Scents": [B("home", "product", "candles_scents")], "Pet Supplies": [B("pets", "product", "supplies")],
  },
  "arts": {
    "Paintings": [B("art", "product", "paintings_prints")], "Supplies": [B("art", "product", "paintings_prints")],
    "Photography": [B("art", "service", "photo_video")], "Pottery & Ceramics": [B("art", "product", "pottery")],
    ...Object.fromEntries(["Jewelry Making", "Handmade Crafts", "Textiles", "Woodworking", "Sculpture"].map((n) => [n, [B("art", "product", "handmade_crafts")]])),
    "Digital Art": [B("art", "service", "graphic_design")], "Custom Commissions": [B("art", "service", "custom_art")],
  },
  "services": {
    "Cleaning": [B("home", "service", "cleaning")], "Landscaping": [B("home", "service", "landscaping")],
    "Handyman": [B("home", "service", "handyman")], "Auto Repair": [B("auto", "service", "repair")],
    "Pet Services": [B("pets", "service", "grooming"), B("pets", "service", "walking_sitting")],
    "Photography": [B("art", "service", "photo_video")], "Event Planning": [B("events", "service", "event_planning")],
    "Tutoring": [B("professional", "service", "tutoring")], "Legal Services": [B("professional", "service", "legal")],
    "Accounting": [B("professional", "service", "accounting_tax")], "Real Estate": [B("professional", "service", "real_estate")],
    "Tech Support": [B("professional", "service", "tech_support")],
  },
};

export interface CustomerInterestsInput {
  selectedIndustries?: unknown;
  industryNiches?: unknown;
  industryValues?: unknown;
  interestOther?: unknown;
}

export interface NormalizedCustomerInterests {
  selectedIndustries: string[];
  industryNiches: Record<string, string[]>;
  industryValues: Record<string, string[]>;
  interestOther: string | null;
  /** The answers exactly as sent, kept only when something had to be mapped or was dropped. */
  original: { selectedIndustries: unknown; industryNiches: unknown; industryValues: unknown } | null;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
const strMap = (v: unknown): Record<string, string[]> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, strList(x)]))
    : {};

function niche(industryKey: string, value: string): string[] {
  const s = getSpecialty(value);
  if (s && !s.retired) return [value];
  return LEGACY_NICHES[industryKey]?.[value] ?? [];
}

/**
 * Turns any interests payload (new codes, older app codes or names, goutsyde.com names) into
 * shared codes. Never throws and never rejects: unknown words are kept in `original` only.
 */
export function normalizeCustomerInterests(input: CustomerInterestsInput): NormalizedCustomerInterests {
  const rawIndustries = strList(input.selectedIndustries);
  const rawNiches = strMap(input.industryNiches);
  const rawValues = strMap(input.industryValues);
  let changed = false;

  const industries: string[] = [];
  const add = (code: string) => { if (!industries.includes(code)) industries.push(code); };
  for (const v of rawIndustries) {
    const code = interestCategoryCode(v);
    if (code && !getCategory(code)?.retired) { add(code); if (code !== v) changed = true; } else changed = true;
  }

  const niches: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(rawNiches)) {
    const keyCode = interestCategoryCode(key);
    if (keyCode !== key) changed = true;
    for (const v of list) {
      const codes = niche(key, v);
      if (!codes.length || codes[0] !== v) changed = true;
      for (const c of codes) {
        const cat = getSpecialty(c)!.categoryCode;
        // A specialty only counts when its industry was picked, except older answers that map elsewhere.
        if (keyCode && cat !== keyCode && getCategory(key)) { changed = true; continue; }
        add(cat);
        niches[cat] = niches[cat] ?? [];
        if (!niches[cat].includes(c)) niches[cat].push(c);
      }
    }
  }

  const values: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(rawValues)) {
    const keyCode = interestCategoryCode(key);
    if (keyCode !== key) changed = true;
    if (!keyCode || !industries.includes(keyCode)) { changed = changed || list.length > 0; continue; }
    for (const v of list) {
      if (!VALUE_LABELS[v]) { changed = true; continue; }
      values[keyCode] = values[keyCode] ?? [];
      if (!values[keyCode].includes(v)) values[keyCode].push(v);
    }
  }

  const otherText = typeof input.interestOther === "string" ? input.interestOther.trim().slice(0, INTEREST_OTHER_MAX) : "";
  return {
    selectedIndustries: industries,
    industryNiches: niches,
    industryValues: values,
    interestOther: otherText || null,
    original: changed
      ? { selectedIndustries: input.selectedIndustries ?? [], industryNiches: input.industryNiches ?? {}, industryValues: input.industryValues ?? {} }
      : null,
  };
}

/**
 * Matching helpers for ranking (businesses that match a customer's interests first).
 * Work for both shared codes and older words.
 */
export function interestMatchProfile(u: { selectedIndustries?: unknown; industryNiches?: unknown }) {
  const n = normalizeCustomerInterests({ selectedIndustries: u.selectedIndustries, industryNiches: u.industryNiches });
  const categoryCodes = n.selectedIndustries;
  const specialtyCodes = Object.values(n.industryNiches).flat();
  return {
    categoryCodes,
    specialtyCodes,
    /** Lowercase readable industry names (shared labels) plus the older words, for text matching. */
    industryTerms: Array.from(new Set([
      ...categoryCodes.filter((c) => c !== "other").map((c) => getCategory(c)!.label.toLowerCase()),
      ...strList(u.selectedIndustries).filter((v) => !getCategory(v) && interestCategoryCode(v) !== "other").map((v) => interestIndustryLabel(v).toLowerCase()),
    ])),
    nicheTerms: Array.from(new Set([
      ...specialtyCodes.map((c) => getSpecialty(c)!.label.toLowerCase()),
      ...Object.values(strMap(u.industryNiches)).flat().filter((v) => !getSpecialty(v)).map((v) => v.toLowerCase()),
    ])),
  };
}

/**
 * Update fields for routes that change interests after signup. Only the keys that were sent
 * are returned (same as before), each on shared codes; the sent words are kept when mapped.
 */
export function interestUpdateFields(input: CustomerInterestsInput): Record<string, unknown> {
  const n = normalizeCustomerInterests(input);
  const out: Record<string, unknown> = {};
  if (input.selectedIndustries !== undefined) out.selectedIndustries = n.selectedIndustries;
  if (input.industryNiches !== undefined) out.industryNiches = n.industryNiches;
  if (input.industryValues !== undefined) out.industryValues = n.industryValues;
  if (input.interestOther !== undefined) out.interestOther = n.interestOther;
  if (n.original && Object.keys(out).length) out.interestsOriginal = n.original;
  return out;
}

/** Readable shared list industry names for a saved list (older words mapped; Other left out). */
export function interestIndustryNames(selectedIndustries: unknown): string[] {
  return interestMatchProfile({ selectedIndustries }).categoryCodes
    .filter((c) => c !== "other")
    .map((c) => getCategory(c)!.label);
}
