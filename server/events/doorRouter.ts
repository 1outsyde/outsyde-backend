/**
 * Events door check-in and the Event team (door = Admissions; p4-team adds every other section, see teamRoles.ts).
 *
 *   GET    /api/events/door/mine                 (auth)       events I can scan: published, not ended, accepted invites only
 *   GET    /api/events/:id/door/team             (auth, host) standing + this event's door team
 *   POST   /api/events/:id/door/team             (auth, host) invite by username, scope standing | event (30 an hour)
 *   DELETE /api/events/:id/door/team/:userId     (auth, host) ?scope=standing|event, soft remove (also cancels an invite)
 *   PUT    /api/events/:id/door/team/:userId/schedule  (auth, host) ?role= this person's times and notes for this event
 *   GET    /api/events/:id/team/me               (auth)       my accepted Event team roles at this event, with times
 *
 *   GET    /api/events/door/invites              (auth)       my open door team invites
 *   GET    /api/events/door/invites/:inviteId    (auth, invitee) one invite: invited | accepted | declined | gone
 *   POST   /api/events/door/invites/:inviteId/accept|decline|leave   (auth, invitee)
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
import { rows, iso, fail, pgError, hostIdentity } from "./eventsRouter";
import { loadEventForDoor, isWithinScanWindow } from "./doorAccess";
import { TEAM_ROLES, duplicateMessage, parseRoleLabel, roleInfo, type TeamRole } from "./teamRoles";
import { notifyDoorInvite, notifyDoorAccepted } from "./ticketNotices";
import { ticketIdFromQrToken, qrPng } from "./ticketQr";
import { ticketIdFromWalletToken, walletConfig, cachedTicketPass } from "./walletPass";

const router = Router();

const scopeSchema = z.enum(["standing", "event"]);
// role (p4-team): door = Admissions, host = Promoter, see teamRoles.ts. Missing = door (old app builds, today's site).
const roleSchema = z.enum(TEAM_ROLES);
const ROLE_CHOICES = "role: choose door, security, host, entertainment, media, cohost or other.";
const addSchema = z.object({
  username: z.string().trim().min(1).max(40), scope: scopeSchema, role: roleSchema.optional(),
  roleLabel: z.string().max(200).nullable().optional(),
}).strict();
const validId = (v: string) => v.length > 0 && v.length <= 36;

export type InviteStatus = "invited" | "accepted" | "declined";
const statusOf = (r: any): InviteStatus => (r.accepted_at ? "accepted" : r.declined_at ? "declined" : "invited");

/** Old keys (userId, firstName, username, addedAt) unchanged; inviteId, status, invitedAt added for invites (075). */
const memberJson = (r: any) => ({
  userId: String(r.user_id), firstName: r.first_name ?? null, username: r.username ?? null, addedAt: iso(r.added_at),
  inviteId: String(r.invite_id), status: statusOf(r), invitedAt: iso(r.invited_at),
  // Additive (p4-team): which role this row is, its name and what it gives them (step 2), and this event's times.
  // Old clients ignore these keys.
  role: (r.role ?? "door") as TeamRole,
  roleLabel: r.role_label ?? null,
  roleInfo: roleInfo((r.role ?? "door") as TeamRole, r.role_label ?? null),
  schedule: r.schedule ?? null,
});

/** One event_team_schedules row as JSON (ISO times, null when unset). */
const scheduleJson = (s: any) => ({
  startsAt: iso(s.starts_at), endsAt: iso(s.ends_at), callAt: iso(s.call_at), loadInAt: iso(s.load_in_at),
  placeNote: s.place_note ?? null, hostNote: s.host_note ?? null, updatedAt: iso(s.updated_at),
});

/** This event's times for every person and role, keyed "memberId:role". */
async function schedulesFor(eventId: string): Promise<Map<string, any>> {
  const list = await rows<any>(sql`SELECT * FROM event_team_schedules WHERE event_id = ${eventId}`);
  return new Map(list.map((x) => [`${x.member_user_id}:${x.role}`, scheduleJson(x)]));
}

type Scope = "standing" | "event";
const doorTable = (scope: Scope) => sql.raw(scope === "standing" ? "event_door_team" : "event_door_members");
const doorKey = (scope: Scope, hostUserId: string, eventId: string, memberId: string, role: TeamRole) => scope === "standing"
  ? sql`host_user_id = ${hostUserId} AND member_user_id = ${memberId} AND role = ${role}`
  : sql`event_id = ${eventId} AND member_user_id = ${memberId} AND role = ${role}`;

