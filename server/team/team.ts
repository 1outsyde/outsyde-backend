/**
 * Business team access (migration 112, Royal Elite, Legend 2026-11-11): people other than the owner who help
 * run a business's own site dashboard. A team member acts only when the site names that business
 * (x-business-id) and only on routes that opt in through resolveVendorBusiness(req, res, { team }).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { businessTeamMembers } from "@shared/schema";

export { roleAllows, ROLES_THAT_MANAGE_TEAM, type TeamAccess, type TeamRole } from "./teamRules";
import type { TeamRole } from "./teamRules";

export async function teamRoleFor(userId: string, businessId: string): Promise<TeamRole | null> {
  const [row] = await db.select({ role: businessTeamMembers.role }).from(businessTeamMembers)
    .where(and(eq(businessTeamMembers.userId, userId), eq(businessTeamMembers.businessId, businessId)))
    .limit(1);
  return row?.role ?? null;
}

/** For /api/auth/me: the businesses this user helps run. */
export async function teamFor(userId: string): Promise<{ businessId: string; role: TeamRole }[]> {
  return db.select({ businessId: businessTeamMembers.businessId, role: businessTeamMembers.role })
    .from(businessTeamMembers).where(eq(businessTeamMembers.userId, userId));
}
