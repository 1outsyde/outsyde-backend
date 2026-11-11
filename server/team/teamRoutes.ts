/**
 * Business team (migration 112, Royal Elite, Legend 2026-11-11). The owner (or an Outsyde admin with
 * x-business-id) lists, adds and removes the people who help run the business's site dashboard.
 * Team members themselves can't change the team (resolveVendorBusiness without { team }).
 *
 *   GET    /api/vendor/team            → { members: [{ userId, email, name, role, createdAt }] }
 *   POST   /api/vendor/team { email }  → 201 { member }   (role "requests"; the person needs an Outsyde account)
 *   DELETE /api/vendor/team/:userId    → { ok: true }
 */
import type { Express } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { storage } from "../storage";
import { businessTeamMembers, users } from "@shared/schema";
import { resolveVendorBusiness } from "../estimates/estimateRequestRoutes";
import { getUserIdFromRequest } from "../auth";

const addSchema = z.object({ email: z.string().trim().min(3).max(254) });

async function listMembers(businessId: string) {
  const rows = await db.select({
    userId: businessTeamMembers.userId,
    role: businessTeamMembers.role,
    createdAt: businessTeamMembers.createdAt,
    email: users.email,
    firstName: users.firstName,
    lastName: users.lastName,
  }).from(businessTeamMembers)
    .innerJoin(users, eq(users.id, businessTeamMembers.userId))
    .where(eq(businessTeamMembers.businessId, businessId))
    .orderBy(asc(businessTeamMembers.createdAt));
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
    role: r.role,
    createdAt: r.createdAt,
  }));
}

export function registerTeamRoutes(app: Express): void {
  app.get("/api/vendor/team", async (req, res) => {
    try {
      const found = await resolveVendorBusiness(req, res);
      if (!found) return;
      return res.json({ members: await listMembers(found.business.id) });
    } catch (err) {
      console.error("[team] list failed", err);
      return res.status(500).json({ error: "Could not load your team." });
    }
  });

  app.post("/api/vendor/team", async (req, res) => {
    try {
      const found = await resolveVendorBusiness(req, res);
      if (!found) return;
      const parsed = addSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Enter the email they use for Outsyde.", field: "email" });
      const user = await storage.getUserByEmail(parsed.data.email);
      if (!user) return res.status(404).json({ error: "No Outsyde account uses that email. Ask them to create a free account first, then add them.", field: "email" });
      if (user.id === found.business.ownerId) return res.status(400).json({ error: "That's the owner's account. The owner already has full access.", field: "email" });
      const inserted = await db.insert(businessTeamMembers).values({
        businessId: found.business.id,
        userId: user.id,
        role: "requests",
        addedBy: (req.session as any)?.userId || getUserIdFromRequest(req) || null,
      }).onConflictDoNothing().returning();
      if (inserted.length === 0) return res.status(409).json({ error: "They're already on your team.", field: "email" });
      const member = (await listMembers(found.business.id)).find((m) => m.userId === user.id);
      return res.status(201).json({ member });
    } catch (err) {
      console.error("[team] add failed", err);
      return res.status(500).json({ error: "Could not add them. Please try again." });
    }
  });

  app.delete("/api/vendor/team/:userId", async (req, res) => {
    try {
      const found = await resolveVendorBusiness(req, res);
      if (!found) return;
      const removed = await db.delete(businessTeamMembers)
        .where(and(eq(businessTeamMembers.businessId, found.business.id), eq(businessTeamMembers.userId, req.params.userId)))
        .returning();
      if (removed.length === 0) return res.status(404).json({ error: "They're not on your team." });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[team] remove failed", err);
      return res.status(500).json({ error: "Could not remove them. Please try again." });
    }
  });
}
