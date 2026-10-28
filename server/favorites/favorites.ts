/**
 * Saved businesses, photographers and products (Manage Business step 6, migration 077).
 * Pure checks for the routes in favoritesRoutes.ts.
 *
 *   npx tsx server/favorites/favorites.test.ts
 */
export const FAVORITE_TYPES = ["business", "photographer", "product"] as const;
export type FavoriteType = (typeof FAVORITE_TYPES)[number];

export const MAX_IMPORT_ITEMS = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,36}$/;

export const isFavoriteType = (v: unknown): v is FavoriteType =>
  typeof v === "string" && (FAVORITE_TYPES as readonly string[]).includes(v);

export function parseTarget(type: unknown, id: unknown): { type: FavoriteType; id: string } | null {
  if (!isFavoriteType(type)) return null;
  const s = typeof id === "number" ? String(id) : id;
  if (typeof s !== "string" || !ID_RE.test(s)) return null;
  return { type, id: s };
}

export interface ImportItem {
  type: FavoriteType;
  id: string;
  savedAt: Date | null;
}

/**
 * The phone's old Favorites list → rows to import. Bad entries and repeats are dropped, never an error:
 * the list was written by older app builds. savedAt is kept when it is a real past date.
 */
export function parseImportItems(body: unknown, now: Date = new Date()): ImportItem[] | null {
  const items = (body as any)?.items;
  if (!Array.isArray(items)) return null;
  const out: ImportItem[] = [];
  const seen = new Set<string>();
  for (const raw of items.slice(0, MAX_IMPORT_ITEMS)) {
    const t = parseTarget(raw?.type, raw?.id);
    if (!t) continue;
    const key = `${t.type}:${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let savedAt: Date | null = null;
    if (typeof raw?.savedAt === "string") {
      const d = new Date(raw.savedAt);
      if (!Number.isNaN(d.getTime()) && d.getTime() <= now.getTime() && d.getFullYear() >= 2020) savedAt = d;
    }
    out.push({ ...t, savedAt });
  }
  return out;
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
export const placeLine = (city?: string | null, state?: string | null): string =>
  [city, state].map(nonEmpty).filter(Boolean).join(", ");

/** First usable picture of a product. */
export function productImage(imageUrl?: string | null, images?: unknown): string | null {
  if (nonEmpty(imageUrl)) return imageUrl!;
  if (Array.isArray(images)) for (const i of images) if (nonEmpty(i)) return i as string;
  return null;
}