/**
 * Sends (or re-sends after a decline) an invite. Pending and accepted rows are never touched: the caller answers
 * 409 ALREADY_INVITED / ALREADY_ON_TEAM. Returns the row (id, created_at, invited_at) or that code.
 */
async function inviteRow(scope: Scope, hostUserId: string, eventId: string, memberId: string, role: TeamRole, label: string | null): Promise<{ row: any } | { code: "ALREADY_INVITED" | "ALREADY_ON_TEAM" }> {
  const key = doorKey(scope, hostUserId, eventId, memberId, role);
  const [reopened] = await rows<any>(sql`
    UPDATE ${doorTable(scope)} SET declined_at = NULL, invited_at = now(), added_by_user_id = ${hostUserId}, role_label = ${label}
    WHERE ${key} AND removed_at IS NULL AND declined_at IS NOT NULL
    RETURNING id, created_at, invited_at`);
  if (reopened) return { row: reopened };
  let inserted: any;
  try {
    [inserted] = scope === "standing"
      ? await rows<any>(sql`
          INSERT INTO event_door_team (host_user_id, member_user_id, added_by_user_id, role, role_label)
          VALUES (${hostUserId}, ${memberId}, ${hostUserId}, ${role}, ${label})
          ON CONFLICT (host_user_id, member_user_id, role) WHERE removed_at IS NULL DO NOTHING
          RETURNING id, created_at, invited_at`)
      : await rows<any>(sql`
          INSERT INTO event_door_members (event_id, member_user_id, added_by_user_id, role, role_label)
          VALUES (${eventId}, ${memberId}, ${hostUserId}, ${role}, ${label})
          ON CONFLICT (event_id, member_user_id, role) WHERE removed_at IS NULL DO NOTHING
          RETURNING id, created_at, invited_at`);
  } catch (err) {
    if (pgError(err).code !== "23505") throw err;
  }
  if (inserted) return { row: inserted };
  const [existing] = await rows<any>(sql`SELECT accepted_at FROM ${doorTable(scope)} WHERE ${key} AND removed_at IS NULL`);
  return { code: existing?.accepted_at ? "ALREADY_ON_TEAM" : "ALREADY_INVITED" };
}

/** The host of this event, or null (and the caller answers 404 EVENT_NOT_FOUND). */
async function hostOnly(req: Request, res: Response): Promise<{ userId: string; event: any } | null> {
  const userId = getUserIdFromRequest(req);
  const eventId = String(req.params.id);
  if (!userId) { fail(res, 401, "UNAUTHORIZED", "Sign in to continue."); return null; }
  const access = validId(eventId) ? await loadEventForDoor(eventId, userId) : null;
  if (!access || access.role !== "host") { fail(res, 404, "EVENT_NOT_FOUND", "Event not found."); return null; }
  return { userId, event: access.event };
}

/** 120 per minute per signed in user (never per IP: a whole door team can share one venue wifi address). */
const DOOR_LIMIT = 120;
const doorLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: DOOR_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getUserIdFromRequest(req as Request) ?? "anonymous",
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => { fail(res, 429, "RATE_LIMITED", "Too many scans. Wait a moment and try again."); },
});

/** 30 invites an hour per host (per signed in user, never per IP), so nobody can be flooded with invites. */
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => getUserIdFromRequest(req as Request) ?? "anonymous",
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => { fail(res, 429, "RATE_LIMITED", "Too many invites. Try again in an hour."); },
});

/** Times and the member's team view: 120 a minute per signed in user. */
const teamLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => getUserIdFromRequest(req as Request) ?? "anonymous",
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => { fail(res, 429, "RATE_LIMITED", "Too many requests. Wait a moment and try again."); },
});

const qrLimiter = rateLimit({
  windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." } }); },
});

/** Public, signed QR image. Unknown, tampered, refunded and cancelled tickets all get the same 404. */
router.get("/qr/:token.png", qrLimiter, async (req: Request, res: Response) => {
  const notFound = () => res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } });
  try {
    const ticketId = ticketIdFromQrToken(String(req.params.token));
    if (!ticketId) return notFound();
    const [t] = await rows<any>(sql`SELECT code FROM tickets WHERE id = ${ticketId} AND status = 'valid' LIMIT 1`);
    if (!t) return notFound();
    const png = await qrPng(String(t.code));
    res.set({
      "Content-Type": "image/png",
      "Cross-Origin-Resource-Policy": "cross-site",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, max-age=86400",
    });
    return res.send(png);
  } catch (err) {
    console.error("[Events] qr image failed:", err);
    return notFound();
  }
});

