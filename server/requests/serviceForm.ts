/**
 * Loads the questions a customer answers for one request only service (migration 096). Shared by the request
 * form routes and POST /api/estimate-requests, kept apart so neither imports the other.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { requestForms, type VendorService } from "@shared/schema";
import { resolveServiceForm, type RequestQuestion } from "./requestForms";

/** The questions a customer answers for this service (empty = contact details only). */
export async function loadResolvedForm(service: Pick<VendorService, "businessId" | "requestFormId" | "requestFormUseBase" | "requestQuestions">): Promise<RequestQuestion[]> {
  const rows = await db.select().from(requestForms).where(and(eq(requestForms.businessId, service.businessId), eq(requestForms.isActive, true)));
  const base = rows.find((r) => r.isBase) ?? null;
  const saved = service.requestFormId ? rows.find((r) => r.id === service.requestFormId && !r.isBase) ?? null : null;
  return resolveServiceForm({
    savedForm: saved ? (saved.questions as RequestQuestion[]) : null,
    base: base ? (base.questions as RequestQuestion[]) : null,
    useBase: service.requestFormUseBase === true,
    own: (service.requestQuestions ?? []) as RequestQuestion[],
  });
}

