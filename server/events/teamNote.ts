/**
 * Event Team note (p4-team step 9d, Legend's calls 25 and 79 to 83, 2026-10-31): the short note a team member accepts
 * to be paid through Outsyde. Same pattern as the Event Host Agreement (hostAgreement.ts, migration 069).
 *
 *   GET  /api/events/team-note          (auth) the current version's text + whether I accepted it
 *   POST /api/events/team-note/accept   (auth) { version } accept the current version (idempotent)
 *
 * Joining a team never needs it (call 81). Being paid through Outsyde does: teamSend.ts memberReadySql is Stripe
 * payout setup AND the current note, checked when the payout is worked out (payout day). Not both by then: the host
 * pays them (call 80). Table: migrations/093_event_team_note_acceptances.sql. One row per (user, version), never
 * updated or deleted. A wording change ships with a new TEAM_NOTE_VERSION, so everyone accepts the new text again.
 * Copy rule: no dashes, never a fee percentage.
 */
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { rows, iso, fail, loadActiveUser } from "./eventsRouter";

export const TEAM_NOTE_VERSION = "2026-11-01";
export const TEAM_NOTE_TITLE = "Event Team note";
export const TEAM_NOTE_INTRO = "Read and accept to be paid through Outsyde.";
/** Call 82: the six points, in this order. */
export const TEAM_NOTE_POINTS: readonly string[] = [
  "Outsyde pays you for an event only if your payouts are set up and you've accepted this note by payout day, 3 days after the event. If not, the host pays you directly.",
  "If ticket sales don't cover the team, Outsyde pays the team nothing and the host pays you directly.",
  "Outsyde isn't your employer. Your work and your pay are between you and the host.",
  "Stripe may send you tax forms for what you're paid.",
  "Outsyde may hold your pay while it checks a payout. Pay already sent to you is never taken back.",
  "If the host takes you off the team before the event ends, you aren't paid for it, and you'll see why.",
];

/** SQL condition: this user accepted the current version. Part of teamSend.ts memberReadySql. */
export const noteAcceptedSql = (userId: ReturnType<typeof sql> | string) => sql`EXISTS (
  SELECT 1 FROM event_team_note_acceptances na WHERE na.user_id = ${userId} AND na.version = ${TEAM_NOTE_VERSION})`;

export async function noteAcceptanceOf(userId: string): Promise<{ version: string; acceptedAt: string | null } | null> {
  const [a] = await rows<any>(sql`
    SELECT version, accepted_at FROM event_team_note_acceptances
    WHERE user_id = ${userId} AND version = ${TEAM_NOTE_VERSION} LIMIT 1`);
  return a ? { version: String(a.version), acceptedAt: iso(a.accepted_at) } : null;
}

const router = Router();
const acceptSchema = z.object({ version: z.string().trim().min(1).max(64) }).strict();

const noteJson = (accepted: { version: string; acceptedAt: string | null } | null) => ({
  version: TEAM_NOTE_VERSION,
  title: TEAM_NOTE_TITLE,
  intro: TEAM_NOTE_INTRO,
  points: [...TEAM_NOTE_POINTS],
  accepted: accepted !== null,
  acceptedAt: accepted?.acceptedAt ?? null,
});

router.get("/team-note", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to read the Event Team note.");
  try {
    return res.json({ success: true, note: noteJson(await noteAcceptanceOf(userId)) });
  } catch (err) {
    console.error("[Events] team note read failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load the Event Team note.");
  }
});

router.post("/team-note/accept", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to accept the Event Team note.");
  const parsed = acceptSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "INVALID_NOTE", "Send the note version you read.");
  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't accept the Event Team note.");
    // Accepting an older text is refused: the member reads the version that is current now.
    if (parsed.data.version !== TEAM_NOTE_VERSION) {
      return fail(res, 409, "NOTE_VERSION_CHANGED", "The Event Team note was updated. Read the new version to continue.");
    }
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : null;
    // Idempotent: a second accept keeps the first time (the record of when consent was given).
    await rows(sql`
      INSERT INTO event_team_note_acceptances (user_id, version, user_agent)
      VALUES (${userId}, ${TEAM_NOTE_VERSION}, ${ua})
      ON CONFLICT (user_id, version) DO NOTHING`);
    const accepted = await noteAcceptanceOf(userId);
    if (!accepted) return fail(res, 500, "SERVER_ERROR", "Couldn't save your acceptance.");
    return res.json({ success: true, note: noteJson(accepted) });
  } catch (err) {
    console.error("[Events] team note accept failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't save your acceptance.");
  }
});

export default router;
