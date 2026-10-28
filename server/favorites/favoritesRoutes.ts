/**
 * Saved businesses, photographers and products on the account (Manage Business step 6, migration 077).
 * Saved posts stay in user_saved_posts (/api/feed/:postId/save); the app shows both in one Saved place.
 *
 *   GET    /api/users/me/favorites                 everything saved, newest first, with name / picture / line
 *                                                  filled in here. Deleted or hidden targets are left out (the
 *                                                  row stays, so a business that comes back shows again).
 *   POST   /api/favorites                {type,id} save. Same answer when already saved. 404 when the target
 *                                                  does not exist or is not public.
 *   DELETE /api/favorites/:type/:id                remove. Same answer when it was not saved.
 *   POST   /api/users/me/favorites/import {items}  one-time upload of the list older app builds kept on the
 *                                                  phone. Unknown or hidden targets are skipped, never an error.
 *
 * Signed in only: Bearer (app) or session (web), like the saved posts routes.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { getUserIdFromRequest } from "../auth";
import { businesses, photographers, users, userFavorites, vendorProducts } from "@shared/schema";
import {
  FAVORITE_TYPES,
  isFavoriteType,
  parseImportItems,
  parseTarget,
  placeLine,
  productImage,
  type FavoriteType,
} from "./favorites";

export interface FavoriteView {
  type: FavoriteType;
  id: string;
  name: string;
  image: string | null;
  subtitle: string;
  savedAt: string;
  /** product only: what ProductDetail needs to open */
  businessId?: string;
  priceCents?: number;
}

type Target = Omit<FavoriteView, "savedAt">;

/** Public targets among ids, by id. Same rules as search and the public pages. */
async function loadTargets(type: FavoriteType, ids: string[]): Promise<Map<string, Target>> {
  const out = new Map<string, Target>();
  if (ids.length === 0) return out;
  if (type === "business") {
    const rows = await db
      .select({
        id: businesses.id,
        name: businesses.name,
        logo: businesses.logoImage,
        category: businesses.category,
        city: businesses.city,
        state: businesses.state,
      })
      .from(businesses)
      .innerJoin(users, eq(users.id, businesses.ownerId))
      .where(and(inArray(businesses.id, ids), eq(businesses.approvalStatus, "approved"), eq(users.deletionStatus, "active")));
    for (const r of rows) {
      out.set(r.id, {
        type,
        id: r.id,
        name: r.name,
        image: r.logo || null,
        subtitle: [r.category, placeLine(r.city, r.state)].filter(Boolean).join(" · "),
      });
    }
  } else if (type === "photographer") {
    const rows = await db
      .select({
        id: photographers.id,
        name: photographers.displayName,
        logo: photographers.logoImage,
        city: photographers.city,
        state: photographers.state,
      })
      .from(photographers)
      .innerJoin(users, eq(users.id, photographers.userId))
      .where(and(inArray(photographers.id, ids), eq(photographers.visibilityStatus, "public"), eq(users.deletionStatus, "active")));
    for (const r of rows) {
      out.set(r.id, { type, id: r.id, name: r.name || "Photographer", image: r.logo || null, subtitle: placeLine(r.city, r.state) });
    }
  } else {
    const rows = await db
      .select({
        id: vendorProducts.id,
        name: vendorProducts.name,
        price: vendorProducts.price,
        imageUrl: vendorProducts.imageUrl,
        images: vendorProducts.images,
        businessId: vendorProducts.businessId,
        businessName: businesses.name,
      })
      .from(vendorProducts)
      .innerJoin(businesses, eq(businesses.id, vendorProducts.businessId))
      .innerJoin(users, eq(users.id, businesses.ownerId))
      .where(
        and(
          inArray(vendorProducts.id, ids),
          eq(vendorProducts.isActive, true),
          eq(vendorProducts.status, "live"),
          eq(businesses.approvalStatus, "approved"),
          eq(users.deletionStatus, "active"),
        ),
      );
    for (const r of rows) {
      out.set(r.id, {
        type,
        id: r.id,
        name: r.name,
        image: productImage(r.imageUrl, r.images),
        subtitle: r.businessName || "",
        businessId: r.businessId,
        priceCents: r.price,
      });
    }
  }
  return out;
}

