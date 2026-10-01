// server/middleware/requirePlatformAdmin.ts
import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type TokenPayload } from "../auth";
import { storage } from "../storage";

// Must match ALLOWED_ADMIN_EMAILS in routes.ts:16028 — keep in sync.
const ALLOWED_ADMIN_EMAILS = [
  'info@goutsyde.com',
  'jamesmeyers2304@gmail.com',
].map(e => e.toLowerCase());

const isAllowedAdminEmail = (email: string | null | undefined): boolean => {
  if (!email) return false;
  return ALLOWED_ADMIN_EMAILS.includes(email.toLowerCase());
};

/**
 * Standalone copy of requireAdmin (routes.ts:16070-16118) for routers that cannot reach
 * the registerRoutes closure. JWT first (isAdmin falsy → 403), session fallback, then a DB
 * check of user.isAdmin AND an allowed admin email.
 */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const anyReq = req as any;
    let userId: string | null = null;
    let tokenPayload: TokenPayload | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      tokenPayload = verifyAccessToken(authHeader.substring(7));
      if (tokenPayload) {
        userId = tokenPayload.userId;
        if (req.session) {
          req.session.userId = tokenPayload.userId;
        }
        if (!tokenPayload.isAdmin) {
          return res.status(403).json({ error: "Admin access required" });
        }
      }
    }

    if (!userId && req.session?.userId) {
      userId = req.session.userId;
    }

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    if (!user?.isAdmin || !isAllowedAdminEmail(user.email)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    anyReq.adminUser = user;
    anyReq.user = tokenPayload || anyReq.user;
    next();
  } catch {
    return res.status(500).json({ error: "Admin check failed" });
  }
}
