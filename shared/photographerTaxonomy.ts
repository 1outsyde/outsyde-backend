/**
 * Shared photographer specialty list and signup answer labels (approved by Legend 2026-10-18).
 *
 * ONE source for the app, goutsyde.com and the backend:
 *   GET /api/taxonomy/photographer serves this list; signup and profile saves map onto it.
 *
 * Specialty codes are stored in photographers.specialty_codes and MUST NEVER be renamed or
 * reused: customers will later be matched to photographers on them. Labels may change.
 * To retire an option set `retired: true` (kept so old rows still read).
 *
 * photographers.specialties keeps READABLE NAMES (search, cards and profiles read it). Whenever
 * codes are saved the names are rewritten from them, so the two never disagree.
 */

export interface PhotographerSpecialty {
  code: string;
  label: string;
  /** Older names from the app and website lists that mean this specialty. Matched case and punctuation insensitive. */
  aliases?: string[];
  retired?: boolean;
}

export const PHOTOGRAPHER_TAXONOMY_VERSION = 1;
export const MAX_PHOTOGRAPHER_SPECIALTIES = 5;
export const SPECIALTY_OTHER_MAX = 500;
export const PHOTO_OTHER_CODE = "photo.other";

export const PHOTOGRAPHER_SPECIALTIES: PhotographerSpecialty[] = [
  { code: "photo.weddings", label: "Weddings & engagements", aliases: ["Weddings", "Wedding", "Engagements"] },
  { code: "photo.portraits", label: "Portraits & headshots", aliases: ["Portraits", "Portrait", "Headshots"] },
  { code: "photo.events", label: "Events & parties", aliases: ["Events", "Event", "Parties"] },
  { code: "photo.family_newborn", label: "Family, newborn & maternity", aliases: ["Newborn", "Newborn & Family", "Family", "Maternity"] },
  { code: "photo.fashion", label: "Fashion & editorial", aliases: ["Fashion", "Editorial"] },
  { code: "photo.commercial", label: "Brand, commercial & corporate", aliases: ["Commercial", "Corporate", "Brand"] },
  { code: "photo.product", label: "Product", aliases: ["Products", "Food & Product"] },
  { code: "photo.food", label: "Food & drink", aliases: ["Food"] },
  { code: "photo.real_estate", label: "Real estate & architecture", aliases: ["Real Estate", "real_estate", "Architecture"] },
  { code: "photo.sports", label: "Sports", aliases: ["Sport"] },
  { code: "photo.concerts", label: "Concerts & nightlife", aliases: ["Concert", "Concerts", "Nightlife"] },
  { code: "photo.landscape", label: "Landscape & nature", aliases: ["Landscape", "Nature", "Nature & Landscape"] },
  { code: "photo.wildlife", label: "Wildlife" },
  { code: "photo.street", label: "Street & documentary", aliases: ["Street", "Documentary"] },
  { code: "photo.travel", label: "Travel" },
  { code: "photo.content", label: "Content creation & social media", aliases: ["Content creation", "Social media"] },
  { code: "photo.boudoir", label: "Boudoir" },
  { code: PHOTO_OTHER_CODE, label: "Other", aliases: ["Other"] },
];

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

const BY_CODE = new Map(PHOTOGRAPHER_SPECIALTIES.map((s) => [s.code, s]));
const BY_NAME = new Map<string, PhotographerSpecialty>();
for (const s of PHOTOGRAPHER_SPECIALTIES) {
  for (const name of [s.label, s.code, s.code.replace(/^photo\./, ""), ...(s.aliases ?? [])]) {
    BY_NAME.set(norm(name), s);
  }
}

export function getPhotographerSpecialty(code: string | null | undefined): PhotographerSpecialty | undefined {
  return code ? BY_CODE.get(code) : undefined;
}

