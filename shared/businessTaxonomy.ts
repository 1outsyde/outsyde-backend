/**
 * Shared business industry list (approved by Legend 2026-10-17).
 *
 * ONE source for the app, goutsyde.com and the backend:
 *   GET /api/taxonomy/business-categories serves this list; signup validates against it.
 *
 * Codes are stored in the database (businesses.category_code, businesses.specialties) and
 * MUST NEVER be renamed or reused: future consumer recommendations match on them. Labels
 * may change freely. To retire an option, set `retired: true` (kept so old rows still read).
 *
 * Specialty code format: `<category>.<service|product>.<slug>`. Every category has an
 * `other` category option and `.service.other` / `.product.other` specialties; when an
 * "other" code is chosen the business describes itself in businesses.other_description.
 */

export type SpecialtyKind = "service" | "product";

export interface TaxonomySpecialty {
  code: string;
  label: string;
  kind: SpecialtyKind;
  retired?: boolean;
}

export interface TaxonomyCategory {
  code: string;
  label: string;
  specialties: TaxonomySpecialty[];
  retired?: boolean;
}

export const TAXONOMY_VERSION = 1;
export const MAX_SPECIALTIES = 3;
export const OTHER_DESCRIPTION_MAX = 500;

type Def = [code: string, label: string, services: [string, string][], products: [string, string][]];

const DEFS: Def[] = [
  ["beauty", "Beauty & Personal Care",
    [["hair_styling", "Hair styling"], ["braids_locs", "Braids & locs"], ["barber", "Barber"], ["nails", "Nails"],
     ["lashes_brows", "Lashes & brows"], ["makeup", "Makeup"], ["skincare_facials", "Skincare & facials"],
     ["waxing", "Waxing"], ["spa_massage", "Spa & massage"]],
    [["hair_wigs_extensions", "Hair, wigs & extensions"], ["hair_care", "Hair care"], ["skincare", "Skincare"],
     ["makeup", "Makeup"], ["nail_products", "Nail products"], ["lash_products", "Lash products"],
     ["fragrance", "Fragrance"], ["body_care", "Body care"]]],
  ["fashion", "Fashion & Accessories",
    [["tailoring", "Tailoring & alterations"], ["custom_design", "Custom design"], ["personal_styling", "Personal styling"]],
    [["clothing", "Clothing"], ["streetwear", "Streetwear"], ["shoes", "Shoes"], ["jewelry", "Jewelry"],
     ["bags_accessories", "Bags & accessories"]]],
  ["food", "Food & Drink",
    [["catering", "Catering"], ["private_chef", "Private chef"], ["meal_prep", "Meal prep"],
     ["food_truck", "Food truck"], ["restaurant", "Restaurant"]],
    [["cakes_sweets", "Cakes & sweets"], ["baked_goods", "Baked goods"], ["sauces_packaged", "Sauces & packaged food"],
     ["drinks", "Drinks"], ["teas_herbal", "Teas & herbal blends"]]],
  ["health_fitness", "Health & Fitness",
    [["personal_training", "Personal training"], ["yoga_pilates", "Yoga & Pilates"], ["group_classes", "Group classes"],
     ["nutrition_coaching", "Nutrition coaching"], ["wellness_coaching", "Wellness coaching"]],
    [["supplements", "Supplements"], ["herbal_natural", "Herbal & natural products"], ["fitness_gear", "Fitness gear"],
     ["activewear", "Activewear"]]],
  ["home", "Home & Living",
    [["cleaning", "Cleaning"], ["handyman", "Handyman & repairs"], ["landscaping", "Landscaping"], ["moving", "Moving"],
     ["property_services", "Property services"], ["interior_design", "Interior design"]],
    [["home_decor", "Home decor"], ["candles_scents", "Candles & scents"], ["furniture", "Furniture"], ["plants", "Plants"]]],
  ["auto", "Auto",
    [["detailing", "Detailing"], ["repair", "Repair"], ["tint_wraps", "Tint & wraps"]],
    [["parts_accessories", "Parts & accessories"]]],
  ["events", "Events & Entertainment",
    [["event_planning", "Event planning"], ["dj_music", "DJ & music"], ["decor_balloons", "Decor & balloons"],
     ["party_rentals", "Party rentals"], ["venue", "Venue"]],
    [["party_supplies", "Party supplies"]]],
  ["art", "Art & Creative",
    [["photo_video", "Photography & video"], ["graphic_design", "Graphic design"], ["custom_art", "Custom art"],
     ["tattoo", "Tattoo"]],
    [["paintings_prints", "Paintings & prints"], ["handmade_crafts", "Handmade crafts"], ["pottery", "Pottery"]]],
  ["professional", "Professional Services",
    [["consulting", "Consulting"], ["accounting_tax", "Accounting & tax"], ["legal", "Legal"], ["real_estate", "Real estate"],
     ["marketing_social", "Marketing & social media"], ["tech_support", "Tech support"], ["tutoring", "Tutoring"]],
    [["digital_courses", "Digital products & courses"]]],
  ["pets", "Pets",
    [["grooming", "Grooming"], ["walking_sitting", "Walking & sitting"], ["training", "Training"]],
    [["food_treats", "Pet food & treats"], ["supplies", "Pet supplies"]]],
];