export async function listFavorites(userId: string): Promise<FavoriteView[]> {
  const rows = await db
    .select({ type: userFavorites.targetType, id: userFavorites.targetId, createdAt: userFavorites.createdAt })
    .from(userFavorites)
    .where(eq(userFavorites.userId, userId))
    .orderBy(desc(userFavorites.createdAt));
  const byType = new Map<FavoriteType, Map<string, Target>>();
  for (const type of FAVORITE_TYPES) {
    const ids = rows.filter((r) => r.type === type).map((r) => r.id);
    byType.set(type, await loadTargets(type, ids));
  }
  const out: FavoriteView[] = [];
  for (const r of rows) {
    if (!isFavoriteType(r.type)) continue;
    const t = byType.get(r.type)?.get(r.id);
    if (!t) continue;
    out.push({ ...t, savedAt: new Date(r.createdAt).toISOString() });
  }
  return out;
}

const signedIn = (req: Request, res: Response): string | null => {
  const userId = req.session?.userId || getUserIdFromRequest(req);
  if (!userId) res.status(401).json({ error: "Not authenticated" });
  return userId;
};

export function registerFavoritesRoutes(app: Express): void {
  app.get("/api/users/me/favorites", async (req, res) => {
    const userId = signedIn(req, res);
    if (!userId) return;
    try {
      res.json({ favorites: await listFavorites(userId) });
    } catch (error) {
      console.error("[favorites] list error:", error);
      res.status(500).json({ error: "Failed to get saved items" });
    }
  });

  app.post("/api/favorites", async (req, res) => {
    const userId = signedIn(req, res);
    if (!userId) return;
    const target = parseTarget(req.body?.type, req.body?.id);
    if (!target) return res.status(400).json({ error: "type must be business, photographer or product, with an id" });
    try {
      const found = await loadTargets(target.type, [target.id]);
      if (!found.has(target.id)) return res.status(404).json({ error: "Not found" });
      await db
        .insert(userFavorites)
        .values({ userId, targetType: target.type, targetId: target.id })
        .onConflictDoNothing();
      res.json({ success: true, saved: true });
    } catch (error) {
      console.error("[favorites] save error:", error);
      res.status(500).json({ error: "Failed to save" });
    }
  });

  app.delete("/api/favorites/:type/:id", async (req, res) => {
    const userId = signedIn(req, res);
    if (!userId) return;
    const target = parseTarget(req.params.type, req.params.id);
    if (!target) return res.status(400).json({ error: "type must be business, photographer or product, with an id" });
    try {
      await db
        .delete(userFavorites)
        .where(and(eq(userFavorites.userId, userId), eq(userFavorites.targetType, target.type), eq(userFavorites.targetId, target.id)));
      res.json({ success: true, saved: false });
    } catch (error) {
      console.error("[favorites] remove error:", error);
      res.status(500).json({ error: "Failed to remove" });
    }
  });

  app.post("/api/users/me/favorites/import", async (req, res) => {
    const userId = signedIn(req, res);
    if (!userId) return;
    const items = parseImportItems(req.body);
    if (!items) return res.status(400).json({ error: "items must be a list" });
    try {
      const keep: typeof items = [];
      for (const type of FAVORITE_TYPES) {
        const ofType = items.filter((i) => i.type === type);
        const found = await loadTargets(type, ofType.map((i) => i.id));
        keep.push(...ofType.filter((i) => found.has(i.id)));
      }
      if (keep.length > 0) {
        await db
          .insert(userFavorites)
          .values(
            keep.map((i) => ({
              userId,
              targetType: i.type,
              targetId: i.id,
              ...(i.savedAt ? { createdAt: i.savedAt } : {}),
            })),
          )
          .onConflictDoNothing();
      }
      res.json({ success: true, imported: keep.length, skipped: items.length - keep.length });
    } catch (error) {
      console.error("[favorites] import error:", error);
      res.status(500).json({ error: "Failed to import saved items" });
    }
  });
}
