/**
 * Request forms (Quotes in Messages, step 1, migration 096; photographers Request forms F2, migration 108).
 * Rules: ./requestForms.ts.
 *
 * Businesses (owner, or platform admin with x-business-id):
 *   GET    /api/vendor/request-forms                     the library
 *   POST   /api/vendor/request-forms                     create { name, isBase?, questions }
 *   PATCH  /api/vendor/request-forms/:id                 edit { name?, questions? }
 *   DELETE /api/vendor/request-forms/:id                 remove an unused saved form (never the base form)
 *   GET    /api/vendor/services/:id/request-form         a service's form settings + the resolved questions
 *   PUT    /api/vendor/services/:id/request-form         { formId | null, useBase, questions } (request only services)
 * Photographers (the signed in photographer, migration 108), same bodies and answers:
 *   GET/POST /api/photographers/me/request-forms, PATCH/DELETE /api/photographers/me/request-forms/:id,
 *   GET/PUT  /api/photographers/me/services/:id/request-form (contact for pricing services)
 * Customers:
 *   GET    /api/services/:id/request-form                public: the form a customer fills in (business service)
 *   GET    /api/photographer-services/:id/request-form   public: the same for a photographer service (F2)
 *   GET    /api/me/requests                              signed in customer: their own requests
 *   GET    /api/requests/:id                             the customer who sent it, the business owner or photographer (or admin)
 *
 * Service form settings have their own route so the service edit route every site and the app use is untouched.
 * The photographer routes are registered after the photographers router (routes.ts app.use("/api/photographers")),
 * which has no route matching these paths and passes them on.
 * Sending a request stays POST /api/estimate-requests (server/estimates/estimateRequestRoutes.ts).
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { getUserIdFromRequest } from "../auth";
import {
  businesses,
  estimateRequests,
  photographers,
  photographerServices,
  requestForms,
  vendorServices,
  type EstimateRequest,
  type RequestForm,
} from "@shared/schema";
import { resolveRequestPhotographer, resolveVendorBusiness } from "../estimates/estimateRequestRoutes";
import { isServiceOfferedInCity } from "../estimates/serviceCities";
import { checkResolvedLimits, normalizeQuestions, resolveServiceForm, type RequestQuestion } from "./requestForms";
import { formBelongsTo, formOwnerWhere, loadFormQuestions, loadPhotographerResolvedForm, loadResolvedForm, type FormOwner } from "./serviceForm";
import { requestablePhotographerService } from "./photographerRequests";

const ADMIN_EMAILS = ["info@goutsyde.com", "jamesmeyers2304@gmail.com"];
const MAX_FORMS = 50;

const nameSchema = z.string().trim().min(1, "A form needs a name").max(80);

function toFormJson(f: RequestForm) {
  return { id: f.id, name: f.name, isBase: f.isBase, questions: f.questions ?? [], createdAt: f.createdAt, updatedAt: f.updatedAt };
}

type SettingsRow = { requestFormId: string | null; requestFormUseBase: boolean; requestQuestions: unknown };
function settingsJson(s: SettingsRow) {
  return { formId: s.requestFormId ?? null, useBase: s.requestFormUseBase === true, questions: s.requestQuestions ?? [] };
}

/** What the customer sees about their own request (never the business's private notes). */
function toCustomerJson(r: EstimateRequest, vendorName: string | null) {
  return {
    id: r.id,
    status: r.status,
    businessId: r.businessId ?? null,
    // Call 8 (F2): the photographer's name for a photographer request, so older apps and the website show it.
    businessName: vendorName?.trim() ?? null,
    // F2 (additive): who the request is to.
    photographerId: r.photographerId ?? null,
    vendorType: r.photographerId ? "photographer" : "business",
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

// ── One owner's side: how its library and its services are found ──────────────────────────────────────────

type ServiceRow = { id: string; name: string; requestOnly: boolean } & SettingsRow;

interface OwnerSide {
  /** The signed in owner, or null after an error reply. */
  resolve(req: Request, res: Response): Promise<FormOwner | null>;
  /** The owner's service by id, or null when it doesn't exist or isn't theirs. */
  service(owner: FormOwner, id: string): Promise<ServiceRow | null>;
  /** Saves a service's form settings. */
  saveService(owner: FormOwner, id: string, set: SettingsRow): Promise<ServiceRow>;
  /** The owner's services that put the base form first and have no saved form (base form limits). */
  baseUsers(owner: FormOwner): Promise<{ id: string; name: string; requestQuestions: unknown }[]>;
  /** The owner's services that use this saved form. */
  formUsers(owner: FormOwner, formId: string): Promise<{ id: string; name: string }[]>;
}

const businessSide: OwnerSide = {
  async resolve(req, res) {
    const o = await resolveVendorBusiness(req, res);
    return o ? { kind: "business", id: o.business.id } : null;
  },
  async service(owner, id) {
    const svc = await storage.getVendorService(id);
    if (!svc || svc.businessId !== owner.id) return null;
    return { id: svc.id, name: svc.name, requestOnly: svc.requestOnly === true, requestFormId: svc.requestFormId, requestFormUseBase: svc.requestFormUseBase, requestQuestions: svc.requestQuestions };
  },
  async saveService(owner, id, set) {
    const [u] = await db.update(vendorServices).set(set as any)
      .where(and(eq(vendorServices.id, id), eq(vendorServices.businessId, owner.id))).returning();
    return { id: u.id, name: u.name, requestOnly: u.requestOnly === true, requestFormId: u.requestFormId, requestFormUseBase: u.requestFormUseBase, requestQuestions: u.requestQuestions };
  },
  async baseUsers(owner) {
    return db.select({ id: vendorServices.id, name: vendorServices.name, requestQuestions: vendorServices.requestQuestions, requestFormId: vendorServices.requestFormId })
      .from(vendorServices)
      .where(and(eq(vendorServices.businessId, owner.id), eq(vendorServices.requestFormUseBase, true)))
      .then((rows) => rows.filter((r) => !r.requestFormId));
  },
  async formUsers(owner, formId) {
    return db.select({ id: vendorServices.id, name: vendorServices.name }).from(vendorServices)
      .where(and(eq(vendorServices.businessId, owner.id), eq(vendorServices.requestFormId, formId)));
  },
};

const photographerSide: OwnerSide = {
  async resolve(req, res) {
    const o = await resolveRequestPhotographer(req, res);
    return o ? { kind: "photographer", id: o.photographer.id } : null;
  },
  async service(owner, id) {
    const svc = await storage.getPhotographerService(id);
    if (!svc || svc.photographerId !== owner.id) return null;
    return { id: svc.id, name: svc.name, requestOnly: svc.isContactForPricing === true, requestFormId: svc.requestFormId, requestFormUseBase: svc.requestFormUseBase, requestQuestions: svc.requestQuestions };
  },
  async saveService(owner, id, set) {
    const [u] = await db.update(photographerServices).set(set as any)
      .where(and(eq(photographerServices.id, id), eq(photographerServices.photographerId, owner.id))).returning();
    return { id: u.id, name: u.name, requestOnly: u.isContactForPricing === true, requestFormId: u.requestFormId, requestFormUseBase: u.requestFormUseBase, requestQuestions: u.requestQuestions };
  },
  async baseUsers(owner) {
    return db.select({ id: photographerServices.id, name: photographerServices.name, requestQuestions: photographerServices.requestQuestions, requestFormId: photographerServices.requestFormId })
      .from(photographerServices)
      .where(and(eq(photographerServices.photographerId, owner.id), eq(photographerServices.requestFormUseBase, true)))
      .then((rows) => rows.filter((r) => !r.requestFormId));
  },
  async formUsers(owner, formId) {
    return db.select({ id: photographerServices.id, name: photographerServices.name }).from(photographerServices)
      .where(and(eq(photographerServices.photographerId, owner.id), eq(photographerServices.requestFormId, formId)));
  },
};

const baseExistsMessage = (owner: FormOwner) =>
  owner.kind === "business" ? "This business already has a base form. Edit it instead." : "You already have a base form. Edit it instead.";

const ownerValues = (owner: FormOwner) =>
  owner.kind === "business" ? { businessId: owner.id, photographerId: null } : { businessId: null, photographerId: owner.id };

function registerLibrary(app: Express, side: OwnerSide, formsPath: string, servicesPath: string): void {
  // ── Library ──────────────────────────────────────────────────────────────────────────────────────────────
  app.get(formsPath, async (req, res) => {
    try {
      const owner = await side.resolve(req, res);
      if (!owner) return;
      const rows = await db.select().from(requestForms)
        .where(and(formOwnerWhere(owner), eq(requestForms.isActive, true)));
      rows.sort((a, b) => (a.isBase === b.isBase ? a.name.localeCompare(b.name) : a.isBase ? -1 : 1));
      return res.json({ forms: rows.map(toFormJson), baseFormId: rows.find((r) => r.isBase)?.id ?? null });
    } catch (err) {
      console.error("[request-forms] list failed:", err);
      return res.status(500).json({ error: "Failed to load forms" });
    }
  });

  app.post(formsPath, async (req, res) => {
    try {
      const owner = await side.resolve(req, res);
      if (!owner) return;
      const name = nameSchema.safeParse(req.body?.name);
      if (!name.success) return res.status(400).json({ error: "Invalid data", message: name.error.errors[0]?.message ?? "A form needs a name", field: "name" });
      const qs = normalizeQuestions(req.body?.questions ?? []);
      if (!qs.ok) return res.status(400).json({ error: "Invalid data", message: qs.message, field: "questions" });
      const isBase = req.body?.isBase === true;
      const existing = await db.select({ id: requestForms.id, isBase: requestForms.isBase }).from(requestForms)
        .where(and(formOwnerWhere(owner), eq(requestForms.isActive, true)));
      if (isBase && existing.some((r) => r.isBase)) {
        return res.status(409).json({ code: "BASE_EXISTS", message: baseExistsMessage(owner) });
      }
      if (existing.length >= MAX_FORMS) {
        return res.status(409).json({ code: "TOO_MANY_FORMS", message: owner.kind === "business" ? `A business can keep up to ${MAX_FORMS} forms.` : `You can keep up to ${MAX_FORMS} forms.` });
      }
      try {
        const [form] = await db.insert(requestForms).values({ ...ownerValues(owner), name: name.data, isBase, questions: qs.questions }).returning();
        return res.status(201).json({ form: toFormJson(form) });
      } catch (err: any) {
        // Two base forms created at the same moment: the unique index keeps one (either owner's index).
        const pgErr = err?.cause ?? err;
        if (pgErr?.code === "23505" && String(pgErr?.constraint ?? pgErr?.message ?? "").includes("uq_request_forms_one_base")) {
          return res.status(409).json({ code: "BASE_EXISTS", message: baseExistsMessage(owner) });
        }
        throw err;
      }
    } catch (err) {
      console.error("[request-forms] create failed:", err);
      return res.status(500).json({ error: "Failed to save the form" });
    }
  });

  app.patch(`${formsPath}/:id`, async (req, res) => {
    try {
      const owner = await side.resolve(req, res);
      if (!owner) return;
      const [form] = await db.select().from(requestForms).where(eq(requestForms.id, req.params.id));
      if (!form || !formBelongsTo(form, owner) || !form.isActive) return res.status(404).json({ error: "Form not found" });
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
          const users = await side.baseUsers(owner);
          const tooBig = users.filter((svc) => !checkResolvedLimits(resolveServiceForm({
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
        .where(and(eq(requestForms.id, form.id), formOwnerWhere(owner))).returning();
      return res.json({ form: toFormJson(updated) });
    } catch (err) {
      console.error("[request-forms] update failed:", err);
      return res.status(500).json({ error: "Failed to save the form" });
    }
  });

  app.delete(`${formsPath}/:id`, async (req, res) => {
    try {
      const owner = await side.resolve(req, res);
      if (!owner) return;
      const [form] = await db.select().from(requestForms).where(eq(requestForms.id, req.params.id));
      if (!form || !formBelongsTo(form, owner) || !form.isActive) return res.status(404).json({ error: "Form not found" });
      if (form.isBase) return res.status(409).json({ code: "BASE_FORM", message: "The base form can't be removed. Edit its questions instead." });
      const using = await side.formUsers(owner, form.id);
      if (using.length > 0) {
        return res.status(409).json({ code: "FORM_IN_USE", message: "Some services use this form. Choose another form for them first.", services: using });
      }
      // One statement, so a service can't start using the form between the check above and the removal.
      const removed = await db.update(requestForms).set({ isActive: false, updatedAt: new Date() })
        .where(and(
          eq(requestForms.id, form.id),
          sql`NOT EXISTS (SELECT 1 FROM vendor_services s WHERE s.request_form_id = ${form.id})`,
          sql`NOT EXISTS (SELECT 1 FROM photographer_services p WHERE p.request_form_id = ${form.id})`,
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
  app.get(`${servicesPath}/:id/request-form`, async (req, res) => {
    try {
      const owner = await side.resolve(req, res);
      if (!owner) return;
      const svc = await side.service(owner, req.params.id);
      if (!svc) return res.status(404).json({ error: "Service not found" });
      return res.json({ settings: settingsJson(svc), resolved: await loadFormQuestions(owner, svc) });
    } catch (err) {
      console.error("[request-forms] service settings failed:", err);
      return res.status(500).json({ error: "Failed to load the service form" });
    }
  });

  app.put(`${servicesPath}/:id/request-form`, async (req, res) => {
    try {
      const owner = await side.resolve(req, res);
      if (!owner) return;
      const svc = await side.service(owner, req.params.id);
      if (!svc) return res.status(404).json({ error: "Service not found" });
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
        if (!form || !formBelongsTo(form, owner) || !form.isActive || form.isBase) {
          return res.status(400).json({ error: "Invalid data", message: "Choose a saved form from your library", field: "formId" });
        }
      }
      if (formId === null) {
        const [base] = useBase
          ? await db.select().from(requestForms).where(and(formOwnerWhere(owner), eq(requestForms.isBase, true), eq(requestForms.isActive, true)))
          : [];
        const limits = checkResolvedLimits(resolveServiceForm({
          savedForm: null, base: base ? (base.questions as RequestQuestion[]) : null, useBase, own: qs.questions,
        }));
        if (!limits.ok) return res.status(400).json({ error: "Invalid data", message: limits.message, field: "questions" });
      }
      const updated = await side.saveService(owner, svc.id, {
        requestFormId: formId, requestFormUseBase: formId === null ? useBase : false, requestQuestions: formId === null ? qs.questions : [],
      });
      return res.json({ settings: settingsJson(updated), resolved: await loadFormQuestions(owner, updated) });
    } catch (err) {
      console.error("[request-forms] service settings save failed:", err);
      return res.status(500).json({ error: "Failed to save the service form" });
    }
  });
}

export function registerRequestFormRoutes(app: Express): void {
  registerLibrary(app, businessSide, "/api/vendor/request-forms", "/api/vendor/services");
  registerLibrary(app, photographerSide, "/api/photographers/me/request-forms", "/api/photographers/me/services");

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

  // F2: a photographer's contact for pricing service. Photographers have no city list, so no city is asked.
  app.get("/api/photographer-services/:id/request-form", async (req, res) => {
    try {
      const found = await requestablePhotographerService(req.params.id);
      if (!found) return res.status(404).json({ error: "This service doesn't take requests" });
      const { svc, photographer } = found;
      return res.json({
        service: { id: svc.id, name: svc.name, description: svc.description, price: null },
        photographer: { id: photographer.id, name: photographer.displayName.trim() },
        business: null,
        vendor: { type: "photographer", id: photographer.id, name: photographer.displayName.trim() },
        cities: [],
        cityRequired: false,
        phoneRequired: true,
        questions: await loadPhotographerResolvedForm(svc),
      });
    } catch (err) {
      console.error("[request-forms] public photographer form failed:", err);
      return res.status(500).json({ error: "Failed to load the form" });
    }
  });

  app.get("/api/me/requests", async (req, res) => {
    try {
      const userId = (req.session as any)?.userId || getUserIdFromRequest(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const rows = await db.select().from(estimateRequests).where(eq(estimateRequests.customerId, userId))
        .orderBy(desc(estimateRequests.createdAt)).limit(200);
      const nameOf = await vendorNames(rows);
      return res.json({ requests: rows.map((r) => toCustomerJson(r, nameOf(r))) });
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
      const business = r.businessId ? await storage.getBusiness(r.businessId) : undefined;
      const photographer = r.photographerId ? await storage.getPhotographer(r.photographerId) : undefined;
      const vendorName = business?.name ?? photographer?.displayName ?? null;
      const user = await storage.getUser(userId);
      const isAdmin = ADMIN_EMAILS.includes((user?.email ?? "").toLowerCase());
      const isOwner = (!!business && business.ownerId === userId) || (!!photographer && photographer.userId === userId);
      if (isOwner || isAdmin) {
        return res.json({
          request: {
            ...toCustomerJson(r, vendorName),
            customerId: r.customerId,
            customerName: r.customerName,
            customerEmail: r.customerEmail,
            customerPhone: r.customerPhone,
            vendorNotes: r.vendorNotes,
            source: r.source,
          },
        });
      }
      if (r.customerId === userId) return res.json({ request: toCustomerJson(r, vendorName) });
      // Anyone else gets the same answer as a request that doesn't exist.
      return res.status(404).json({ error: "Request not found" });
    } catch (err) {
      console.error("[request-forms] request detail failed:", err);
      return res.status(500).json({ error: "Failed to load the request" });
    }
  });
}

/** Names of the businesses and photographers a list of requests is to (two queries at most). */
async function vendorNames(rows: EstimateRequest[]): Promise<(r: EstimateRequest) => string | null> {
  const bizIds = Array.from(new Set(rows.map((r) => r.businessId).filter((v): v is string => !!v)));
  const phIds = Array.from(new Set(rows.map((r) => r.photographerId).filter((v): v is string => !!v)));
  const biz = bizIds.length ? await db.select({ id: businesses.id, name: businesses.name }).from(businesses).where(inArray(businesses.id, bizIds)) : [];
  const ph = phIds.length ? await db.select({ id: photographers.id, name: photographers.displayName }).from(photographers).where(inArray(photographers.id, phIds)) : [];
  const b = new Map(biz.map((x) => [x.id, x.name]));
  const p = new Map(ph.map((x) => [x.id, x.name]));
  return (r) => (r.businessId ? b.get(r.businessId) : r.photographerId ? p.get(r.photographerId) : undefined) ?? null;
}
