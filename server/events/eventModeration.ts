/**
 * Events Phase 5, p5-safety (Legend's calls T1 to T11, 2026-11-01; audit https://claude.ai/artifact/VPB4BzbgFY7FPcFL22KweU,
 * vault "p5-safety — Audit & Regression").
 *
 *   POST /api/events/:id/report      (auth) T1 to T4: report a live (or paused) event. Six reasons; "other" needs a note
 *                                    (up to 500 characters). Never the host, co-hosts or the event's team. One row per
 *                                    reporter in moderation_queue (target_type 'event', unique per reporter, migration 095);
 *                                    the same person again is accepted and not counted. Admin email on the first report
 *                                    and when the third reporter comes in. Nothing pauses on its own.
 *   POST /api/feed/:postId/report    (auth) T11: the app's Report post (it called a route that did not exist). Same queue,
 *                                    target_type 'post', one row per reporter, never your own post.
 *
 * First event limits (T5 to T7, Host Agreement 3.4): a personal host (host_type 'user') who is not marked trusted and has
 * no earlier personal event whose payout was paid with no lost dispute may sell at most NEW_HOST_MAX_PAID_TICKETS paid
 * tickets per event (sum of active paid ticket type quantities) at most NEW_HOST_MAX_PRICE_CENTS each. Free RSVPs are never
 * limited; business and photographer hosts are exempt. Checked when a ticket type is added or changed (ticketsRouter) and
 * on publish (eventsRouter).
 *
 * Admin actions (T8, used by adminEventsRouter, platform admin only): pause (published -> paused), release (paused ->
 * published), cancel and refund everyone (published or paused -> cancelled, any time, the host cancel refund path; the
 * guests' cancel email gets no "message from the host"), dismiss an event's pending reports, trusted host on/off. Each is
 * ONE statement with its audit_logs row (neon-http has no transactions). Pause, cancel and dismiss close the event's
 * pending reports. T9: the host gets an email and a push on pause, release and cancel, with the admin's reason.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import { rows } from "./eventsRouter";

export const REPORT_REASONS = {
  scam: "Scam or fake event",
  illegal: "Illegal or dangerous",
  hate: "Hate, harassment or violence",
  sexual: "Sexual content",
  wrong_details: "Wrong date, place or details",
  other: "Something else",
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;
export const REPORT_NOTE_MAX = 500;
/** Admin email again when this many different people have reported an event (plus the first report). */
export const REPORT_ALERT_AT = 3;
export const NEW_HOST_MAX_PAID_TICKETS = 100;
export const NEW_HOST_MAX_PRICE_CENTS = 10000;
export const NEW_HOST_LIMIT_MESSAGE =
  "New hosts can sell up to 100 paid tickets per event, at up to $100 each, until their first paid event has been paid out. Free RSVPs have no limit.";

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

let alertForTest: ((subject: string, detail: string) => Promise<void>) | null = null;
/** Test seam only: records admin emails instead of sending them. Never set in production. */
export function setModerationAlertForTest(fn: ((subject: string, detail: string) => Promise<void>) | null): void { alertForTest = fn; }

