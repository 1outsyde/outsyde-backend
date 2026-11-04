/**
 * Request forms (Quotes in Messages, step 1, migration 096). Rules: ./requestForms.ts.
 *
 *   GET    /api/vendor/request-forms                     owner (or platform admin with x-business-id): the library
 *   POST   /api/vendor/request-forms                     create { name, isBase?, questions }
 *   PATCH  /api/vendor/request-forms/:id                 edit { name?, questions? }
 *   DELETE /api/vendor/request-forms/:id                 remove an unused saved form (never the base form)
 *   GET    /api/vendor/services/:id/request-form         a service's form settings + the resolved questions
 *   PUT    /api/vendor/services/:id/request-form         { formId | null, useBase, questions } (request only services)
 *   GET    /api/services/:id/request-form                public: the form a customer fills in
 *   GET    /api/me/requests                              signed in customer: their own requests
 *   GET    /api/requests/:id                             the customer who sent it, or the business owner (or admin)
 *
 * Service form settings have their own route so the service edit route every site and the app use is untouched.
 * Sending a request stays POST /api/estimate-requests (server/estimates/estimateRequestRoutes.ts).
 */
import type { Express } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { getUserIdFromRequest } from "../auth";
import {
  businesses,
  estimateRequests,
  requestForms,
  vendorServices,
  type EstimateRequest,
  type RequestForm,
  type VendorService,
} from "@shared/schema";
import { resolveVendorBusiness } from "../estimates/estimateRequestRoutes";
import { isServiceOfferedInCity } from "../estimates/serviceCities";
import { checkResolvedLimits, normalizeQuestions, resolveServiceForm, type RequestQuestion } from "./requestForms";
import { loadResolvedForm } from "./serviceForm";

const ADMIN_EMAILS = ["info@goutsyde.com", "jamesmeyers2304@gmail.com"];
const MAX_FORMS = 50;

const nameSchema = z.string().trim().min(1, "A form needs a name").max(80);

function toFormJson(f: RequestForm) {
  return { id: f.id, name: f.name, isBase: f.isBase, questions: f.questions ?? [], createdAt: f.createdAt, updatedAt: f.updatedAt };
}

function settingsJson(s: VendorService) {
  return { formId: s.requestFormId ?? null, useBase: s.requestFormUseBase === true, questions: s.requestQuestions ?? [] };
}

