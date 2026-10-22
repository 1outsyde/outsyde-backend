/**
 * Estimate requests (migration 067), first used by Royal Elite Moving's site.
 *
 * Same flow the business already runs by phone: the customer fills in the estimate form, the business is
 * emailed every detail, and calls the customer back within 24 to 48 hours to confirm and quote. The only
 * new part is that each request is also saved, so the business sees it in its site dashboard and moves it
 * along (new, called, quoted, booked, closed) with its own notes. No payment is involved.
 *
 *   POST  /api/estimate-requests                 signed in customer (Bearer or session), 5 per hour per account
 *   GET   /api/vendor/estimate-requests          business owner, or platform admin with x-business-id
 *   PATCH /api/vendor/estimate-requests/:id      same; changes status and / or vendor notes only
 *
 * Sign in is required (Legend 2026-10-02 and 2026-10-22): vendor sites post through their own server, so
 * per IP limits would see one address for everyone; per account limits do not.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { getUserIdFromRequest } from "../auth";
import { estimateRequests, ESTIMATE_REQUEST_STATUSES, type EstimateRequest } from "@shared/schema";
import { sendAdminEmail, ADMIN_NOTIFICATION_EMAIL } from "../emailService";
import { buildEstimateRequestEmail } from "./estimateEmail";
import { cleanCityName, isBusinessCity, isServiceOfferedInCity } from "./serviceCities";

const ADMIN_EMAILS = ["info@goutsyde.com", "jamesmeyers2304@gmail.com"];
const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_VALUE = 2000;

const submitSchema = z.object({
  businessId: z.string().min(1).max(64),
  serviceId: z.string().min(1).max(64).nullable().optional(),
  city: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(7).max(40),
  preferredDate: z.string().trim().max(40).nullable().optional(),
  details: z
    .record(z.string().max(60), z.string().max(MAX_DETAIL_VALUE))
    .refine((d) => Object.keys(d).length <= MAX_DETAIL_KEYS, { message: "Too many details" })
    .optional()
    .default({}),
  source: z.string().trim().max(60).nullable().optional(),
});

const updateSchema = z
  .object({
    status: z.enum(ESTIMATE_REQUEST_STATUSES).optional(),
    vendorNotes: z.string().max(5000).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.vendorNotes !== undefined, { message: "Nothing to update" });

type Owner = { business: NonNullable<Awaited<ReturnType<typeof storage.getBusiness>>> };

/** Owner of the business, or a platform admin acting on the business named in x-business-id. */
async function resolveVendorBusiness(req: Request, res: Response): Promise<Owner | null> {
  const userId = (req.session as any)?.userId || getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const xBusinessId = (req.headers["x-business-id"] as string | undefined) || undefined;
  const user = await storage.getUser(userId);
  const isAdmin = ADMIN_EMAILS.includes((user?.email ?? "").toLowerCase());
  const business = xBusinessId && isAdmin
    ? await storage.getBusiness(xBusinessId)
    : await storage.getBusinessByOwnerId(userId);
  if (!business) {
    res.status(404).json({ error: "No business found" });
    return null;
  }
  // An owner naming another business is refused, never silently switched to their own.
  if (xBusinessId && !isAdmin && xBusinessId !== business.id) {
    res.status(403).json({ error: "Not allowed" });
    return null;
  }
  return { business };
}