/** Internal [Reports] email (no log tag, like every admin alert). Never throws. */
async function alert(subject: string, detail: string): Promise<void> {
  try {
    if (alertForTest) return await alertForTest(subject, detail);
    const { sendAdminEmail, ADMIN_NOTIFICATION_EMAIL } = await import("../emailService");
    await sendAdminEmail({ to: ADMIN_NOTIFICATION_EMAIL, subject: `[Reports] ${subject}`, html: `<p>${detail.replace(/[<>&]/g, "")}</p>` });
  } catch (err) {
    console.error("[Reports] admin alert failed:", err);
  }
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// ─── T1 to T4: report an event ──────────────────────────────────────────────

const eventReportSchema = z.object({
  reason: z.enum(Object.keys(REPORT_REASONS) as [ReportReason, ...ReportReason[]]),
  note: z.string().trim().max(REPORT_NOTE_MAX).optional(),
}).strict().refine((b) => b.reason !== "other" || (b.note ?? "").length > 0, { message: "Tell us what is wrong.", path: ["note"] });

export const eventReportsRouter = Router();

eventReportsRouter.post("/:id/report", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to report this event.");
  const parsed = eventReportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", parsed.error.errors[0]?.message ?? "Pick a reason.");
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
  const note = parsed.data.note ? parsed.data.note : null;
  try {
    const [r] = await rows<any>(sql`
      WITH e AS (
        SELECT ev.id, ev.title, ev.host_user_id FROM events ev
        WHERE ev.id = ${id} AND ev.status IN ('published', 'paused')
      ),
      part AS (
        -- The host, the event's co-hosts and team (event or standing, accepted and not removed) can't report it.
        SELECT 1 AS x FROM e WHERE e.host_user_id = ${userId}
        UNION ALL
        SELECT 1 FROM event_door_members m, e
        WHERE m.event_id = e.id AND m.member_user_id = ${userId} AND m.accepted_at IS NOT NULL AND m.removed_at IS NULL
        UNION ALL
        SELECT 1 FROM event_door_team t, e
        WHERE t.host_user_id = e.host_user_id AND t.member_user_id = ${userId} AND t.accepted_at IS NOT NULL AND t.removed_at IS NULL
      ),
      ins AS (
        INSERT INTO moderation_queue (reporter_id, target_id, target_type, reason, details)
        SELECT ${userId}, e.id, 'event', ${parsed.data.reason}, ${note} FROM e
        WHERE NOT EXISTS (SELECT 1 FROM part)
        ON CONFLICT (target_type, target_id, reporter_id) WHERE target_type IN ('event', 'post') DO NOTHING
        RETURNING id
      )
      SELECT (SELECT count(*) FROM e)::int AS found, (SELECT title FROM e) AS title, EXISTS (SELECT 1 FROM part) AS own,
             (SELECT id FROM ins) AS inserted`);
    if (!r?.found) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    if (r.own) return fail(res, 403, "CANT_REPORT_OWN", "You can't report an event you host or work on.");
    if (r.inserted) {
      // Counted after the insert (its own statement sees it): pending reports from different people.
      const [c] = await rows<any>(sql`
        SELECT count(DISTINCT reporter_id)::int AS n FROM moderation_queue
        WHERE target_type = 'event' AND target_id = ${id} AND status = 'pending'`);
      const n = Number(c?.n ?? 0);
      if (n === 1 || n === REPORT_ALERT_AT) {
        await alert(n === 1 ? `Event reported: ${r.title}` : `Event reported by ${n} people: ${r.title}`,
          `Event ${id} ("${r.title}") was reported (${REPORT_REASONS[parsed.data.reason]}${note ? `: ${note}` : ""}). ` +
          `${n} ${n === 1 ? "person has" : "people have"} reported it. Review it on goutsyde.com/admin/events, Reports tab. Nothing happens to the event until you act.`);
      }
    }
    return res.json({ success: true, alreadyReported: !r.inserted, message: "Thanks. We'll review this event." });
  } catch (err) {
    console.error("[Reports] event report failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't send your report. Try again.");
  }
});

// ─── T11: report a post ─────────────────────────────────────────────────────

const postReportSchema = z.object({ reason: z.string().trim().min(1, "Tell us what is wrong.").max(REPORT_NOTE_MAX) }).passthrough();

export const postReportsRouter = Router();

postReportsRouter.post("/:postId/report", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to report this post.");
  const parsed = postReportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", parsed.error.errors[0]?.message ?? "Tell us what is wrong.");
  const id = String(req.params.postId);
  if (!ID_RE.test(id)) return fail(res, 404, "POST_NOT_FOUND", "Post not found.");
  try {
    const [r] = await rows<any>(sql`
      WITH p AS (SELECT id, author_id FROM feed_posts WHERE id = ${id} AND COALESCE(is_active, true) = true),
      ins AS (
        INSERT INTO moderation_queue (reporter_id, target_id, target_type, reason)
        SELECT ${userId}, p.id, 'post', ${parsed.data.reason} FROM p WHERE p.author_id <> ${userId}
        ON CONFLICT (target_type, target_id, reporter_id) WHERE target_type IN ('event', 'post') DO NOTHING
        RETURNING id
      )
      SELECT (SELECT count(*) FROM p)::int AS found, (SELECT author_id FROM p) AS author, (SELECT id FROM ins) AS inserted`);
    if (!r?.found) return fail(res, 404, "POST_NOT_FOUND", "Post not found.");
    if (r.author === userId) return fail(res, 400, "CANT_REPORT_OWN", "You can't report your own post.");
    return res.json({ success: true, message: "Report submitted" });
  } catch (err) {
    console.error("[Reports] post report failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't send your report. Try again.");
  }
});

