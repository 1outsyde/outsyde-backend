/**
 * Events door check-in: door team management (Task 2).
 *
 *   GET    /api/events/door/mine                 (auth)       events I can scan: published, not ended
 *   GET    /api/events/:id/door/team             (auth, host) standing + this event's door team
 *   POST   /api/events/:id/door/team             (auth, host) add by username, scope standing | event
 *   DELETE /api/events/:id/door/team/:userId     (auth, host) ?scope=standing|event, soft remove
 *
 * Non-hosts get 404 EVENT_NOT_FOUND on the host-only routes (no existence leak). Members are returned with
 * first name and username only, never an email.
 */
import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { rows, iso, fail, pgError } from "./eventsRouter";
import { loadEventForDoor } from "./doorAccess";
import { notifyDoorTeamAdded } from "./ticketNotices";

const router = Router();

const scopeSchema = z.enum(["standing", "event"]);
const addSchema = z.object({ username: z.string().trim().min(1).max(40), scope: scopeSchema }).strict();
const validId = (v: string) => v.length > 0 && v.length <= 36;

const memberJson = (r: any) => ({
  userId: String(r.user_id), firstName: r.first_name ?? null, username: r.username ?? null, addedAt: iso(r.added_at),
});

/** The host of this event, or null (and the caller answers 404 EVENT_NOT_FOUND). */
async function hostOnly(req: Request, res: Response): Promise<{ userId: string; event: any } | null> {
  const userId = getUserIdFromRequest(req);
  const eventId = String(req.params.id);
  if (!userId) { fail(res, 401, "UNAUTHORIZED", "Sign in to continue."); return null; }
  const access = validId(eventId) ? await loadEventForDoor(eventId, userId) : null;
  if (!access || access.role !== "host") { fail(res, 404, "EVENT_NOT_FOUND", "Event not found."); return null; }
  return { userId, event: access.event };
}

router.get("/door/mine", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return fail(res, 401, "UNAUTHORIZED", "Sign in to continue.");
    const list = await rows<any>(sql`
      SELECT e.id, e.slug, e.title, e.starts_at, e.ends_at, e.timezone,
        CASE WHEN e.host_user_id = u.id THEN 'host'
             WHEN EXISTS (SELECT 1 FROM event_door_team t WHERE t.host_user_id = e.host_user_id AND t.member_user_id = u.id AND t.removed_at IS NULL) THEN 'standing'
             ELSE 'event' END AS role
      FROM events e
      JOIN users u ON u.id = ${userId} AND u.is_active = true AND COALESCE(u.deletion_status, 'active') = 'active'
      WHERE e.status = 'published' AND e.ends_at > now()
        AND (e.host_user_id = u.id
          OR EXISTS (SELECT 1 FROM event_door_team t WHERE t.host_user_id = e.host_user_id AND t.member_user_id = u.id AND t.removed_at IS NULL)
          OR EXISTS (SELECT 1 FROM event_door_members m WHERE m.event_id = e.id AND m.member_user_id = u.id AND m.removed_at IS NULL))
      ORDER BY e.starts_at, e.id`);
    res.json({
      success: true,
      events: list.map((e) => ({
        id: e.id, slug: e.slug, title: e.title, startsAt: iso(e.starts_at), endsAt: iso(e.ends_at), timezone: e.timezone, role: e.role,
      })),
    });
  } catch (err) {
    console.error("[Door] mine failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load your door events.");
  }
});

router.get("/:id/door/team", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const ctx = await hostOnly(req, res);
    if (!ctx) return;
    const standing = await rows<any>(sql`
      SELECT u.id AS user_id, u.first_name, u.username, t.created_at AS added_at
      FROM event_door_team t JOIN users u ON u.id = t.member_user_id
      WHERE t.host_user_id = ${ctx.userId} AND t.removed_at IS NULL ORDER BY t.created_at, u.id`);
    const event = await rows<any>(sql`
      SELECT u.id AS user_id, u.first_name, u.username, m.created_at AS added_at
      FROM event_door_members m JOIN users u ON u.id = m.member_user_id
      WHERE m.event_id = ${ctx.event.id} AND m.removed_at IS NULL ORDER BY m.created_at, u.id`);
    res.json({ success: true, standing: standing.map(memberJson), event: event.map(memberJson) });
  } catch (err) {
    console.error("[Door] team list failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load the door team.");
  }
});

router.post("/:id/door/team", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const ctx = await hostOnly(req, res);
    if (!ctx) return;
    const parsed = addSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return fail(res, 400, "INVALID_REQUEST", `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}`);
    }
    const { username, scope } = parsed.data;
    const [target] = await rows<any>(sql`
      SELECT id, first_name, username FROM users
      WHERE LOWER(username) = LOWER(${username}) AND is_active = true AND COALESCE(deletion_status, 'active') = 'active'`);
    if (!target) return fail(res, 404, "USER_NOT_FOUND", "No active account has that username.");
    if (target.id === ctx.userId) return fail(res, 400, "CANNOT_ADD_SELF", "You already have full access to your own events.");
    let added: any;
    try {
      [added] = scope === "standing"
        ? await rows<any>(sql`
            INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id)
            VALUES (${ctx.userId}, ${target.id}, ${ctx.userId})
            ON CONFLICT (host_user_id, member_user_id) WHERE removed_at IS NULL DO NOTHING
            RETURNING created_at`)
        : await rows<any>(sql`
            INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id)
            VALUES (${ctx.event.id}, ${target.id}, ${ctx.userId})
            ON CONFLICT (event_id, member_user_id) WHERE removed_at IS NULL DO NOTHING
            RETURNING created_at`);
    } catch (err) {
      if (pgError(err).code === "23505") added = undefined; else throw err;
    }
    if (!added) return fail(res, 409, "ALREADY_ON_TEAM", "They are already on your door team.");
    notifyDoorTeamAdded({ userId: target.id, scope, eventId: ctx.event.id }).catch(() => {});
    res.status(201).json({
      success: true, scope,
      member: memberJson({ user_id: target.id, first_name: target.first_name, username: target.username, added_at: added.created_at }),
    });
  } catch (err) {
    console.error("[Door] team add failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not add to the door team.");
  }
});

router.delete("/:id/door/team/:userId", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const ctx = await hostOnly(req, res);
    if (!ctx) return;
    const scope = scopeSchema.safeParse(req.query.scope);
    if (!scope.success) return fail(res, 400, "INVALID_REQUEST", "scope: choose standing or event.");
    const memberId = String(req.params.userId);
    if (!validId(memberId)) return fail(res, 404, "NOT_ON_TEAM", "That person isn't on your door team.");
    const done = scope.data === "standing"
      ? await rows<any>(sql`
          UPDATE event_door_team SET removed_at = now()
          WHERE host_user_id = ${ctx.userId} AND member_user_id = ${memberId} AND removed_at IS NULL RETURNING id`)
      : await rows<any>(sql`
          UPDATE event_door_members SET removed_at = now()
          WHERE event_id = ${ctx.event.id} AND member_user_id = ${memberId} AND removed_at IS NULL RETURNING id`);
    if (!done.length) return fail(res, 404, "NOT_ON_TEAM", "That person isn't on your door team.");
    res.json({ success: true, removed: true });
  } catch (err) {
    console.error("[Door] team remove failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not remove from the door team.");
  }
});

export default router;
