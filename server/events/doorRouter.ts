/**
 * Events door check-in: door team management (Task 2).
 *
 *   GET    /api/events/door/mine                 (auth)       events I can scan: published, not ended
 *   GET    /api/events/:id/door/team             (auth, host) standing + this event's door team
 *   POST   /api/events/:id/door/team             (auth, host) add by username, scope standing | event
 *   DELETE /api/events/:id/door/team/:userId     (auth, host) ?scope=standing|event, soft remove
 *
 *   POST   /api/events/:id/door/check-in         (auth, door)  { code } check a guest in
 *   POST   /api/events/:id/door/check-in-ticket  (auth, door)  { ticketId } same, from a guest list tap
 *   POST   /api/events/:id/door/undo             (auth, host)  { ticketId } clear a check in
 *   GET    /api/events/:id/door/guests           (auth, door)  valid tickets, checked in count, no money or contact fields
 *
 * Non-hosts get 404 EVENT_NOT_FOUND on the host-only routes (no existence leak). Members are returned with
 * first name and username only, never an email.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { rows, iso, fail, pgError } from "./eventsRouter";
import { loadEventForDoor, isWithinScanWindow } from "./doorAccess";
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

// ─── Check in, undo, guest list (Task 3) ────────────────────────────────────

/**
 * 120 per minute per signed in user (never per IP: a whole door team can share one venue wifi address).
 * Tests may lower it through DOOR_RATE_LIMIT_PER_MIN, read once at load, only outside production AND with
 * ALLOW_TEST_SEAMS=1. In any other setup the limit is exactly 120.
 */
const DOOR_LIMIT = (() => {
  if (process.env.NODE_ENV !== "production" && process.env.ALLOW_TEST_SEAMS === "1") {
    const n = Number(process.env.DOOR_RATE_LIMIT_PER_MIN);
    if (Number.isInteger(n) && n > 0 && n < 120) return n;
  }
  return 120;
})();
const doorLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: DOOR_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getUserIdFromRequest(req as Request) ?? "anonymous",
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => { fail(res, 429, "RATE_LIMITED", "Too many scans. Wait a moment and try again."); },
});

const codeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{16}$/, "code: expected the 16 character ticket code"),
}).strict();
const ticketIdSchema = z.object({ ticketId: z.string().trim().min(1).max(36) }).strict();

type TicketKey = { by: "code"; code: string } | { by: "id"; ticketId: string };
const keyMatch = (k: TicketKey) => (k.by === "code" ? sql`t.code = ${k.code}` : sql`t.id = ${k.ticketId}`);

const guestJson = (r: any) => ({
  ticketId: String(r.ticket_id), firstName: r.first_name ?? null, username: r.username ?? null,
  ticketTypeName: r.ticket_type_name, checkedInAt: iso(r.checked_in_at), checkedInBy: r.checked_in_by ?? null,
});

/** Columns shared by every GuestTicket read. Scanner name = first name, else username. */
const GUEST_COLUMNS = sql`
  t.id AS ticket_id, h.first_name, h.username, tt.name AS ticket_type_name, t.checked_in_at,
  COALESCE(NULLIF(btrim(s.first_name), ''), s.username) AS checked_in_by`;
const GUEST_JOINS = sql`
  JOIN users h ON h.id = t.holder_user_id
  JOIN ticket_types tt ON tt.id = t.ticket_type_id
  LEFT JOIN users s ON s.id = t.checked_in_by_user_id`;

async function guestTicket(ticketId: string): Promise<any> {
  const [r] = await rows<any>(sql`SELECT ${GUEST_COLUMNS} FROM tickets t ${GUEST_JOINS} WHERE t.id = ${ticketId}`);
  return r ? guestJson(r) : null;
}

/** The door user for this event, or null after answering 401 / 404 EVENT_NOT_FOUND. */
async function doorUser(req: Request, res: Response, hostRequired = false): Promise<{ userId: string; event: any; role: string } | null> {
  const userId = getUserIdFromRequest(req);
  const eventId = String(req.params.id);
  if (!userId) { fail(res, 401, "UNAUTHORIZED", "Sign in to continue."); return null; }
  const access = validId(eventId) ? await loadEventForDoor(eventId, userId) : null;
  if (!access || (hostRequired && access.role !== "host")) { fail(res, 404, "EVENT_NOT_FOUND", "Event not found."); return null; }
  return { userId, event: access.event, role: access.role };
}

/**
 * One atomic statement. The scan window here (published, starts_at minus 6 hours <= now() <= ends_at) is the
 * SQL twin of isWithinScanWindow in doorAccess.ts; classifyFailedCheckIn below re-checks with that function.
 * Keep the two in step: the "window edges" tests in doorCheckin.http.test.ts cover both through the route.
 */
async function checkInUpdate(eventId: string, key: TicketKey, scannerId: string): Promise<any | null> {
  const [r] = await rows<any>(sql`
    WITH u AS (
      UPDATE tickets t SET checked_in_at = now(), checked_in_by_user_id = ${scannerId}
      FROM ticket_orders o, events e
      WHERE ${keyMatch(key)} AND t.event_id = ${eventId} AND t.status = 'valid' AND t.checked_in_at IS NULL
        AND o.id = t.order_id AND o.status = 'completed'
        AND e.id = t.event_id AND e.status = 'published'
        AND now() >= e.starts_at - interval '6 hours' AND now() <= e.ends_at
      RETURNING t.id, t.holder_user_id, t.ticket_type_id, t.checked_in_at, t.checked_in_by_user_id
    )
    SELECT ${GUEST_COLUMNS} FROM u t ${GUEST_JOINS}`);
  return r ? guestJson(r) : null;
}