// ─── T5 to T7: first event limits ───────────────────────────────────────────

/** SQL: the event's host is a personal host still under the first event limits (e = an events row alias). */
const LIMITED_HOST = (e: ReturnType<typeof sql.raw>) => sql`(
  ${e}.host_type = 'user'
  AND NOT EXISTS (SELECT 1 FROM event_host_trust ht WHERE ht.user_id = ${e}.host_user_id)
  AND NOT EXISTS (
    SELECT 1 FROM event_payouts pp JOIN events pe ON pe.id = pp.event_id
    WHERE pe.host_type = 'user' AND pe.host_user_id = ${e}.host_user_id AND pp.status = 'paid' AND pp.gross_cents > 0
      AND NOT EXISTS (
        SELECT 1 FROM stripe_disputes sd JOIN ticket_orders so ON so.id = sd.reference_id
        WHERE sd.kind = 'ticket_order' AND sd.outcome = 'lost' AND so.event_id = pe.id)))`;

/** Is this event's host under the first event limits? */
export async function isLimitedHost(eventId: string): Promise<boolean> {
  const [r] = await rows<any>(sql`SELECT ${LIMITED_HOST(sql.raw("e"))} AS limited FROM events e WHERE e.id = ${eventId}`);
  return !!r?.limited;
}

/**
 * The limit error for this event as it would be after one ticket type change (or as it is, with no change), or null when
 * it is within the limits or the host isn't limited. change.typeId: the type being edited (its saved values are replaced
 * by the change); no typeId = a new type.
 */
export async function newHostLimitError(eventId: string, change?: { typeId?: string | null; priceCents: number; quantity: number }): Promise<string | null> {
  const [r] = await rows<any>(sql`
    SELECT ${LIMITED_HOST(sql.raw("e"))} AS limited,
           COALESCE((SELECT sum(t.quantity) FROM ticket_types t WHERE t.event_id = e.id AND t.status = 'active' AND t.price_cents > 0
                     AND t.id IS DISTINCT FROM ${change?.typeId ?? null}), 0)::int AS qty,
           COALESCE((SELECT max(t.price_cents) FROM ticket_types t WHERE t.event_id = e.id AND t.status = 'active' AND t.price_cents > 0
                     AND t.id IS DISTINCT FROM ${change?.typeId ?? null}), 0)::int AS top
    FROM events e WHERE e.id = ${eventId}`);
  if (!r?.limited) return null;
  let qty = Number(r.qty), top = Number(r.top);
  if (change && change.priceCents > 0) { qty += change.quantity; top = Math.max(top, change.priceCents); }
  return qty > NEW_HOST_MAX_PAID_TICKETS || top > NEW_HOST_MAX_PRICE_CENTS ? NEW_HOST_LIMIT_MESSAGE : null;
}

// ─── T8: admin actions ──────────────────────────────────────────────────────

export type AdminActionResult =
  | { ok: true; status?: string; dismissed?: number }
  | { ok: false; code: "EVENT_NOT_FOUND" | "NOT_PUBLISHED" | "NOT_PAUSED" | "NOT_CANCELLABLE" | "HOST_NOT_FOUND" };

/** Shared by pause and release: one guarded status change + audit row (+ closing pending reports for pause). */
async function changeStatus(eventId: string, adminId: string, from: string[], to: string, action: string, reason: string, closeReports: string | null): Promise<{ found: boolean; changed: boolean; before: string | null }> {
  const [r] = await rows<any>(sql`
    WITH cur AS (SELECT id, status FROM events WHERE id = ${eventId}),
    upd AS (
      UPDATE events SET status = ${to}, updated_at = now()
      WHERE id = ${eventId} AND status = ANY(${`{${from.join(",")}}`}::text[])
      RETURNING id, status
    ),
    rep AS (
      UPDATE moderation_queue SET status = 'reviewed', admin_action = ${closeReports}, admin_notes = ${reason}, reviewed_by = ${adminId}, reviewed_at = now()
      WHERE ${closeReports}::text IS NOT NULL AND target_type = 'event' AND target_id = ${eventId} AND status = 'pending' AND EXISTS (SELECT 1 FROM upd)
      RETURNING id
    ),
    aud AS (
      INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata)
      SELECT ${adminId}::varchar, 'admin', ${action}::text, 'event', upd.id, jsonb_build_object('status', cur.status), jsonb_build_object('status', upd.status),
             jsonb_build_object('reason', ${reason}::text, 'reports_closed', (SELECT count(*) FROM rep))
      FROM upd JOIN cur ON cur.id = upd.id
      RETURNING id
    )
    SELECT (SELECT count(*) FROM cur)::int AS found, (SELECT status FROM cur) AS before, (SELECT count(*) FROM upd)::int AS changed, (SELECT count(*) FROM aud)::int AS audited`);
  return { found: !!r?.found, changed: Number(r?.changed ?? 0) > 0, before: r?.before ?? null };
}