/**
 * Public, signed Apple Wallet pass (p3-wallet). Same 404 for unknown, tampered, refunded and cancelled tickets, a QR
 * token used here, and while Wallet isn't configured. Reads only.
 * Signing costs real CPU, so this route has its own tighter limit (20 a minute per IP) and reuses built passes.
 */
const walletLimiter = rateLimit({
  windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." } }); },
});

router.get("/wallet/:token.pkpass", walletLimiter, async (req: Request, res: Response) => {
  const notFound = () => res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } });
  try {
    const cfg = walletConfig();
    if (!cfg) return notFound();
    const ticketId = ticketIdFromWalletToken(String(req.params.token));
    if (!ticketId) return notFound();
    const [t] = await rows<any>(sql`
      SELECT t.id, t.code, tt.name AS ticket_type_name, u.first_name,
             e.title, e.starts_at, e.ends_at, e.timezone, e.address_visibility,
             e.venue_name, e.address_line1, e.address_line2, e.city, e.state, e.postal_code
      FROM tickets t
      JOIN ticket_types tt ON tt.id = t.ticket_type_id
      JOIN events e ON e.id = t.event_id
      LEFT JOIN users u ON u.id = t.holder_user_id
      WHERE t.id = ${ticketId} AND t.status = 'valid'
      LIMIT 1`);
    if (!t) return notFound();
    const pkpass = await cachedTicketPass({
      ticketId: String(t.id), code: String(t.code), ticketTypeName: String(t.ticket_type_name), holderFirstName: t.first_name ?? null,
      event: {
        title: String(t.title), startsAt: new Date(t.starts_at), endsAt: new Date(t.ends_at), timezone: String(t.timezone),
        addressVisibility: t.address_visibility, venueName: t.venue_name ?? null, addressLine1: t.address_line1 ?? null,
        addressLine2: t.address_line2 ?? null, city: t.city ?? null, state: t.state ?? null, postalCode: t.postal_code ?? null,
      },
    }, cfg);
    res.set({
      "Content-Type": "application/vnd.apple.pkpass",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
    return res.send(pkpass);
  } catch (err) {
    console.error("[Events] wallet pass failed:", err instanceof Error ? err.message : err);
    return notFound();
  }
});

router.get("/door/mine", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return fail(res, 401, "UNAUTHORIZED", "Sign in to continue.");
    const list = await rows<any>(sql`
      SELECT e.id, e.slug, e.title, e.starts_at, e.ends_at, e.timezone,
        CASE WHEN e.host_user_id = u.id THEN 'host'
             WHEN EXISTS (SELECT 1 FROM event_door_team t WHERE t.host_user_id = e.host_user_id AND t.member_user_id = u.id AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL AND t.role = 'door') THEN 'standing'
             ELSE 'event' END AS role,
        CASE WHEN e.host_user_id = u.id THEN NULL
             ELSE COALESCE(
               (SELECT t.id FROM event_door_team t WHERE t.host_user_id = e.host_user_id AND t.member_user_id = u.id AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL AND t.role = 'door' LIMIT 1),
               (SELECT m.id FROM event_door_members m WHERE m.event_id = e.id AND m.member_user_id = u.id AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL AND m.role = 'door' LIMIT 1))
        END AS invite_id
      FROM events e
      JOIN users u ON u.id = ${userId} AND u.is_active = true AND COALESCE(u.deletion_status, 'active') = 'active'
      WHERE e.status = 'published' AND e.ends_at > now()
        AND (e.host_user_id = u.id
          OR EXISTS (SELECT 1 FROM event_door_team t WHERE t.host_user_id = e.host_user_id AND t.member_user_id = u.id AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL AND t.role = 'door')
          OR EXISTS (SELECT 1 FROM event_door_members m WHERE m.event_id = e.id AND m.member_user_id = u.id AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL AND m.role = 'door'))
      ORDER BY e.starts_at, e.id`);
    res.json({
      success: true,
      events: list.map((e) => ({
        id: e.id, slug: e.slug, title: e.title, startsAt: iso(e.starts_at), endsAt: iso(e.ends_at), timezone: e.timezone, role: e.role,
        // Additive (p4-scanner): the accepted invite behind a member's row, so they can open it and Leave. Null for the host.
        inviteId: e.invite_id ? String(e.invite_id) : null,
      })),
    });
  } catch (err) {
    console.error("[Door] mine failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load your door events.");
  }
});

