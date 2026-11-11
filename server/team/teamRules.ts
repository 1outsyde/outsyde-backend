/** Team access rules (migration 112), no database: see team.ts. */
import type { BusinessTeamMember } from "@shared/schema";

/** What a route lets a team member do: "read" = view only, "requests" = estimate requests (status, notes). */
export type TeamAccess = "read" | "requests";
export type TeamRole = BusinessTeamMember["role"];

/** Roles that may add or change team members (the owner and Outsyde admins always can). None yet. */
export const ROLES_THAT_MANAGE_TEAM: readonly TeamRole[] = [];

/** Whether a role is enough for what the route allows. Every role can read and work requests. */
export function roleAllows(role: TeamRole | null | undefined, access: TeamAccess): boolean {
  if (role !== "requests" && role !== "manager") return false;
  return access === "read" || access === "requests";
}