export async function pauseEvent(eventId: string, adminId: string, reason: string): Promise<AdminActionResult> {
  const r = await changeStatus(eventId, adminId, ["published"], "paused", "event.pause", reason, "pause");
  if (!r.found) return { ok: false, code: "EVENT_NOT_FOUND" };
  if (!r.changed) return { ok: false, code: "NOT_PUBLISHED" };
  await notifyHostModeration(eventId, "pause", reason);
  return { ok: true, status: "paused" };
}

export async function releaseEvent(eventId: string, adminId: string, reason: string): Promise<AdminActionResult> {
  const r = await changeStatus(eventId, adminId, ["paused"], "published", "event.release", reason, null);
  if (!r.found) return { ok: false, code: "EVENT_NOT_FOUND" };
  if (!r.changed) return { ok: false, code: "NOT_PAUSED" };
  await notifyHostModeration(eventId, "release", reason);
  return { ok: true, status: "published" };
}

/**
 * Cancel and refund everyone (published or paused, also after the start): the same guest steps as the host cancel
 * (eventsRouter POST /:id/cancel): free RSVPs cancelled, every paid order refunded in full, fees included, open checkouts
 * closed; the every-minute refund job repeats both as a backstop. cancel_reason stays empty: guests' emails show it as a
 * message from the host. Refunds after the payout are taken back from the host by the recovery step.
 */
export async function cancelEventByAdmin(eventId: string, adminId: string, reason: string): Promise<AdminActionResult> {
  const [r] = await rows<any>(sql`
    WITH cur AS (SELECT id, status FROM events WHERE id = ${eventId}),
    upd AS (
      UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = NULL, updated_at = now()
      WHERE id = ${eventId} AND status IN ('published', 'paused')
      RETURNING id, status
    ),
    rep AS (
      UPDATE moderation_queue SET status = 'reviewed', admin_action = 'cancel', admin_notes = ${reason}, reviewed_by = ${adminId}, reviewed_at = now()
      WHERE target_type = 'event' AND target_id = ${eventId} AND status = 'pending' AND EXISTS (SELECT 1 FROM upd)
      RETURNING id
    ),
    aud AS (
      INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata)
      SELECT ${adminId}::varchar, 'admin', 'event.cancel', 'event', upd.id, jsonb_build_object('status', cur.status), jsonb_build_object('status', upd.status),
             jsonb_build_object('reason', ${reason}::text, 'reports_closed', (SELECT count(*) FROM rep))
      FROM upd JOIN cur ON cur.id = upd.id
      RETURNING id
    )
    SELECT (SELECT count(*) FROM cur)::int AS found, (SELECT count(*) FROM upd)::int AS changed, (SELECT count(*) FROM aud)::int AS audited`);
  if (!r?.found) return { ok: false, code: "EVENT_NOT_FOUND" };
  if (!Number(r.changed)) return { ok: false, code: "NOT_CANCELLABLE" };
  try {
    const { queueCancelledEventOrders, processTicketRefund } = await import("./ticketRefunds");
    const { notifyFreeOrdersCancelled } = await import("./ticketNotices");
    const qd = await queueCancelledEventOrders(eventId);
    void notifyFreeOrdersCancelled(qd.freeCancelled);
    setImmediate(async () => {
      for (const id of qd.refunding) await processTicketRefund(id, undefined, true).catch((err) => console.error(`[Reports] refund ${id} failed:`, err));
    });
  } catch (err) {
    console.error("[Reports] admin cancel guests step failed (the refund job will repeat it):", err);
  }
  setImmediate(() => {
    import("./ticketRefunds")
      .then((m) => m.closePendingCheckouts(eventId))
      .catch((err) => console.error("[Reports] closing checkouts failed:", err));
  });
  await notifyHostModeration(eventId, "cancel", reason);
  return { ok: true, status: "cancelled" };
}