/** The update changed nothing: say why. Same JSON for "no such ticket" and "ticket of an event you can't see". */
async function classifyFailedCheckIn(res: Response, eventId: string, key: TicketKey, scannerId: string) {
  const notFound = () => fail(res, 404, "NOT_FOUND", "No ticket found for that code.");
  // Fresh read, so a member removed or an event ended during this very call is handled.
  const access = await loadEventForDoor(eventId, scannerId);
  if (!access) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
  // Twin of the window in checkInUpdate's SQL (doorAccess.isWithinScanWindow is the source of truth).
  if (!isWithinScanWindow(access.event, new Date())) {
    return fail(res, 409, "CHECKIN_CLOSED", "Check in isn't open for this event right now.");
  }
  const [t] = await rows<any>(sql`
    SELECT t.id, t.event_id, t.status, t.checked_in_at, o.status AS order_status
    FROM tickets t JOIN ticket_orders o ON o.id = t.order_id WHERE ${keyMatch(key)}`);
  if (!t) return notFound();
  if (t.event_id !== eventId) {
    const other = await loadEventForDoor(t.event_id, scannerId);
    if (!other) return notFound();
    return res.status(409).json({
      success: false,
      error: { code: "WRONG_EVENT", message: `This ticket is for ${other.event.title}.` },
      otherEvent: { id: other.event.id, title: other.event.title },
    });
  }
  // Refunded or cancelled wins over "already checked in": a refunded guest must be turned away.
  if (t.status !== "valid" || t.order_status !== "completed") {
    return fail(res, 409, "NOT_VALID", "This ticket is not valid. It was refunded or cancelled.");
  }
  if (t.checked_in_at) {
    return res.status(409).json({
      success: false,
      error: { code: "ALREADY_CHECKED_IN", message: "Already checked in." },
      ticket: await guestTicket(t.id),
    });
  }
  // Valid and unscanned yet the update missed it: the window moved by a hair between the two reads. Try again.
  return fail(res, 409, "CHECKIN_CLOSED", "Check in isn't open for this event right now.");
}

async function handleCheckIn(req: Request, res: Response, parse: (body: unknown) => TicketKey | null) {
  try {
    const ctx = await doorUser(req, res);
    if (!ctx) return;
    const key = parse(req.body ?? {});
    if (!key) return fail(res, 400, "INVALID_CODE", "That isn't a valid ticket code.");
    const ticket = await checkInUpdate(ctx.event.id, key, ctx.userId);
    if (ticket) return res.json({ success: true, result: "checked_in", ticket });
    return await classifyFailedCheckIn(res, ctx.event.id, key, ctx.userId);
  } catch (err) {
    console.error("[Door] check-in failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not check in.");
  }
}

router.post("/:id/door/check-in", hybridAuthMiddleware, doorLimiter, (req: Request, res: Response) =>
  handleCheckIn(req, res, (body) => {
    const p = codeSchema.safeParse(body);
    return p.success ? { by: "code", code: p.data.code } : null;
  }));

router.post("/:id/door/check-in-ticket", hybridAuthMiddleware, doorLimiter, (req: Request, res: Response) =>
  handleCheckIn(req, res, (body) => {
    const p = ticketIdSchema.safeParse(body);
    return p.success ? { by: "id", ticketId: p.data.ticketId } : null;
  }));

router.post("/:id/door/undo", hybridAuthMiddleware, doorLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = await doorUser(req, res, true);
    if (!ctx) return;
    const p = ticketIdSchema.safeParse(req.body ?? {});
    if (!p.success) return fail(res, 400, "INVALID_REQUEST", "ticketId: required.");
    // Works whatever the ticket's status now is (a refunded guest who was checked in can still be corrected).
    const [done] = await rows<any>(sql`
      WITH u AS (
        UPDATE tickets t SET checked_in_at = NULL, checked_in_by_user_id = NULL
        WHERE t.id = ${p.data.ticketId} AND t.event_id = ${ctx.event.id} AND t.checked_in_at IS NOT NULL
        RETURNING t.id, t.holder_user_id, t.ticket_type_id, t.checked_in_at, t.checked_in_by_user_id
      )
      SELECT ${GUEST_COLUMNS} FROM u t ${GUEST_JOINS}`);
    if (done) return res.json({ success: true, ticket: guestJson(done) });
    const [exists] = await rows<any>(sql`SELECT 1 AS x FROM tickets WHERE id = ${p.data.ticketId} AND event_id = ${ctx.event.id}`);
    if (!exists) return fail(res, 404, "NOT_FOUND", "No ticket found.");
    return fail(res, 409, "NOT_CHECKED_IN", "That ticket isn't checked in.");
  } catch (err) {
    console.error("[Door] undo failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not undo the check in.");
  }
});

router.get("/:id/door/guests", hybridAuthMiddleware, doorLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = await doorUser(req, res);
    if (!ctx) return;
    const list = await rows<any>(sql`
      SELECT ${GUEST_COLUMNS}
      FROM tickets t
      JOIN ticket_orders o ON o.id = t.order_id AND o.status = 'completed'
      ${GUEST_JOINS}
      WHERE t.event_id = ${ctx.event.id} AND t.status = 'valid'
      ORDER BY lower(COALESCE(h.first_name, '')), lower(COALESCE(h.username, '')), t.id`);
    const guests = list.map(guestJson);
    res.json({ success: true, checkedIn: guests.filter((g) => g.checkedInAt).length, total: guests.length, guests });
  } catch (err) {
    console.error("[Door] guests failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load the guest list.");
  }
});

export default router;
