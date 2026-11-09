/**
 * Loads the questions a customer answers for one request only service (migration 096; photographers migration
 * 108). Shared by the request form routes and POST /api/estimate-requests, kept apart so neither imports the other.
 *
 * Call 9 (Legend 2026-11-09): a service with nothing set (no saved form, base form off, no own questions) uses the
 * base form when one exists, the same way the app's picker already shows it. With no base form it asks no questions.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { requestForms, type PhotographerService, type VendorService } from "@shared/schema";
import { resolveServiceForm, type RequestQuestion } from "./requestForms";

/** Whose library a form or request belongs to. */
export type FormOwner = { kind: "business"; id: string } | { kind: "photographer"; id: string };

/** The where clause for one owner's rows (forms here; the same columns exist on estimate_requests). */
export function formOwnerWhere(owner: FormOwner) {
  return owner.kind === "business" ? eq(requestForms.businessId, owner.id) : eq(requestForms.photographerId, owner.id);
}

/** Does this form row belong to this owner? */
export function formBelongsTo(form: { businessId: string | null; photographerId: string | null }, owner: FormOwner): boolean {
  return owner.kind === "business"
    ? form.businessId === owner.id && !form.photographerId
    : form.photographerId === owner.id && !form.businessId;
}

export type ServiceFormSettings = {
  requestFormId: string | null;
  requestFormUseBase: boolean | null;
  requestQuestions: unknown;
};

/** True when the service has no form choice saved at all (call 9). */
export function nothingSet(s: ServiceFormSettings): boolean {
  const own = Array.isArray(s.requestQuestions) ? s.requestQuestions : [];
  return !s.requestFormId && s.requestFormUseBase !== true && own.length === 0;
}

/** The questions a customer answers for a service of this owner (empty = contact details only). */
export async function loadFormQuestions(owner: FormOwner, s: ServiceFormSettings): Promise<RequestQuestion[]> {
  const rows = await db.select().from(requestForms).where(and(formOwnerWhere(owner), eq(requestForms.isActive, true)));
  const base = rows.find((r) => r.isBase) ?? null;
  const saved = s.requestFormId ? rows.find((r) => r.id === s.requestFormId && !r.isBase) ?? null : null;
  return resolveServiceForm({
    savedForm: saved ? (saved.questions as RequestQuestion[]) : null,
    base: base ? (base.questions as RequestQuestion[]) : null,
    useBase: s.requestFormUseBase === true || (nothingSet(s) && !!base),
    own: (Array.isArray(s.requestQuestions) ? s.requestQuestions : []) as RequestQuestion[],
  });
}

/** A business service's questions. */
export async function loadResolvedForm(service: Pick<VendorService, "businessId" | "requestFormId" | "requestFormUseBase" | "requestQuestions">): Promise<RequestQuestion[]> {
  return loadFormQuestions({ kind: "business", id: service.businessId }, service);
}

/** A photographer service's questions (migration 108). */
export async function loadPhotographerResolvedForm(service: Pick<PhotographerService, "photographerId" | "requestFormId" | "requestFormUseBase" | "requestQuestions">): Promise<RequestQuestion[]> {
  return loadFormQuestions({ kind: "photographer", id: service.photographerId }, service);
}