/** Close an event's pending reports without touching the event. */
export async function dismissEventReports(eventId: string, adminId: string, reason: string): Promise<AdminActionResult> {
  const [r] = await rows<any>(sql`
    WITH cur AS (SELECT id FROM events WHERE id = ${eventId}),
    rep AS (
      UPDATE moderation_queue SET status = 'reviewed', admin_action = 'dismiss', admin_notes = ${reason}, reviewed_by = ${adminId}, reviewed_at = now()
      WHERE target_type = 'event' AND target_id = ${eventId} AND status = 'pending' AND EXISTS (SELECT 1 FROM cur)
      RETURNING id
    ),
    aud AS (
      INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, metadata)
      SELECT ${adminId}::varchar, 'admin', 'event.reports_dismissed', 'event', cur.id, jsonb_build_object('reason', ${reason}::text, 'reports_closed', (SELECT count(*) FROM rep))
      FROM cur
      RETURNING id
    )
    SELECT (SELECT count(*) FROM cur)::int AS found, (SELECT count(*) FROM rep)::int AS dismissed, (SELECT count(*) FROM aud)::int AS audited`);
  if (!r?.found) return { ok: false, code: "EVENT_NOT_FOUND" };
  return { ok: true, dismissed: Number(r.dismissed) };
}

/** T7: trusted host on (a row) or off (no row), with its audit row. */
export async function setHostTrust(userId: string, adminId: string, trusted: boolean, note: string | null): Promise<AdminActionResult & { trusted?: boolean }> {
  const [r] = await rows<any>(sql`
    WITH u AS (SELECT id FROM users WHERE id = ${userId}),
    was AS (SELECT user_id FROM event_host_trust WHERE user_id = ${userId}),
    ins AS (
      INSERT INTO event_host_trust (user_id, trusted_by, trusted_at, note)
      SELECT u.id, ${adminId}, now(), ${note} FROM u WHERE ${trusted}
      ON CONFLICT (user_id) DO UPDATE SET trusted_by = EXCLUDED.trusted_by, trusted_at = now(), note = EXCLUDED.note
      RETURNING user_id
    ),
    del AS (DELETE FROM event_host_trust WHERE user_id = ${userId} AND NOT ${trusted} RETURNING user_id),
    aud AS (
      INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, before_state, after_state, metadata)
      SELECT ${adminId}::varchar, 'admin', ${trusted ? "event_host.trust" : "event_host.untrust"}::text, 'user', u.id,
             jsonb_build_object('trusted', EXISTS (SELECT 1 FROM was)), jsonb_build_object('trusted', ${trusted}::boolean),
             jsonb_build_object('note', ${note}::text)
      FROM u
      RETURNING id
    )
    SELECT (SELECT count(*) FROM u)::int AS found, (SELECT count(*) FROM aud)::int AS audited`);
  if (!r?.found) return { ok: false, code: "HOST_NOT_FOUND" };
  return { ok: true, trusted };
}

/** For the admin event detail (additive): pending reports and the host's limit state. */
export async function moderationSummary(eventId: string): Promise<{ pendingReports: number; hostLimited: boolean; hostTrusted: boolean; hostType: string | null }> {
  const [r] = await rows<any>(sql`
    SELECT e.host_type,
           (SELECT count(DISTINCT reporter_id) FROM moderation_queue m WHERE m.target_type = 'event' AND m.target_id = e.id AND m.status = 'pending')::int AS pending,
           EXISTS (SELECT 1 FROM event_host_trust ht WHERE ht.user_id = e.host_user_id) AS trusted,
           ${LIMITED_HOST(sql.raw("e"))} AS limited
    FROM events e WHERE e.id = ${eventId}`);
  return { pendingReports: Number(r?.pending ?? 0), hostLimited: !!r?.limited, hostTrusted: !!r?.trusted, hostType: r?.host_type ?? null };
}

