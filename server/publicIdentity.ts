/**
 * Public identity for a user: the name and picture other people should see.
 *
 * Same rule as the Home feed author (GET /api/feed, routes.ts "authorProName" / "authorLogoImage"):
 *   - business owner  -> business name (trimmed) + business logo, else the user's photo
 *   - photographer    -> photographer display name (trimmed) + photographer logo, else the user's photo
 *   - everyone else   -> users.name (display name), then @username
 *
 * Used by messaging (conversation list, new conversation, websocket sender, push titles).
 * The feed keeps its own inline copy on purpose so this change cannot alter feed output.
 * Never returns email, phone, first name or last name.
 */
import type { User, Business, Photographer } from "@shared/schema";

export type PublicIdentityKind = "business" | "photographer" | "consumer";

export interface PublicIdentity {
  publicName: string;
  avatarUrl: string | null;
  kind: PublicIdentityKind;
  businessId: string | null;
  photographerId: string | null;
}

type UserLike = Pick<User, "id" | "name" | "firstName" | "username" | "profileImageUrl" | "isVendor" | "isPhotographer">;
type BusinessLike = Pick<Business, "id" | "name" | "logoImage">;
type PhotographerLike = Pick<Photographer, "id" | "displayName" | "logoImage">;

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
};

function personalName(user: UserLike): string {
  // Display name only (users.name). Never the real first/last name (personName.ts).
  const name = clean(user.name);
  if (name) return name;
  const username = clean(user.username);
  return username ? `@${username}` : "Outsyde member";
}

/** Pure: picks the identity from rows already loaded. */
export function pickPublicIdentity(
  user: UserLike,
  business?: BusinessLike | null,
  photographer?: PhotographerLike | null,
): PublicIdentity {
  const userPhoto = clean(user.profileImageUrl);

  if (user.isPhotographer && photographer) {
    return {
      publicName: clean(photographer.displayName) || personalName(user),
      avatarUrl: clean(photographer.logoImage) || userPhoto,
      kind: "photographer",
      businessId: null,
      photographerId: photographer.id,
    };
  }

  if (business) {
    return {
      publicName: clean(business.name) || personalName(user),
      avatarUrl: clean(business.logoImage) || userPhoto,
      kind: "business",
      businessId: business.id,
      photographerId: null,
    };
  }

  return {
    publicName: personalName(user),
    avatarUrl: userPhoto,
    kind: user.isPhotographer ? "photographer" : user.isVendor ? "business" : "consumer",
    businessId: null,
    photographerId: null,
  };
}

/**
 * Batched: two queries total (businesses by owner, photographers by user), no N+1.
 * Returns a Map keyed by user id. db is imported lazily so pickPublicIdentity stays DB-free.
 */
export async function resolvePublicIdentities(users: UserLike[]): Promise<Map<string, PublicIdentity>> {
  const out = new Map<string, PublicIdentity>();
  const ids = Array.from(new Set(users.map((u) => u.id).filter(Boolean)));
  if (ids.length === 0) return out;

  const { db } = await import("./db");
  const { businesses, photographers } = await import("@shared/schema");
  const { inArray, asc } = await import("drizzle-orm");

  const bizRows = await db
    .select({ id: businesses.id, ownerId: businesses.ownerId, name: businesses.name, logoImage: businesses.logoImage })
    .from(businesses)
    .where(inArray(businesses.ownerId, ids))
    .orderBy(asc(businesses.createdAt));
  const photoIds = users.filter((u) => u.isPhotographer).map((u) => u.id);
  const photoRows = photoIds.length
    ? await db
        .select({ id: photographers.id, userId: photographers.userId, displayName: photographers.displayName, logoImage: photographers.logoImage })
        .from(photographers)
        .where(inArray(photographers.userId, photoIds))
    : [];

  // First business per owner (oldest), matching getBusinessByOwnerId's single-row use.
  const bizByOwner = new Map<string, BusinessLike>();
  for (const b of bizRows) if (b.ownerId && !bizByOwner.has(b.ownerId)) bizByOwner.set(b.ownerId, b);
  const photoByUser = new Map<string, PhotographerLike>();
  for (const p of photoRows) if (p.userId && !photoByUser.has(p.userId)) photoByUser.set(p.userId, p);

  for (const u of users) {
    out.set(u.id, pickPublicIdentity(u, bizByOwner.get(u.id), photoByUser.get(u.id)));
  }
  return out;
}

export async function resolvePublicIdentity(user: UserLike): Promise<PublicIdentity> {
  const map = await resolvePublicIdentities([user]);
  return map.get(user.id) ?? pickPublicIdentity(user);
}