/** What the customer sees about their own request (never the business's private notes). */
function toCustomerJson(r: EstimateRequest, businessName: string | null) {
  return {
    id: r.id,
    status: r.status,
    businessId: r.businessId,
    businessName: businessName?.trim() ?? null,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    city: r.city,
    preferredDate: r.preferredDate,
    details: r.details ?? {},
    answers: r.answers ?? [],
    conversationId: r.conversationId ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function registerRequestFormRoutes(app: Express): void {
  // ── Library ──────────────────────────────────────────────────────────────────────────────────────────────
  app.get("/api/vendor/request-forms", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const rows = await db.select().from(requestForms)
        .where(and(eq(requestForms.businessId, owner.business.id), eq(requestForms.isActive, true)));
      rows.sort((a, b) => (a.isBase === b.isBase ? a.name.localeCompare(b.name) : a.isBase ? -1 : 1));
      return res.json({ forms: rows.map(toFormJson), baseFormId: rows.find((r) => r.isBase)?.id ?? null });
    } catch (err) {
      console.error("[request-forms] list failed:", err);
      return res.status(500).json({ error: "Failed to load forms" });
    }
  });

  app.post("/api/vendor/request-forms", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const name = nameSchema.safeParse(req.body?.name);
      if (!name.success) return res.status(400).json({ error: "Invalid data", message: name.error.errors[0]?.message ?? "A form needs a name", field: "name" });
      const qs = normalizeQuestions(req.body?.questions ?? []);
      if (!qs.ok) return res.status(400).json({ error: "Invalid data", message: qs.message, field: "questions" });
      const isBase = req.body?.isBase === true;
      const existing = await db.select({ id: requestForms.id, isBase: requestForms.isBase }).from(requestForms)
        .where(and(eq(requestForms.businessId, owner.business.id), eq(requestForms.isActive, true)));
      if (isBase && existing.some((r) => r.isBase)) {
        return res.status(409).json({ code: "BASE_EXISTS", message: "This business already has a base form. Edit it instead." });
      }
      if (existing.length >= MAX_FORMS) {
        return res.status(409).json({ code: "TOO_MANY_FORMS", message: `A business can keep up to ${MAX_FORMS} forms.` });
      }
      try {
        const [form] = await db.insert(requestForms).values({ businessId: owner.business.id, name: name.data, isBase, questions: qs.questions }).returning();
        return res.status(201).json({ form: toFormJson(form) });
      } catch (err: any) {
        // Two base forms created at the same moment: the unique index keeps one.
        const pgErr = err?.cause ?? err;
        if (pgErr?.code === "23505" && String(pgErr?.constraint ?? pgErr?.message ?? "").includes("uq_request_forms_one_base")) {
          return res.status(409).json({ code: "BASE_EXISTS", message: "This business already has a base form. Edit it instead." });
        }
        throw err;
      }
    } catch (err) {
      console.error("[request-forms] create failed:", err);
      return res.status(500).json({ error: "Failed to save the form" });
    }
  });

  app.patch("/api/vendor/request-forms/:id", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const [form] = await db.select().from(requestForms).where(eq(requestForms.id, req.params.id));
      if (!form || form.businessId !== owner.business.id || !form.isActive) return res.status(404).json({ error: "Form not found" });
      const set: Partial<RequestForm> = { updatedAt: new Date() };
      if (req.body?.name !== undefined) {
        const name = nameSchema.safeParse(req.body.name);
        if (!name.success) return res.status(400).json({ error: "Invalid data", message: name.error.errors[0]?.message ?? "A form needs a name", field: "name" });
        set.name = name.data;
      }
      if (req.body?.questions !== undefined) {
        const qs = normalizeQuestions(req.body.questions);
        if (!qs.ok) return res.status(400).json({ error: "Invalid data", message: qs.message, field: "questions" });
        // The base form is combined with each service's own questions: the limits hold on the combination.
        if (form.isBase) {
          const users = await db.select().from(vendorServices).where(and(
            eq(vendorServices.businessId, owner.business.id),
            eq(vendorServices.requestFormUseBase, true),
          ));
          const tooBig = users.filter((svc) => !svc.requestFormId && !checkResolvedLimits(resolveServiceForm({
            savedForm: null, base: qs.questions, useBase: true, own: (svc.requestQuestions ?? []) as RequestQuestion[],
          })).ok);
          if (tooBig.length > 0) {
            return res.status(409).json({
              code: "TOO_MANY_QUESTIONS",
              message: "With these questions some services would go over the form limits. Remove questions from those services first.",
              services: tooBig.map((svc) => ({ id: svc.id, name: svc.name })),
            });
          }
        }
        set.questions = qs.questions;
      }
      const [updated] = await db.update(requestForms).set(set)
        .where(and(eq(requestForms.id, form.id), eq(requestForms.businessId, owner.business.id))).returning();
      return res.json({ form: toFormJson(updated) });
    } catch (err) {
      console.error("[request-forms] update failed:", err);
      return res.status(500).json({ error: "Failed to save the form" });
    }
  });

  app.delete("/api/vendor/request-forms/:id", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const [form] = await db.select().from(requestForms).where(eq(requestForms.id, req.params.id));
      if (!form || form.businessId !== owner.business.id || !form.isActive) return res.status(404).json({ error: "Form not found" });
      if (form.isBase) return res.status(409).json({ code: "BASE_FORM", message: "The base form can't be removed. Edit its questions instead." });
      const using = await db.select({ id: vendorServices.id, name: vendorServices.name }).from(vendorServices)
        .where(and(eq(vendorServices.businessId, owner.business.id), eq(vendorServices.requestFormId, form.id)));
      if (using.length > 0) {
        return res.status(409).json({ code: "FORM_IN_USE", message: "Some services use this form. Choose another form for them first.", services: using });
      }
      // One statement, so a service can't start using the form between the check above and the removal.
      const removed = await db.update(requestForms).set({ isActive: false, updatedAt: new Date() })
        .where(and(
          eq(requestForms.id, form.id),
          sql`NOT EXISTS (SELECT 1 FROM vendor_services s WHERE s.request_form_id = ${form.id})`,
        ))
        .returning({ id: requestForms.id });
      if (removed.length === 0) {
        return res.status(409).json({ code: "FORM_IN_USE", message: "Some services use this form. Choose another form for them first.", services: [] });
      }
      return res.json({ success: true });
    } catch (err) {
      console.error("[request-forms] delete failed:", err);
      return res.status(500).json({ error: "Failed to remove the form" });
    }
  });

  // ── Service form settings ────────────────────────────────────────────────────────────────────────────────
  app.get("/api/vendor/services/:id/request-form", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const svc = await storage.getVendorService(req.params.id);
      if (!svc || svc.businessId !== owner.business.id) return res.status(404).json({ error: "Service not found" });
      return res.json({ settings: settingsJson(svc), resolved: await loadResolvedForm(svc) });
    } catch (err) {
      console.error("[request-forms] service settings failed:", err);
      return res.status(500).json({ error: "Failed to load the service form" });
    }
  });

  app.put("/api/vendor/services/:id/request-form", async (req, res) => {
    try {
      const owner = await resolveVendorBusiness(req, res);
      if (!owner) return;
      const svc = await storage.getVendorService(req.params.id);
      if (!svc || svc.businessId !== owner.business.id) return res.status(404).json({ error: "Service not found" });
      if (svc.requestOnly !== true) {
        return res.status(400).json({ code: "NOT_REQUEST_ONLY", message: "Only request only services use a request form." });
      }
      const formId = req.body?.formId ?? null;
      const useBase = req.body?.useBase === true;
      const qs = normalizeQuestions(req.body?.questions ?? []);
      if (!qs.ok) return res.status(400).json({ error: "Invalid data", message: qs.message, field: "questions" });
      if (formId !== null) {
        if (typeof formId !== "string") return res.status(400).json({ error: "Invalid data", message: "Choose a form from your library", field: "formId" });
        if (useBase || qs.questions.length > 0) {
          return res.status(400).json({ error: "Invalid data", message: "A saved form is used on its own. Remove the extra questions or choose the base form.", field: "formId" });
        }
        const [form] = await db.select().from(requestForms).where(eq(requestForms.id, formId));
        if (!form || form.businessId !== owner.business.id || !form.isActive || form.isBase) {
          return res.status(400).json({ error: "Invalid data", message: "Choose a saved form from your library", field: "formId" });
        }
      }
      if (formId === null) {
        const [base] = useBase
          ? await db.select().from(requestForms).where(and(eq(requestForms.businessId, owner.business.id), eq(requestForms.isBase, true), eq(requestForms.isActive, true)))
          : [];
        const limits = checkResolvedLimits(resolveServiceForm({
          savedForm: null, base: base ? (base.questions as RequestQuestion[]) : null, useBase, own: qs.questions,
        }));
        if (!limits.ok) return res.status(400).json({ error: "Invalid data", message: limits.message, field: "questions" });
      }
      const [updated] = await db.update(vendorServices)
        .set({ requestFormId: formId, requestFormUseBase: formId === null ? useBase : false, requestQuestions: formId === null ? qs.questions : [] })
        .where(and(eq(vendorServices.id, svc.id), eq(vendorServices.businessId, owner.business.id)))
        .returning();
      return res.json({ settings: settingsJson(updated), resolved: await loadResolvedForm(updated) });
    } catch (err) {
      console.error("[request-forms] service settings save failed:", err);
      return res.status(500).json({ error: "Failed to save the service form" });
    }
  });

  // ── Customer side ────────────────────────────────────────────────────────────────────────────────────────
  app.get("/api/services/:id/request-form", async (req, res) => {
    try {
      const svc = await storage.getVendorService(req.params.id);
      if (!svc || svc.status !== "live" || svc.isActive !== true || svc.requestOnly !== true) {
        return res.status(404).json({ error: "This service doesn't take requests" });
      }
      const business = await storage.getBusiness(svc.businessId);
      if (!business) return res.status(404).json({ error: "This service doesn't take requests" });
      const cities = (business.serviceCities ?? []).filter((c) => isServiceOfferedInCity(svc.serviceCities, c));
      return res.json({
        service: { id: svc.id, name: svc.name, description: svc.description, price: svc.price },
        business: { id: business.id, name: business.name.trim() },
        cities,
        // A business with a city list needs a city on every request (an empty list then means none fit).
        cityRequired: (business.serviceCities ?? []).length > 0,
        phoneRequired: true,
        questions: await loadResolvedForm(svc),
      });
    } catch (err) {
      console.error("[request-forms] public form failed:", err);
      return res.status(500).json({ error: "Failed to load the form" });
    }
  });

  app.get("/api/me/requests", async (req, res) => {
    try {
      const userId = (req.session as any)?.userId || getUserIdFromRequest(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const rows = await db.select().from(estimateRequests).where(eq(estimateRequests.customerId, userId))
        .orderBy(desc(estimateRequests.createdAt)).limit(200);
      const bizIds = Array.from(new Set(rows.map((r) => r.businessId)));
      const names = bizIds.length
        ? await db.select({ id: businesses.id, name: businesses.name }).from(businesses).where(inArray(businesses.id, bizIds))
        : [];
      const nameOf = new Map(names.map((b) => [b.id, b.name]));
      return res.json({ requests: rows.map((r) => toCustomerJson(r, nameOf.get(r.businessId) ?? null)) });
    } catch (err) {
      console.error("[request-forms] my requests failed:", err);
      return res.status(500).json({ error: "Failed to load your requests" });
    }
  });

  app.get("/api/requests/:id", async (req, res) => {
    try {
      const userId = (req.session as any)?.userId || getUserIdFromRequest(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const [r] = await db.select().from(estimateRequests).where(eq(estimateRequests.id, req.params.id));
      if (!r) return res.status(404).json({ error: "Request not found" });
      const business = await storage.getBusiness(r.businessId);
      const user = await storage.getUser(userId);
      const isAdmin = ADMIN_EMAILS.includes((user?.email ?? "").toLowerCase());
      const isOwner = !!business && business.ownerId === userId;
      if (isOwner || isAdmin) {
        return res.json({
          request: {
            ...toCustomerJson(r, business?.name ?? null),
            customerId: r.customerId,
            customerName: r.customerName,
            customerEmail: r.customerEmail,
            customerPhone: r.customerPhone,
            vendorNotes: r.vendorNotes,
            source: r.source,
          },
        });
      }
      if (r.customerId === userId) return res.json({ request: toCustomerJson(r, business?.name ?? null) });
      // Anyone else gets the same answer as a request that doesn't exist.
      return res.status(404).json({ error: "Request not found" });
    } catch (err) {
      console.error("[request-forms] request detail failed:", err);
      return res.status(500).json({ error: "Failed to load the request" });
    }
  });
}