// ─── The invitee's side (p4-scanner, migration 075) ─────────────────────────

type InviteRow = {
  scope: Scope; id: string; host_user_id: string; event_id: string | null; member_user_id: string;
  accepted_at: any; declined_at: any; removed_at: any; invited_at: any; role: string; role_label: string | null;
  e_title: string | null; e_starts_at: any; e_ends_at: any; e_timezone: string | null; e_status: string | null;
};

/** One invite row from either table (ids are UUIDs, so they never collide). */
async function loadInvite(inviteId: string): Promise<InviteRow | null> {
  if (!validId(inviteId)) return null;
  const [r] = await rows<any>(sql`
    SELECT 'standing' AS scope, t.id, t.host_user_id, NULL::varchar AS event_id, t.member_user_id, t.accepted_at, t.declined_at,
      t.removed_at, t.invited_at, t.role, t.role_label, NULL AS e_title, NULL::timestamptz AS e_starts_at, NULL::timestamptz AS e_ends_at,
      NULL AS e_timezone, NULL AS e_status
    FROM event_door_team t WHERE t.id = ${inviteId}
    UNION ALL
    SELECT 'event', m.id, e.host_user_id, m.event_id, m.member_user_id, m.accepted_at, m.declined_at,
      m.removed_at, m.invited_at, m.role, m.role_label, e.title, e.starts_at, e.ends_at, e.timezone, e.status
    FROM event_door_members m JOIN events e ON e.id = m.event_id WHERE m.id = ${inviteId}`);
  return (r as InviteRow) ?? null;
}

/** An only-this-event invite closes when its event ends or is cancelled. */
const eventClosed = (r: InviteRow) => r.scope === "event"
  && (r.e_status === "cancelled" || new Date(r.e_ends_at).getTime() <= Date.now());
const inviteStatus = (r: InviteRow): "invited" | "accepted" | "declined" | "gone" =>
  r.removed_at || eventClosed(r) ? "gone" : r.accepted_at ? "accepted" : r.declined_at ? "declined" : "invited";

/** Host public name from their latest published event, else their latest event (the invite names the host). */
async function hostNameFor(hostUserId: string, eventId: string | null): Promise<string> {
  const [e] = eventId
    ? await rows<any>(sql`SELECT * FROM events WHERE id = ${eventId}`)
    : await rows<any>(sql`SELECT * FROM events WHERE host_user_id = ${hostUserId}
        ORDER BY (status = 'published') DESC, created_at DESC LIMIT 1`);
  return (await hostIdentity(e ?? { host_user_id: hostUserId })).publicName;
}

async function inviteJson(r: InviteRow) {
  const upcoming = r.scope === "standing"
    ? await rows<any>(sql`SELECT id, title, starts_at, timezone FROM events
        WHERE host_user_id = ${r.host_user_id} AND status = 'published' AND ends_at > now() ORDER BY starts_at, id LIMIT 5`)
    : [];
  return {
    id: String(r.id), scope: r.scope, role: r.role, status: inviteStatus(r), invitedAt: iso(r.invited_at),
    roleLabel: r.role_label ?? null, roleInfo: roleInfo((r.role ?? "door") as TeamRole, r.role_label ?? null),
    host: { name: await hostNameFor(r.host_user_id, r.event_id) },
    event: r.scope === "event"
      ? { id: String(r.event_id), title: r.e_title, startsAt: iso(r.e_starts_at), endsAt: iso(r.e_ends_at), timezone: r.e_timezone }
      : null,
    upcoming: upcoming.map((e) => ({ id: String(e.id), title: e.title, startsAt: iso(e.starts_at), timezone: e.timezone })),
  };
}

