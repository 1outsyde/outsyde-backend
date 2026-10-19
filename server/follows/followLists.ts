/**
 * Followers / Following list rows (GET /api/users/:id/followers|following and /api/users/me/...).
 *
 * Each row shows the account the way the rest of Outsyde shows it (publicIdentity.ts):
 * business name + logo for business owners, photographer name + logo for photographers,
 * display name (or @username) + photo for everyone else. Never email, phone or real names.
 *
 * Rows are hidden when the account is banned or deleted, or when the viewer and that account
 * have blocked each other (either way). isFollowing says whether the viewer follows that row.
 */
import type { User } from "@shared/schema";
import { resolvePublicIdentities, type PublicIdentityKind } from "../publicIdentity";

export interface FollowRow {
  userId: string;
  username: string | null;
  displayName: string;
  profilePhotoUrl: string | null;
  role: PublicIdentityKind;
  businessId: string | null;
  photographerId: string | null;
  /** Viewer follows this account (false when logged out or for the viewer's own row). */
  isFollowing: boolean;
  /** This row is the viewer (the app hides the Follow button). */
  isSelf: boolean;
}

export const FOLLOW_LIST_MAX_LIMIT = 100;

/** limit 1..100 (default 50), offset >= 0. Junk input falls back to the defaults. */
export function parseFollowPaging(query: Record<string, unknown>): { limit: number; offset: number } {
  const rawLimit = parseInt(String(query.limit ?? ""), 10);
  const rawOffset = parseInt(String(query.offset ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, FOLLOW_LIST_MAX_LIMIT) : 50;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

/** Pure: is this account visible in lists at all (not banned, not deleted / being deleted). */
export function isListableUser(u: Pick<User, "isActive" | "deletionStatus">): boolean {
  return u.isActive !== false && (u.deletionStatus ?? "active") === "active";
}

/**
 * Batched (no N+1): 1 query for blocks, 1 for the viewer's follows, 2 for identities.
 * Keeps the input order (newest follow first).
 */
export async function buildFollowRows(users: User[], viewerId: string | null): Promise<FollowRow[]> {
  const listable = users.filter(isListableUser);
  if (listable.length === 0) return [];

  const { db } = await import("../db");
  const { follows, userBlocks } = await import("@shared/schema");
  const { and, eq, inArray, or } = await import("drizzle-orm");
  const ids = listable.map((u) => u.id);

  let hidden = new Set<string>();
  let followedByViewer = new Set<string>();
  if (viewerId) {
    const blocks = await db
      .select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId })
      .from(userBlocks)
      .where(or(
        and(eq(userBlocks.blockerId, viewerId), inArray(userBlocks.blockedId, ids)),
        and(eq(userBlocks.blockedId, viewerId), inArray(userBlocks.blockerId, ids)),
      ));
    hidden = new Set(blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId)));

    const mine = await db
      .select({ targetUserId: follows.targetUserId })
      .from(follows)
      .where(and(eq(follows.followerUserId, viewerId), inArray(follows.targetUserId, ids)));
    followedByViewer = new Set(mine.map((f) => f.targetUserId));
  }

  const visible = listable.filter((u) => !hidden.has(u.id));
  const identities = await resolvePublicIdentities(visible);

  return visible.map((u) => {
    const id = identities.get(u.id);
    return {
      userId: u.id,
      username: u.username || null,
      displayName: id?.publicName || "Outsyde member",
      profilePhotoUrl: id?.avatarUrl ?? null,
      role: id?.kind ?? "consumer",
      businessId: id?.businessId ?? null,
      photographerId: id?.photographerId ?? null,
      isFollowing: viewerId ? followedByViewer.has(u.id) : false,
      isSelf: viewerId === u.id,
    };
  });
}
