/**
 * Influencer application answers (Legend 2026-10-18): every answer is saved and shown to the
 * admin. One place for the rules so the app, goutsyde.com and the backend agree.
 *
 * What they post about uses the shared business industry codes (shared/businessTaxonomy.ts),
 * so influencers can later be matched to businesses and customers.
 */
import { getCategory } from "./businessTaxonomy";

export const MAX_CONTENT_CATEGORIES = 5;
export const CONTENT_OTHER_MAX = 500;
export const WHY_MAX = 2000;
export const HANDLE_MAX = 200;
export const MAX_FOLLOWERS = 1_000_000_000;

export interface InfluencerApplicationInput {
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  twitterUrl: string | null;
  instagramFollowers: number | null;
  tiktokFollowers: number | null;
  youtubeFollowers: number | null;
  twitterFollowers: number | null;
  followerCount: number | null;
  contentCategories: string[];
  contentOther: string | null;
  contentNiche: string | null;
  whyInfluencer: string | null;
}

export type ParseResult = { ok: true; value: InfluencerApplicationInput } | { ok: false; field: string; error: string };

const pick = (b: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (b[k] !== undefined && b[k] !== null && b[k] !== "") return b[k];
  return undefined;
};

function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/** "12,500", 12500, "12.5k" style input → whole number. undefined = not given; NaN = invalid. */
export function parseFollowers(v: unknown): number | null | typeof NaN {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= MAX_FOLLOWERS ? v : NaN;
  if (typeof v !== "string") return NaN;
  const s = v.trim().toLowerCase().replace(/,/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return NaN;
  const n = Math.round(parseFloat(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1));
  return n >= 0 && n <= MAX_FOLLOWERS ? n : NaN;
}

/**
 * Reads an application body from any client (camelCase or snake_case; older app builds send
 * `bio` for the why box). Returns the cleaned answers or the first problem with its field.
 */
export function parseInfluencerApplication(body: Record<string, unknown>): ParseResult {
  const b = body ?? {};
  const handles = {
    instagramUrl: textOrNull(pick(b, "instagramUrl", "instagram_url", "instagram")),
    tiktokUrl: textOrNull(pick(b, "tiktokUrl", "tiktok_url", "tiktok")),
    youtubeUrl: textOrNull(pick(b, "youtubeUrl", "youtube_url", "youtube")),
    twitterUrl: textOrNull(pick(b, "twitterUrl", "twitter_url", "twitter", "x")),
  };
  for (const [k, v] of Object.entries(handles)) {
    if (v && v.length > HANDLE_MAX) return { ok: false, field: k, error: `Keep each handle or link under ${HANDLE_MAX} characters` };
  }
  if (!Object.values(handles).some(Boolean)) {
    return { ok: false, field: "socials", error: "Add at least one social media handle or link" };
  }

  const counts: Record<string, number | null> = {};
  for (const [field, keys] of [
    ["instagramFollowers", ["instagramFollowers", "instagram_followers"]],
    ["tiktokFollowers", ["tiktokFollowers", "tiktok_followers"]],
    ["youtubeFollowers", ["youtubeFollowers", "youtube_followers"]],
    ["twitterFollowers", ["twitterFollowers", "twitter_followers"]],
    ["followerCount", ["followerCount", "follower_count"]],
  ] as const) {
    const n = parseFollowers(pick(b, ...keys));
    if (Number.isNaN(n)) return { ok: false, field, error: "Enter followers as a whole number, for example 12500" };
    counts[field] = n as number | null;
  }
  const perPlatform = [counts.instagramFollowers, counts.tiktokFollowers, counts.youtubeFollowers, counts.twitterFollowers];
  const sum = perPlatform.reduce<number>((t, n) => t + (n ?? 0), 0);
  const followerCount = counts.followerCount ?? (perPlatform.some((n) => n !== null) ? sum : null);

  const rawCats = pick(b, "contentCategories", "content_categories");
  const cats = Array.isArray(rawCats) ? rawCats.filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter(Boolean) : [];
  const unique = Array.from(new Set(cats));
  if (rawCats !== undefined && !Array.isArray(rawCats)) return { ok: false, field: "contentCategories", error: "Pick what you post about from the list" };
  if (unique.length > MAX_CONTENT_CATEGORIES) return { ok: false, field: "contentCategories", error: `Pick up to ${MAX_CONTENT_CATEGORIES} things you post about` };
  for (const c of unique) {
    const cat = getCategory(c);
    if (!cat || cat.retired) return { ok: false, field: "contentCategories", error: `Unknown choice "${c}"` };
  }
  const contentOther = textOrNull(pick(b, "contentOther", "content_other"));
  if (unique.includes("other") && !contentOther) return { ok: false, field: "contentOther", error: "Tell us what you post about when you pick Other" };
  if (contentOther && contentOther.length > CONTENT_OTHER_MAX) return { ok: false, field: "contentOther", error: `Keep it under ${CONTENT_OTHER_MAX} characters` };

  const why = textOrNull(pick(b, "whyInfluencer", "why_influencer", "whyJoin", "bio"));
  if (why && why.length > WHY_MAX) return { ok: false, field: "whyInfluencer", error: `Keep it under ${WHY_MAX} characters` };
  const niche = textOrNull(pick(b, "contentNiche", "content_niche", "niche"));

  return {
    ok: true,
    value: {
      ...handles,
      instagramFollowers: counts.instagramFollowers,
      tiktokFollowers: counts.tiktokFollowers,
      youtubeFollowers: counts.youtubeFollowers,
      twitterFollowers: counts.twitterFollowers,
      followerCount,
      contentCategories: unique,
      contentOther: unique.includes("other") ? contentOther : null,
      contentNiche: niche ? niche.slice(0, CONTENT_OTHER_MAX) : null,
      whyInfluencer: why,
    },
  };
}

/** Readable names for saved content categories (unknown codes shown as saved). */
export function contentCategoryLabels(codes: unknown): string[] {
  return (Array.isArray(codes) ? codes : []).filter((c): c is string => typeof c === "string").map((c) => getCategory(c)?.label ?? c);
}

/**
 * Promo code from the username: letters and digits, upper case, 4 to 12 characters, plus a
 * number when needed. `taken` decides uniqueness (checked against the database by the caller).
 */
export async function makeInfluencerPromoCode(seed: string | null | undefined, taken: (code: string) => Promise<boolean>): Promise<string> {
  let base = (seed ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (base.length < 4) base = (base + "OUTSYDE").slice(0, 8);
  if (!(await taken(base))) return base;
  for (let i = 0; i < 50; i++) {
    const code = `${base.slice(0, 10)}${Math.floor(10 + Math.random() * 90)}`;
    if (!(await taken(code))) return code;
  }
  return `${base.slice(0, 6)}${Date.now().toString(36).toUpperCase().slice(-6)}`;
}