/** The signed in invitee and their invite, or null after answering 401 / 404 INVITE_NOT_FOUND. */
async function myInvite(req: Request, res: Response): Promise<{ userId: string; invite: InviteRow } | null> {
  const userId = getUserIdFromRequest(req);
  if (!userId) { fail(res, 401, "UNAUTHORIZED", "Sign in to continue."); return null; }
  const invite = await loadInvite(String(req.params.inviteId));
  if (!invite || invite.member_user_id !== userId) { fail(res, 404, "INVITE_NOT_FOUND", "Invite not found."); return null; }
  // p4-team: a security or host invite only exists for clients that ask with ?roles=all (today's app would show it
  // as a door team invite). Covers view, accept, decline and leave.
  if ((invite.role ?? "door") !== "door" && req.query.roles !== "all") { fail(res, 404, "INVITE_NOT_FOUND", "Invite not found."); return null; }
  return { userId, invite };
}

router.get("/door/invites", hybridAuthMiddleware, doorLimiter, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return fail(res, 401, "UNAUTHORIZED", "Sign in to continue.");
    // p4-team: door invites only unless ?roles=all, so today's app never shows a security or host invite as a door one.
    const allRoles = req.query.roles === "all";
    const tRole = allRoles ? sql`` : sql`AND t.role = 'door'`;
    const mRole = allRoles ? sql`` : sql`AND m.role = 'door'`;
    const ids = await rows<any>(sql`
      SELECT t.id, t.invited_at FROM event_door_team t
      WHERE t.member_user_id = ${userId} AND t.removed_at IS NULL AND t.accepted_at IS NULL AND t.declined_at IS NULL ${tRole}
      UNION ALL
      SELECT m.id, m.invited_at FROM event_door_members m JOIN events e ON e.id = m.event_id
      WHERE m.member_user_id = ${userId} AND m.removed_at IS NULL AND m.accepted_at IS NULL AND m.declined_at IS NULL ${mRole}
        AND e.status <> 'cancelled' AND e.ends_at > now()
      ORDER BY invited_at DESC, id LIMIT 50`);
    const invites = [];
    for (const { id } of ids) {
      const r = await loadInvite(String(id));
      if (r) invites.push(await inviteJson(r));
    }
    res.json({ success: true, invites });
  } catch (err) {
    console.error("[Door] invites failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load your invites.");
  }
});

router.get("/door/invites/:inviteId", hybridAuthMiddleware, doorLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = await myInvite(req, res);
    if (!ctx) return;
    res.json({ success: true, invite: await inviteJson(ctx.invite) });
  } catch (err) {
    console.error("[Door] invite failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load the invite.");
  }
});

/** One atomic answer: only an open invite (not answered, not cancelled, event not over) changes. */
async function answerInvite(r: InviteRow, userId: string, answer: "accept" | "decline"): Promise<boolean> {
  const set = answer === "accept" ? sql`accepted_at = now()` : sql`declined_at = now()`;
  const open = sql`id = ${r.id} AND member_user_id = ${userId} AND removed_at IS NULL AND accepted_at IS NULL AND declined_at IS NULL`;
  const done = r.scope === "standing"
    ? await rows<any>(sql`UPDATE event_door_team SET ${set} WHERE ${open} RETURNING id`)
    : await rows<any>(sql`UPDATE event_door_members SET ${set} WHERE ${open}
        AND EXISTS (SELECT 1 FROM events e WHERE e.id = event_door_members.event_id AND e.status <> 'cancelled' AND e.ends_at > now())
        RETURNING id`);
  return done.length > 0;
}

for (const answer of ["accept", "decline"] as const) {
  router.post(`/door/invites/:inviteId/${answer}`, hybridAuthMiddleware, doorLimiter, async (req: Request, res: Response) => {
    try {
      const ctx = await myInvite(req, res);
      if (!ctx) return;
      if (!(await answerInvite(ctx.invite, ctx.userId, answer))) return fail(res, 409, "INVITE_CLOSED", "This invite is no longer open.");
      if (answer === "accept") {
        notifyDoorAccepted({ hostUserId: ctx.invite.host_user_id, memberUserId: ctx.userId, scope: ctx.invite.scope, eventId: ctx.invite.event_id, role: (ctx.invite.role ?? "door") as TeamRole, roleLabel: ctx.invite.role_label ?? null }).catch(() => {});
      }
      const fresh = await loadInvite(ctx.invite.id);
      res.json({ success: true, invite: await inviteJson(fresh!) });
    } catch (err) {
      console.error(`[Door] invite ${answer} failed:`, err);
      fail(res, 500, "SERVER_ERROR", "Could not answer the invite.");
    }
  });
}

