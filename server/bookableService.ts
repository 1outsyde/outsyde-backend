/**
 * Which services a customer can hold, validate or pay for.
 *
 * Before 2026-10-21 the hold, validate and payment steps loaded the service by id only, so a paused (plan
 * lapsed), draft, archived or inactive service could still be booked, and a service from another business
 * or photographer could be booked under the wrong provider (vault R20).
 *
 * The rule matches the public service lists exactly:
 *   · business services: GET /api/businesses/:id/services keeps `isActive && status === 'live'`
 *   · staff services: getLiveStaffServicesByStaffMember (status 'live')
 *   · photographer services: storage.getPhotographerServices (isActive = true AND status = 'live')
 * plus: the service belongs to the provider being booked, and (businesses only) a paid plan that has lapsed
 * past its grace period blocks every booking, staff included (Legend 2026-10-21). Same lapsed rule as the
 * staff seat block on POST /api/vendor/staff/invites: a business with no Stripe plan keeps today's behaviour.
 *
 * Bookings that already exist are never re-checked (resume, cancel, refund, accept all keep working).
 */
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { SERVICE_UNAVAILABLE_MESSAGE, isServiceBookable, ownsService, planLapsedFromPolicy } from "./bookableRules";

export { SERVICE_UNAVAILABLE_MESSAGE, isServiceBookable, ownsService, planLapsedFromPolicy };
import {
  photographerServices,
  staffServices,
  vendorServices,
  type PhotographerService,
  type StaffService,
  type VendorService,
} from "@shared/schema";

export async function isBusinessPlanLapsed(businessId: string): Promise<boolean> {
  const row = await storage.getVendorSubscriptionByBusinessId(businessId);
  if (!row?.stripeSubscriptionId) return false;
  const policy = await storage.isBusinessSubscriptionActive(businessId);
  return planLapsedFromPolicy(row, policy.active);
}

export type BookableServiceLookup =
  | { ok: true; kind: "vendor"; service: VendorService }
  | { ok: true; kind: "staff"; service: StaffService }
  | { ok: true; kind: "photographer"; service: PhotographerService }
  | { ok: false; code: "SERVICE_NOT_FOUND" | "SERVICE_UNAVAILABLE" };

const UNAVAILABLE = { ok: false, code: "SERVICE_UNAVAILABLE" } as const;
const NOT_FOUND = { ok: false, code: "SERVICE_NOT_FOUND" } as const;

/**
 * Finds the service a booking is for and says whether it can be booked right now. Same lookup order as
 * resolveServiceForHold: with a staff member, their own staff service first, then a business-wide service.
 * SERVICE_NOT_FOUND only when no such service exists at all (unchanged error for clients).
 */
export async function lookupBookableService(
  providerType: "business" | "photographer",
  providerId: string,
  serviceId: string,
  staffMemberId?: string | null,
): Promise<BookableServiceLookup> {
  if (providerType === "photographer") {
    const [svc] = await db.select().from(photographerServices).where(eq(photographerServices.id, serviceId));
    if (!svc) return NOT_FOUND;
    if (!ownsService(svc.photographerId, providerId) || !isServiceBookable(svc)) return UNAVAILABLE;
    return { ok: true, kind: "photographer", service: svc };
  }

  let found: BookableServiceLookup | null = null;
  if (staffMemberId) {
    const [staffSvc] = await db.select().from(staffServices)
      .where(and(eq(staffServices.id, serviceId), eq(staffServices.staffMemberId, staffMemberId)));
    if (staffSvc) {
      if (!ownsService(staffSvc.businessId, providerId) || !isServiceBookable(staffSvc)) return UNAVAILABLE;
      found = { ok: true, kind: "staff", service: staffSvc };
    }
  }
  if (!found) {
    const [svc] = await db.select().from(vendorServices).where(eq(vendorServices.id, serviceId));
    if (!svc) {
      // A staff service that belongs to someone else's staff member is "not bookable", not "missing".
      if (staffMemberId) {
        const [anyStaffSvc] = await db.select({ id: staffServices.id }).from(staffServices).where(eq(staffServices.id, serviceId));
        if (anyStaffSvc) return UNAVAILABLE;
      }
      return NOT_FOUND;
    }
    if (!ownsService(svc.businessId, providerId) || !isServiceBookable(svc)) return UNAVAILABLE;
    found = { ok: true, kind: "vendor", service: svc };
  }

  if (await isBusinessPlanLapsed(providerId)) return UNAVAILABLE;
  return found;
}

/** Message for a failed lookup (SERVICE_NOT_FOUND keeps its old text). */
export function lookupFailureMessage(code: "SERVICE_NOT_FOUND" | "SERVICE_UNAVAILABLE"): string {
  return code === "SERVICE_UNAVAILABLE" ? SERVICE_UNAVAILABLE_MESSAGE : "Service not found";
}

/**
 * Payment step: before a NEW booking is created from a hold, the service must still be bookable (it may
 * have been paused, archived or the plan may have lapsed during the hold). Never used on resume paths.
 * A hold with no service id (not created by today's hold route) is left as before.
 */
export async function isHoldStillBookable(hold: {
  providerType: string;
  providerId: string;
  serviceId?: string | null;
  staffMemberId?: string | null;
}): Promise<boolean> {
  if (!hold.serviceId) return true;
  if (hold.providerType !== "business" && hold.providerType !== "photographer") return true;
  const r = await lookupBookableService(hold.providerType, hold.providerId, hold.serviceId, hold.staffMemberId);
  return r.ok;
}

/** Response body when the payment step refuses (same shape as the hold route's AvailabilityError). */
export const SERVICE_UNAVAILABLE_BODY = {
  success: false,
  errorCode: "SERVICE_UNAVAILABLE",
  error: SERVICE_UNAVAILABLE_MESSAGE,
} as const;