/** Maps an older readable name (or a code) to its specialty, if known. */
export function matchPhotographerSpecialty(nameOrCode: string): PhotographerSpecialty | undefined {
  return BY_CODE.get(nameOrCode) ?? BY_NAME.get(norm(nameOrCode));
}

/** Readable names for stored codes; unknown codes are shown as stored, never dropped. */
export function photographerSpecialtyLabels(codes: string[] | null | undefined): string[] {
  return (codes ?? []).map((c) => getPhotographerSpecialty(c)?.label ?? c);
}

/** Checks a list of codes picked on a signup or profile screen. Returns problems (empty = valid). */
export function validatePhotographerSpecialties(codes: string[], other: string | null | undefined): string[] {
  const problems: string[] = [];
  const unique = Array.from(new Set(codes));
  if (unique.length !== codes.length) problems.push("Specialties contain duplicates");
  if (unique.length > MAX_PHOTOGRAPHER_SPECIALTIES) problems.push(`Choose up to ${MAX_PHOTOGRAPHER_SPECIALTIES} specialties`);
  for (const c of unique) {
    const s = getPhotographerSpecialty(c);
    if (!s || s.retired) problems.push(`Unknown specialty "${c}"`);
  }
  const desc = (other ?? "").trim();
  if (unique.includes(PHOTO_OTHER_CODE) && !desc) problems.push("Tell us what you shoot when choosing Other");
  if (desc.length > SPECIALTY_OTHER_MAX) problems.push(`Description must be ${SPECIALTY_OTHER_MAX} characters or less`);
  return problems;
}

/**
 * Older clients send readable names in `specialties`. Known names become codes (in order, no
 * duplicates); unknown names are kept as names so nothing a photographer typed is lost.
 */
export function codesFromNames(names: unknown): { codes: string[]; unknown: string[] } {
  const codes: string[] = [];
  const unknown: string[] = [];
  if (!Array.isArray(names)) return { codes, unknown };
  for (const n of names) {
    if (typeof n !== "string" || !n.trim()) continue;
    const s = matchPhotographerSpecialty(n.trim());
    if (s) { if (!codes.includes(s.code)) codes.push(s.code); }
    else if (!unknown.includes(n.trim())) unknown.push(n.trim());
  }
  return { codes, unknown };
}

// ---- Other signup answers -------------------------------------------------------------------
// The app's values are the shared set. Older website answers ("Hobbyist", "24–48 hours",
// a typed number of miles) are shown as typed.

export type OptionSet = Array<{ value: string; label: string }>;

export const PHOTOGRAPHER_OPTIONS: Record<string, OptionSet> = {
  shootLocation: [
    { value: "on-location", label: "I come to you" },
    { value: "studio", label: "I have a studio" },
    { value: "both", label: "Both" },
  ],
  travelRadius: [
    { value: "city_only", label: "Within my city only" },
    { value: "25_miles", label: "Up to 25 miles" },
    { value: "50_miles", label: "Up to 50 miles" },
    { value: "100_miles", label: "Up to 100 miles" },
    { value: "anywhere", label: "Willing to travel anywhere" },
  ],
  pricingType: [
    { value: "hourly", label: "Hourly rate" },
    { value: "per_session", label: "Per session" },
    { value: "per_project", label: "Per project" },
    { value: "packages", label: "Custom packages" },
    { value: "contact", label: "Contact for pricing" },
  ],
  minimumBooking: [
    { value: "30_min", label: "30 min" },
    { value: "1_hour", label: "1 hour" },
    { value: "2_hours", label: "2 hours" },
    { value: "half_day", label: "Half day" },
    { value: "full_day", label: "Full day" },
  ],
  experienceLevel: [
    { value: "beginner", label: "Just starting out" },
    { value: "1_2_years", label: "1 to 2 years" },
    { value: "3_5_years", label: "3 to 5 years" },
    { value: "5_10_years", label: "5 to 10 years" },
    { value: "10_plus_years", label: "10+ years" },
  ],
  equipmentLevel: [
    { value: "pro_studio", label: "Professional camera and studio lighting" },
    { value: "pro_natural", label: "Professional camera, natural light" },
    { value: "building", label: "Building my kit" },
  ],
  deliveryTime: [
    { value: "same_day", label: "Same day" },
    { value: "24_48_hours", label: "24 to 48 hours" },
    { value: "3_5_days", label: "3 to 5 business days" },
    { value: "1_2_weeks", label: "1 to 2 weeks" },
    { value: "varies", label: "Varies by project" },
  ],
  additionalServices: [
    { value: "Photo editing & retouching", label: "Photo editing & retouching" },
    { value: "Same-day previews", label: "Same day previews" },
    { value: "Prints & albums", label: "Prints & albums" },
    { value: "Videography / Reels", label: "Videography and reels" },
    { value: "Drone photography", label: "Drone photography" },
    { value: "Makeup artist coordination", label: "Makeup artist coordination" },
    { value: "Model sourcing", label: "Model sourcing" },
    { value: "Wardrobe styling assistance", label: "Wardrobe styling assistance" },
    { value: "Rush delivery", label: "Rush delivery" },
  ],
};