router.post("/door/invites/:inviteId/leave", hybridAuthMiddleware, doorLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = await myInvite(req, res);
    if (!ctx) return;
    const done = await rows<any>(sql`
      UPDATE ${doorTable(ctx.invite.scope)} SET removed_at = now(), removed_by_user_id = ${ctx.userId}
      WHERE id = ${ctx.invite.id} AND member_user_id = ${ctx.userId} AND removed_at IS NULL AND accepted_at IS NOT NULL
      RETURNING id`);
    if (!done.length) return fail(res, 409, "NOT_ON_TEAM", "You aren't on this Event team.");
    const fresh = await loadInvite(ctx.invite.id);
    res.json({ success: true, invite: await inviteJson(fresh!) });
  } catch (err) {
    console.error("[Door] leave failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not leave the Event team.");
  }
});

router.get("/:id/door/team", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const ctx = await hostOnly(req, res);
    if (!ctx) return;
    // p4-team: ?roles=all lists every role (new clients). Without it, door only, as old clients expect.
    const allRoles = req.query.roles === "all";
    const tRole = allRoles ? sql`` : sql`AND t.role = 'door'`;
    const mRole = allRoles ? sql`` : sql`AND m.role = 'door'`;
    const standing = await rows<any>(sql`
      SELECT u.id AS user_id, u.first_name, u.username, t.created_at AS added_at,
        t.id AS invite_id, t.accepted_at, t.declined_at, t.invited_at, t.role, t.role_label
      FROM event_door_team t JOIN users u ON u.id = t.member_user_id
      WHERE t.host_user_id = ${ctx.userId} AND t.removed_at IS NULL ${tRole} ORDER BY t.created_at, u.id, t.role`);
    const event = await rows<any>(sql`
      SELECT u.id AS user_id, u.first_name, u.username, m.created_at AS added_at,
        m.id AS invite_id, m.accepted_at, m.declined_at, m.invited_at, m.role, m.role_label
      FROM event_door_members m JOIN users u ON u.id = m.member_user_id
      WHERE m.event_id = ${ctx.event.id} AND m.removed_at IS NULL ${mRole} ORDER BY m.created_at, u.id, m.role`);
    const times = await schedulesFor(ctx.event.id);
    const withTimes = (m: any) => memberJson({ ...m, schedule: times.get(`${m.user_id}:${m.role ?? "door"}`) ?? null });
    res.json({ success: true, standing: standing.map(withTimes), event: event.map(withTimes) });
  } catch (err) {
    console.error("[Door] team list failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load the Event team.");
  }
});

router.post("/:id/door/team", hybridAuthMiddleware, inviteLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = await hostOnly(req, res);
    if (!ctx) return;
    const parsed = addSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return fail(res, 400, "INVALID_REQUEST", `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}`);
    }
    const { username, scope } = parsed.data;
    const role: TeamRole = parsed.data.role ?? "door";
    const label = parseRoleLabel(role, parsed.data.roleLabel);
    if (!label.ok) return fail(res, 400, "INVALID_REQUEST", label.message);
    if (scope === "event" && (ctx.event.status === "cancelled" || new Date(ctx.event.ends_at).getTime() <= Date.now())) {
      return fail(res, 409, "EVENT_ENDED", "This event is over, so no one can be added to its Event team.");
    }
    const [target] = await rows<any>(sql`
      SELECT id, first_name, username FROM users
      WHERE LOWER(username) = LOWER(${username}) AND is_active = true AND COALESCE(deletion_status, 'active') = 'active'`);
    if (!target) return fail(res, 404, "USER_NOT_FOUND", "No active account has that username.");
    if (target.id === ctx.userId) return fail(res, 400, "CANNOT_ADD_SELF", "You already have full access to your own events.");
    const out = await inviteRow(scope, ctx.userId, ctx.event.id, target.id, role, label.label);
    if ("code" in out) {
      return fail(res, 409, out.code, duplicateMessage(role, out.code, label.label));
    }
    notifyDoorInvite({ inviteId: String(out.row.id), scope, eventId: ctx.event.id, memberUserId: target.id, hostUserId: ctx.userId, role, roleLabel: label.label }).catch(() => {});
    res.status(201).json({
      success: true, scope,
      member: memberJson({
        user_id: target.id, first_name: target.first_name, username: target.username, added_at: out.row.created_at,
        invite_id: out.row.id, accepted_at: null, declined_at: null, invited_at: out.row.invited_at, role, role_label: label.label,
      }),
    });
  } catch (err) {
    console.error("[Door] team invite failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not send the invite.");
  }
});