function toVendorJson(r: EstimateRequest) {
  return {
    id: r.id,
    status: r.status,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    city: r.city,
    customerName: r.customerName,
    customerEmail: r.customerEmail,
    customerPhone: r.customerPhone,
    preferredDate: r.preferredDate,
    details: r.details ?? {},
    vendorNotes: r.vendorNotes,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function registerEstimateRequestRoutes(app: Express): void {
  const submitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    // Only saved requests count, so a customer fixing a form mistake is never locked out.
    skipFailedRequests: true,
    // Per account (sign in is required before this runs); never per IP, see the header comment.
    keyGenerator: (req) => `estimate:${(req as any).estimateUserId}`,
    message: { success: false, message: "You've sent several requests already. Please try again in an hour or call the business." },
  });

  app.post(
    "/api/estimate-requests",
    (req, res, next) => {
      const userId = (req.session as any)?.userId || getUserIdFromRequest(req);
      if (!userId) return res.status(401).json({ success: false, message: "Please sign in to request an estimate." });
      (req as any).estimateUserId = userId;
      next();
    },
    submitLimiter,
    async (req, res) => {
      const parsed = submitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: "Please check the form and try again.", details: parsed.error.errors });
      }
      const input = parsed.data;
      try {
        const business = await storage.getBusiness(input.businessId);
        if (!business) return res.status(404).json({ success: false, message: "Business not found." });

        const city = cleanCityName(input.city);
        if (!isBusinessCity(business.serviceCities, city)) {
          return res.status(400).json({ success: false, field: "city", message: "This business doesn't serve that city yet." });
        }

        let serviceId: string | null = null;
        let serviceName: string | null = null;
        if (input.serviceId) {
          const svc = await storage.getVendorService(input.serviceId);
          if (!svc || svc.businessId !== business.id || svc.status !== "live" || svc.isActive !== true) {
            return res.status(400).json({ success: false, field: "serviceId", message: "That plan isn't available. Please choose another." });
          }
          if (!isServiceOfferedInCity(svc.serviceCities, city)) {
            return res.status(400).json({ success: false, field: "serviceId", message: "That plan isn't offered in your city. Please choose another." });
          }
          serviceId = svc.id;
          serviceName = svc.name;
        }

        const details: Record<string, string> = {};
        for (const [k, v] of Object.entries(input.details ?? {})) {
          const value = v.trim();
          if (value) details[k] = value;
        }

        const [saved] = await db
          .insert(estimateRequests)
          .values({
            businessId: business.id,
            customerId: (req as any).estimateUserId,
            serviceId,
            serviceName,
            city,
            customerName: input.name,
            customerEmail: input.email,
            customerPhone: input.phone,
            preferredDate: input.preferredDate || null,
            details,
            source: input.source || null,
          })
          .returning();

        // Emails never decide the answer: the request is saved, so the business sees it either way.
        const email = buildEstimateRequestEmail({ businessName: business.name, request: saved });
        const owner = business.ownerId ? await storage.getUser(business.ownerId) : undefined;
        const sends: Promise<boolean>[] = [];
        if (owner?.email) {
          sends.push(sendAdminEmail({
            to: owner.email,
            subject: email.subject,
            html: email.html,
            text: email.text,
            replyTo: saved.customerEmail,
            log: { kind: "booking", label: "Estimate request" },
          }));
        } else {
          console.error(`[estimate-requests] business ${business.id} has no owner email; only Outsyde is emailed`);
        }
        if (!owner?.email || owner.email.toLowerCase() !== ADMIN_NOTIFICATION_EMAIL.toLowerCase()) {
          sends.push(sendAdminEmail({
            to: ADMIN_NOTIFICATION_EMAIL,
            subject: `${email.subject} (${business.name.trim()})`,
            html: email.html,
            text: email.text,
            replyTo: saved.customerEmail,
          }));
        }
        const results = await Promise.allSettled(sends);
        if (results.some((r) => r.status === "rejected" || r.value === false)) {
          console.error(`[estimate-requests] an email failed for request ${saved.id}`);
        }

        return res.status(201).json({ success: true, request: { id: saved.id, status: saved.status, createdAt: saved.createdAt } });
      } catch (err) {
        console.error("[estimate-requests] submit failed:", err);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again or call the business." });
      }
    },
  );

  app.get("/api/vendor/estimate-requests", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      if (status && !(ESTIMATE_REQUEST_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: "Unknown status" });
      }
      const where = status
        ? and(eq(estimateRequests.businessId, owner.business.id), eq(estimateRequests.status, status as EstimateRequest["status"]))
        : eq(estimateRequests.businessId, owner.business.id);
      const rows = await db.select().from(estimateRequests).where(where).orderBy(desc(estimateRequests.createdAt)).limit(500);
      return res.json({ requests: rows.map(toVendorJson) });
    } catch (err) {
      console.error("[estimate-requests] list failed:", err);
      return res.status(500).json({ error: "Failed to load estimate requests" });
    }
  });

  app.patch("/api/vendor/estimate-requests/:id", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.errors });
      const [existing] = await db.select().from(estimateRequests).where(eq(estimateRequests.id, req.params.id));
      if (!existing || existing.businessId !== owner.business.id) {
        return res.status(404).json({ error: "Request not found" });
      }
      const set: Partial<EstimateRequest> = { updatedAt: new Date() };
      if (parsed.data.status !== undefined) set.status = parsed.data.status;
      if (parsed.data.vendorNotes !== undefined) set.vendorNotes = parsed.data.vendorNotes?.trim() || null;
      const [updated] = await db
        .update(estimateRequests)
        .set(set)
        .where(and(eq(estimateRequests.id, existing.id), eq(estimateRequests.businessId, owner.business.id)))
        .returning();
      return res.json({ request: toVendorJson(updated) });
    } catch (err) {
      console.error("[estimate-requests] update failed:", err);
      return res.status(500).json({ error: "Failed to update estimate request" });
    }
  });
}