/** Readable label for a stored answer; a bare number of miles reads "25 miles"; unknown values as typed. */
export function optionLabel(field: keyof typeof PHOTOGRAPHER_OPTIONS | string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  const found = PHOTOGRAPHER_OPTIONS[field]?.find((o) => o.value === v);
  if (found) return found.label;
  if (field === "travelRadius" && /^\d+$/.test(v)) return `${v} miles`;
  return v;
}

/** A single value or a list from any client becomes a clean list of strings (shoot_location, additional_services are text[]). */
export function toStringList(v: unknown): string[] | null {
  if (v === null || v === undefined || v === "") return null;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  return out.length ? Array.from(new Set(out)) : [];
}

/**
 * One place that turns whatever a client sent into what is stored:
 *   - `specialtyCodes` (new clients): checked strictly; a bad pick is an error.
 *   - otherwise `specialties` names (older clients): known names become codes, unknown names kept.
 * Readable names always follow the codes. `other` is kept only when Other is picked.
 */
export function resolvePhotographerSpecialties(input: {
  specialtyCodes?: unknown;
  specialties?: unknown;
  specialtyOther?: unknown;
}):
  | { codes: string[]; names: string[]; other: string | null }
  | { error: string; details: string[] } {
  if (input.specialtyOther !== undefined && input.specialtyOther !== null && typeof input.specialtyOther !== "string") {
    return { error: "specialtyOther must be text", details: ["specialtyOther must be text"] };
  }
  const otherText = typeof input.specialtyOther === "string" && input.specialtyOther.trim() ? input.specialtyOther.trim() : null;

  if (input.specialtyCodes !== undefined && input.specialtyCodes !== null) {
    if (!Array.isArray(input.specialtyCodes) || !input.specialtyCodes.every((c) => typeof c === "string")) {
      return { error: "specialtyCodes must be a list of codes", details: ["specialtyCodes must be a list of codes"] };
    }
    const codes = input.specialtyCodes as string[];
    const problems = validatePhotographerSpecialties(codes, otherText);
    if (problems.length) return { error: problems[0], details: problems };
    return {
      codes,
      names: photographerSpecialtyLabels(codes),
      other: codes.includes(PHOTO_OTHER_CODE) ? otherText : null,
    };
  }

  const { codes, unknown } = codesFromNames(input.specialties);
  if (otherText && otherText.length > SPECIALTY_OTHER_MAX) {
    return { error: `Description must be ${SPECIALTY_OTHER_MAX} characters or less`, details: [] };
  }
  return {
    codes,
    names: [...photographerSpecialtyLabels(codes), ...unknown],
    other: codes.includes(PHOTO_OTHER_CODE) ? otherText : null,
  };
}