router.delete("/:id/door/team/:userId", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const ctx = await hostOnly(req, res);
    if (!ctx) return;
    const scope = scopeSchema.safeParse(req.query.scope);
    if (!scope.success) return fail(res, 400, "INVALID_REQUEST", "scope: choose standing or event.");
    // p4-team: ?role= picks which spot to remove. Missing = door, the only spot old clients know about.
    const roleParsed = roleSchema.safeParse(req.query.role ?? "door");
    if (!roleParsed.success) return fail(res, 400, "INVALID_REQUEST", ROLE_CHOICES);
    const role = roleParsed.data;
    const memberId = String(req.params.userId);
    if (!validId(memberId)) return fail(res, 404, "NOT_ON_TEAM", "That person isn't on your Event team.");
    const done = scope.data === "standing"
      ? await rows<any>(sql`
          UPDATE event_door_team SET removed_at = now(), removed_by_user_id = ${ctx.userId}
          WHERE host_user_id = ${ctx.userId} AND member_user_id = ${memberId} AND role = ${role} AND removed_at IS NULL RETURNING id`)
      : await rows<any>(sql`
          UPDATE event_door_members SET removed_at = now(), removed_by_user_id = ${ctx.userId}
          WHERE event_id = ${ctx.event.id} AND member_user_id = ${memberId} AND role = ${role} AND removed_at IS NULL RETURNING id`);
    if (!done.length) return fail(res, 404, "NOT_ON_TEAM", "That person isn't on your Event team.");
    res.json({ success: true, removed: true });
  } catch (err) {
    console.error("[Door] team remove failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not remove from the Event team.");
  }
});

// ─── Times and notes per person, per role, per event (p4-team step 2, migration 083) ──

const timeField = z.string().datetime({ offset: true }).nullable().optional();
const scheduleSchema = z.object({
  startsAt: timeField, endsAt: timeField, callAt: timeField, loadInAt: timeField,
  placeNote: z.string().trim().max(300).nullable().optional(),
  hostNote: z.string().trim().max(500).nullable().optional(),
}).strict();
/** Times must sit near the event: from a day before it starts to 12 hours after it ends. */
const SCHEDULE_BEFORE_MS = 24 * 3600_000;
const SCHEDULE_AFTER_MS = 12 * 3600_000;

/** Is this person on the event's team in this role (pending or accepted; not declined, not removed)? Standing rows count. */
async function onTeam(event: any, memberId: string, role: TeamRole): Promise<boolean> {
  const r = await rows<any>(sql`
    SELECT 1 AS x FROM event_door_members m
    WHERE m.event_id = ${event.id} AND m.member_user_id = ${memberId} AND m.role = ${role} AND m.removed_at IS NULL AND m.declined_at IS NULL
    UNION ALL
    SELECT 1 FROM event_door_team t
    WHERE t.host_user_id = ${event.host_user_id} AND t.member_user_id = ${memberId} AND t.role = ${role} AND t.removed_at IS NULL AND t.declined_at IS NULL
    LIMIT 1`);
  return r.length > 0;
}

