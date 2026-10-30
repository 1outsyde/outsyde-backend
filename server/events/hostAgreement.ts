/**
 * Event Host Agreement: hosts read it to the end and accept it before their first event can be published.
 *
 *   GET  /api/events/host-agreement          (auth) the current version's text + whether I accepted it
 *   POST /api/events/host-agreement/accept   (auth) { version } accept the current version (idempotent)
 *
 * POST /api/events/:id/publish refuses with 409 HOST_AGREEMENT_REQUIRED until the publishing user has accepted
 * HOST_AGREEMENT_VERSION (eventsRouter.ts). The person who publishes accepts, also when hosting as a business or
 * photographer profile (Agreement 3.1: they confirm they can bind it).
 *
 * Table: migrations/069_host_agreement_acceptances.sql. One row per (user, version), never updated or deleted.
 * A wording change ships with a new HOST_AGREEMENT_VERSION, so every host accepts the new text before publishing again.
 */
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { rows, iso, fail, loadActiveUser } from "./eventsRouter";
import { HOST_AGREEMENT_MARKDOWN } from "./hostAgreementText";

export const HOST_AGREEMENT_VERSION = "2026-10-30";
export const HOST_AGREEMENT_TITLE = "Outsyde Event Host Agreement";
export const HOST_AGREEMENT_TEXT = HOST_AGREEMENT_MARKDOWN.replace("\\[VERSION\\]", HOST_AGREEMENT_VERSION);

/** SQL condition: this user accepted the current version. Used inside the publish UPDATE so the check and the change are one statement. */
export const acceptedCurrentVersionSql = (userId: string) => sql`EXISTS (
  SELECT 1 FROM host_agreement_acceptances a WHERE a.user_id = ${userId} AND a.version = ${HOST_AGREEMENT_VERSION})`;

export async function acceptanceOf(userId: string): Promise<{ version: string; acceptedAt: string | null } | null> {
  const [a] = await rows<any>(sql`
    SELECT version, accepted_at FROM host_agreement_acceptances
    WHERE user_id = ${userId} AND version = ${HOST_AGREEMENT_VERSION} LIMIT 1`);
  return a ? { version: String(a.version), acceptedAt: iso(a.accepted_at) } : null;
}

const router = Router();
const acceptSchema = z.object({ version: z.string().trim().min(1).max(64) }).strict();

const agreementJson = (accepted: { version: string; acceptedAt: string | null } | null) => ({
  version: HOST_AGREEMENT_VERSION,
  title: HOST_AGREEMENT_TITLE,
  format: "markdown" as const,
  text: HOST_AGREEMENT_TEXT,
  accepted: accepted !== null,
  acceptedVersion: accepted?.version ?? null,
  acceptedAt: accepted?.acceptedAt ?? null,
});

router.get("/host-agreement", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to read the Event Host Agreement.");
  try {
    return res.json({ success: true, agreement: agreementJson(await acceptanceOf(userId)) });
  } catch (err) {
    console.error("[Events] host agreement read failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load the Event Host Agreement.");
  }
});

router.post("/host-agreement/accept", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to accept the Event Host Agreement.");
  const parsed = acceptSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "INVALID_AGREEMENT", "Send the agreement version you read.");
  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events.");
    // Accepting an older text is refused: the host has to read the version that is current now.
    if (parsed.data.version !== HOST_AGREEMENT_VERSION) {
      return fail(res, 409, "AGREEMENT_VERSION_CHANGED", "The Event Host Agreement was updated. Read the new version to continue.");
    }
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : null;
    // Idempotent: a second accept keeps the first time (the record of when consent was given).
    await rows(sql`
      INSERT INTO host_agreement_acceptances (user_id, version, user_agent)
      VALUES (${userId}, ${HOST_AGREEMENT_VERSION}, ${ua})
      ON CONFLICT (user_id, version) DO NOTHING`);
    const accepted = await acceptanceOf(userId);
    if (!accepted) return fail(res, 500, "SERVER_ERROR", "Couldn't save your acceptance.");
    return res.json({ success: true, agreement: agreementJson(accepted) });
  } catch (err) {
    console.error("[Events] host agreement accept failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't save your acceptance.");
  }
});

export default router;