function build(): TaxonomyCategory[] {
  const cats: TaxonomyCategory[] = DEFS.map(([code, label, services, products]) => ({
    code,
    label,
    specialties: [
      ...services.map(([slug, l]) => ({ code: `${code}.service.${slug}`, label: l, kind: "service" as const })),
      { code: `${code}.service.other`, label: "Other service", kind: "service" as const },
      ...products.map(([slug, l]) => ({ code: `${code}.product.${slug}`, label: l, kind: "product" as const })),
      { code: `${code}.product.other`, label: "Other product", kind: "product" as const },
    ],
  }));
  cats.push({
    code: "other",
    label: "Other",
    specialties: [
      { code: "other.service.other", label: "Other service", kind: "service" },
      { code: "other.product.other", label: "Other product", kind: "product" },
    ],
  });
  return cats;
}

export const BUSINESS_CATEGORIES: TaxonomyCategory[] = build();

const CATEGORY_BY_CODE = new Map(BUSINESS_CATEGORIES.map((c) => [c.code, c]));
const SPECIALTY_BY_CODE = new Map(
  BUSINESS_CATEGORIES.flatMap((c) => c.specialties.map((s) => [s.code, { ...s, categoryCode: c.code }] as const)),
);

export function getCategory(code: string | null | undefined): TaxonomyCategory | undefined {
  return code ? CATEGORY_BY_CODE.get(code) : undefined;
}

export function getSpecialty(code: string | null | undefined) {
  return code ? SPECIALTY_BY_CODE.get(code) : undefined;
}

export function isOtherCode(code: string): boolean {
  return code === "other" || code.endsWith(".other");
}

export type OfferType = "products" | "services" | "both";

/**
 * Validates a category + specialties selection. Returns a list of problems (empty = valid).
 * Specialties must belong to the category and match the offer type
 * (services → service specialties, products → product specialties, both → either).
 */
export function validateIndustrySelection(input: {
  categoryCode: string;
  specialties: string[];
  offerType: OfferType;
  otherDescription?: string | null;
}): string[] {
  const problems: string[] = [];
  const cat = getCategory(input.categoryCode);
  if (!cat || cat.retired) {
    problems.push(`Unknown category "${input.categoryCode}"`);
    return problems;
  }
  const unique = Array.from(new Set(input.specialties));
  if (unique.length === 0 && cat.code !== "other") problems.push("Choose at least one thing you do");
  if (unique.length !== input.specialties.length) problems.push("Specialties contain duplicates");
  if (unique.length > MAX_SPECIALTIES) problems.push(`Choose up to ${MAX_SPECIALTIES} specialties`);
  for (const code of unique) {
    const s = getSpecialty(code);
    if (!s || s.retired) { problems.push(`Unknown specialty "${code}"`); continue; }
    if (s.categoryCode !== cat.code) problems.push(`Specialty "${code}" is not part of ${cat.label}`);
    if (input.offerType === "services" && s.kind !== "service") problems.push(`Specialty "${code}" is a product, but the business offers services only`);
    if (input.offerType === "products" && s.kind !== "product") problems.push(`Specialty "${code}" is a service, but the business offers products only`);
  }
  const needsDescription = isOtherCode(cat.code) || unique.some(isOtherCode);
  const desc = (input.otherDescription ?? "").trim();
  if (needsDescription && !desc) problems.push("Describe your business when choosing Other");
  if (desc.length > OTHER_DESCRIPTION_MAX) problems.push(`Description must be ${OTHER_DESCRIPTION_MAX} characters or less`);
  return problems;
}

/** Readable labels for a stored selection (unknown codes are shown raw, never dropped). */
export function describeIndustry(categoryCode: string | null | undefined, specialties: string[] | null | undefined) {
  const cat = getCategory(categoryCode);
  return {
    categoryLabel: cat?.label ?? categoryCode ?? null,
    specialties: (specialties ?? []).map((code) => {
      const s = getSpecialty(code);
      return { code, label: s?.label ?? code, kind: (s?.kind ?? null) as SpecialtyKind | null };
    }),
  };
}