/** Saves the whole set: a field left out or null is cleared. Every field is optional for every role. */
router.put("/:id/door/team/:userId/schedule", hybridAuthMiddleware, teamLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = await hostOnly(req, res);
    if (!ctx) return;
    const roleParsed = roleSchema.safeParse(req.query.role);
    if (!roleParsed.success) return fail(res, 400, "INVALID_REQUEST", ROLE_CHOICES);
    const role = roleParsed.data;
    const parsed = scheduleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return fail(res, 400, "INVALID_REQUEST", `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}`);
    }
    const b = parsed.data;
    const ms = (v: string | null | undefined) => (v ? new Date(v).getTime() : null);
    const [st, en, ca, li] = [ms(b.startsAt), ms(b.endsAt), ms(b.callAt), ms(b.loadInAt)];
    if (st !== null && en !== null && en <= st) return fail(res, 400, "INVALID_REQUEST", "endsAt: the end has to be after the start.");
    const from = new Date(ctx.event.starts_at).getTime() - SCHEDULE_BEFORE_MS;
    const to = new Date(ctx.event.ends_at).getTime() + SCHEDULE_AFTER_MS;
    if ([st, en, ca, li].some((t) => t !== null && (t < from || t > to))) {
      return fail(res, 400, "TIME_OUT_OF_RANGE", "Times have to be within a day before the event starts and 12 hours after it ends.");
    }
    if (ctx.event.status === "cancelled" || new Date(ctx.event.ends_at).getTime() <= Date.now()) {
      return fail(res, 409, "EVENT_ENDED", "This event is over, so times can't be changed.");
    }
    const memberId = String(req.params.userId);
    if (!validId(memberId) || !(await onTeam(ctx.event, memberId, role))) {
      return fail(res, 404, "NOT_ON_TEAM", "That person isn't on your Event team in that role.");
    }
    const v = (x: string | null | undefined) => (x ? new Date(x).toISOString() : null);
    const note = (x: string | null | undefined) => (x && x.trim() ? x.trim() : null);
    const [saved] = await rows<any>(sql`
      INSERT INTO event_team_schedules (event_id, member_user_id, role, starts_at, ends_at, call_at, load_in_at, place_note, host_note, updated_by_user_id)
      VALUES (${ctx.event.id}, ${memberId}, ${role}, ${v(b.startsAt)}::timestamptz, ${v(b.endsAt)}::timestamptz, ${v(b.callAt)}::timestamptz,
        ${v(b.loadInAt)}::timestamptz, ${note(b.placeNote)}, ${note(b.hostNote)}, ${ctx.userId})
      ON CONFLICT (event_id, member_user_id, role) DO UPDATE SET
        starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, call_at = EXCLUDED.call_at, load_in_at = EXCLUDED.load_in_at,
        place_note = EXCLUDED.place_note, host_note = EXCLUDED.host_note, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      RETURNING *`);
    res.json({ success: true, role, schedule: scheduleJson(saved) });
  } catch (err) {
    console.error("[Door] schedule save failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not save the times.");
  }
});

/** The member's side: their accepted roles at this event (standing ones too) with this event's times. */
router.get("/:id/team/me", hybridAuthMiddleware, teamLimiter, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return fail(res, 401, "UNAUTHORIZED", "Sign in to continue.");
    const eventId = String(req.params.id);
    const [e] = validId(eventId) ? await rows<any>(sql`SELECT * FROM events WHERE id = ${eventId} AND status <> 'cancelled'`) : [];
    if (!e) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const mine = await rows<any>(sql`
      SELECT 'event' AS scope, m.role, m.role_label, m.created_at FROM event_door_members m
      WHERE m.event_id = ${e.id} AND m.member_user_id = ${userId} AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL
      UNION ALL
      SELECT 'standing', t.role, t.role_label, t.created_at FROM event_door_team t
      WHERE t.host_user_id = ${e.host_user_id} AND t.member_user_id = ${userId} AND t.removed_at IS NULL AND t.accepted_at IS NOT NULL
      ORDER BY created_at, role`);
    if (!mine.length) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const times = await schedulesFor(e.id);
    const seen = new Set<string>();
    const roles = [];
    for (const r of mine) {
      if (seen.has(r.role)) continue; // a role held both ways shows once
      seen.add(r.role);
      roles.push({
        role: r.role, roleLabel: r.role_label ?? null, roleInfo: roleInfo(r.role as TeamRole, r.role_label ?? null), scope: r.scope,
        schedule: times.get(`${userId}:${r.role}`) ?? null,
      });
    }
    res.json({
      success: true,
      event: { id: String(e.id), slug: e.slug, title: e.title, startsAt: iso(e.starts_at), endsAt: iso(e.ends_at), timezone: e.timezone },
      host: { name: (await hostIdentity(e)).publicName },
      roles,
    });
  } catch (err) {
    console.error("[Door] team me failed:", err);
    fail(res, 500, "SERVER_ERROR", "Could not load your Event team roles.");
  }
});

// ─── Check in, undo, guest list (Task 3) ────────────────────────────────────

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
  // Never paid (held or expired order): say so. A refunding or refunded order stays NOT_VALID below.
  if (t.status === "valid" && (t.order_status === "pending" || t.order_status === "expired")) {
    return fail(res, 409, "NOT_PAID", "This ticket isn't paid for yet.");
  }
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