/** Pending reports, grouped by event or by post, most reported first. Reporter usernames only (admin page). */
export async function listReports(type: "event" | "post"): Promise<any[]> {
  if (type === "event") {
    const list = await rows<any>(sql`
      SELECT e.id AS event_id, e.title, e.slug, e.status, e.starts_at, e.host_user_id, hu.username AS host_username, hu.first_name AS host_first_name,
             count(DISTINCT m.reporter_id)::int AS report_count, min(m.created_at) AS first_at, max(m.created_at) AS last_at,
             json_agg(json_build_object('reason', m.reason, 'note', m.details, 'reporter', ru.username, 'at', m.created_at) ORDER BY m.created_at) AS reasons
      FROM moderation_queue m JOIN events e ON e.id = m.target_id
      JOIN users hu ON hu.id = e.host_user_id LEFT JOIN users ru ON ru.id = m.reporter_id
      WHERE m.target_type = 'event' AND m.status = 'pending'
      GROUP BY e.id, hu.username, hu.first_name
      ORDER BY count(DISTINCT m.reporter_id) DESC, max(m.created_at) DESC
      LIMIT 200`);
    return list.map((x) => ({
      eventId: x.event_id, title: x.title, slug: x.slug, status: x.status, startsAt: x.starts_at == null ? null : new Date(x.starts_at).toISOString(),
      host: { id: x.host_user_id, username: x.host_username, firstName: x.host_first_name },
      reportCount: Number(x.report_count), firstAt: new Date(x.first_at).toISOString(), lastAt: new Date(x.last_at).toISOString(),
      reasons: (x.reasons ?? []).map((r: any) => ({ reason: r.reason, label: (REPORT_REASONS as any)[r.reason] ?? r.reason, note: r.note ?? null, reporter: r.reporter ?? null, at: r.at })),
    }));
  }
  const list = await rows<any>(sql`
    SELECT p.id AS post_id, left(p.content, 280) AS content, COALESCE(p.thumbnail_url, p.image_url, p.media_url) AS media, p.is_active, p.author_id, au.username AS author_username,
           count(DISTINCT m.reporter_id)::int AS report_count, sum(m.flag_count)::int AS flags, max(m.created_at) AS last_at,
           json_agg(json_build_object('reason', m.reason, 'reporter', ru.username, 'at', m.created_at) ORDER BY m.created_at) AS reasons
    FROM moderation_queue m JOIN feed_posts p ON p.id = m.target_id
    LEFT JOIN users au ON au.id = p.author_id LEFT JOIN users ru ON ru.id = m.reporter_id
    WHERE m.target_type = 'post' AND m.status = 'pending'
    GROUP BY p.id, au.username
    ORDER BY count(DISTINCT m.reporter_id) DESC, max(m.created_at) DESC
    LIMIT 200`);
  return list.map((x) => ({
    postId: x.post_id, content: x.content, mediaUrl: x.media ?? null, active: x.is_active !== false,
    author: { id: x.author_id, username: x.author_username },
    reportCount: Number(x.report_count), flagCount: Number(x.flags), lastAt: new Date(x.last_at).toISOString(),
    reasons: (x.reasons ?? []).map((r: any) => ({ reason: r.reason, reporter: r.reporter ?? null, at: r.at })),
  }));
}

// ─── T9: tell the host ──────────────────────────────────────────────────────

const PUSH: Record<"pause" | "release" | "cancel", { title: string; body: (t: string) => string }> = {
  pause: { title: "Your event is on hold", body: (t) => `${t} is on hold while Outsyde reviews it. Check your email for details.` },
  release: { title: "Your event is live again", body: (t) => `${t} is live again. Check your email for details.` },
  cancel: { title: "Your event was cancelled", body: (t) => `${t} was cancelled by Outsyde. Check your email for details.` },
};

/** Email + push to the host. Never throws (the action already happened). */
export async function notifyHostModeration(eventId: string, kind: "pause" | "release" | "cancel", reason: string): Promise<void> {
  try {
    const { noticeDeps } = await import("./ticketNotices");
    const d = await noticeDeps();
    const [e] = await rows<any>(sql`
      SELECT e.id, e.title, e.host_user_id, u.email, u.first_name FROM events e JOIN users u ON u.id = e.host_user_id WHERE e.id = ${eventId}`);
    if (!e) return;
    if (e.email && d.sendModeration) {
      await d.sendModeration({ userId: e.host_user_id, toEmail: e.email, firstName: e.first_name ?? null, kind, eventTitle: e.title, reason }).catch((err) =>
        console.error(`[Reports] host ${kind} email failed for event ${eventId}:`, (err as Error)?.message ?? err));
    }
    await d.sendPush({ userId: e.host_user_id, title: PUSH[kind].title, body: PUSH[kind].body(e.title), data: { type: "event_moderation", action: kind, eventId } });
  } catch (err) {
    console.error(`[Reports] host ${kind} notice failed for event ${eventId}:`, (err as Error)?.message ?? err);
  }
}
