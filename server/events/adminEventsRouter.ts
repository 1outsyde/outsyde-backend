/**
 * Admin events money (goutsyde.com/admin/events). Mounted at /api/admin/events, every route behind requirePlatformAdmin.
 *
 *   GET /api/admin/events?from=&to=   { success, range, totals, attention, events }
 *   GET /api/admin/events/:id         { success, event, ticketTypes, orders, checkIns, payout, recoveries, host, activity }
 *   POST /api/admin/events/payouts/:payoutId/retry          { success, payout: { id, status, attempts, nextAttemptAt } }
 *   POST /api/admin/events/recoveries/:recoveryId/resolve   body { action: "collected" | "written_off" } -> { success, recovery: { id, status, resolvedAt } }
 *   POST /api/admin/events/payouts/:payoutId/email-host     { success, sent: true, notice: "held" | "review" }
 *        (only when the payout waits on the host: never for a paused or cancelled event or a Stripe amount mismatch)
 *
 * Shapes and money rules: adminEventsQueries.ts; actions (one SQL statement each, audit_logs in the same statement):
 * adminEventsActions.ts. Spec: docs/superpowers/specs/2026-10-23-admin-events-money-design.md.
 * No response carries an email address, a full Stripe account id or a person's real name.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin";
import { hostPayoutDestination } from "./hostPayouts";
import {
  retryPayout, resolveRecovery, loadHostEmailTarget, isHostIssue, claimHostEmail, releaseHostEmail, hostEmailCopy, RECOVERY_ACTIONS,
} from "./adminEventsActions";
import {
  listAdminEvents, listAttention, listTeamAttention, totalsOf, loadAdminEventRow, loadTicketTypes, loadRecoveries, loadActivity,
  payoutDetailOf, maskAccount, payoutSetupOf,
} from "./adminEventsQueries";

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/** ISO date (YYYY-MM-DD) or ISO date-time with Z or an offset. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;
/**
 * A real calendar moment: Date.parse rolls impossible dates over (2026-02-30 becomes March 2) and takes 24:00, so the
 * parts are checked themselves.
 */
export function isRealIsoMoment(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2})))?$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59)) return false;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return Number.isFinite(Date.parse(v));
}
const isoParam = z.string().trim().max(40).regex(ISO_RE).refine(isRealIsoMoment);
export const rangeSchema = z.object({
  from: isoParam.optional(),
  to: isoParam.optional(),
}).refine((r) => !r.from || !r.to || Date.parse(r.from) < Date.parse(r.to), { message: "from must be before to" });

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export const adminEventsRouter = Router();
adminEventsRouter.use(requirePlatformAdmin);

adminEventsRouter.get("/", async (req, res) => {
  const parsed = rangeSchema.safeParse({
    from: typeof req.query.from === "string" && req.query.from !== "" ? req.query.from : undefined,
    to: typeof req.query.to === "string" && req.query.to !== "" ? req.query.to : undefined,
  });
  if (!parsed.success || Array.isArray(req.query.from) || Array.isArray(req.query.to)) {
    return fail(res, 400, "BAD_RANGE", "Pick a valid date range.");
  }
  const from = parsed.data.from ? new Date(parsed.data.from).toISOString() : null;
  const to = parsed.data.to ? new Date(parsed.data.to).toISOString() : null;
  try {
    const [events, attention] = await Promise.all([listAdminEvents({ from, to }), listAttention()]);
    // Step 4b-2: team pay items in their own field (today's page reads only `attention`). Its own try: never fails the list.
    let teamAttention: Awaited<ReturnType<typeof listTeamAttention>> = [];
    try { teamAttention = await listTeamAttention(); } catch (err) { console.error("[AdminEvents] team attention failed (list sent without it):", err); }
    res.json({
      success: true,
      range: { from, to, default: !from && !to },
      totals: totalsOf(events),
      attention,
      teamAttention,
      events,
    });
  } catch (err) {
    console.error("[AdminEvents] list failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't load events.");
  }
});

// ─── p5-safety (Legend's calls T7, T8): reports and moderation ──────────────
// Registered before GET /:id so "reports" and "hosts" are never read as an event id.

const reportsQuerySchema = z.object({ type: z.enum(["event", "post"]).default("event") });

/** Pending reports grouped by event (default) or by post, most reported first. */
adminEventsRouter.get("/reports", async (req, res) => {
  const parsed = reportsQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", "type must be event or post.");
  try {
    const { listReports } = await import("./eventModeration");
    const items = await listReports(parsed.data.type);
    res.json({ success: true, type: parsed.data.type, items });
  } catch (err) {
    console.error("[AdminEvents] reports failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't load reports.");
  }
});

const moderationReasonSchema = z.object({ reason: z.string().trim().min(1, "Add a reason.").max(500) }).strict();
const MODERATION_MESSAGES: Record<string, [number, string]> = {
  EVENT_NOT_FOUND: [404, "Event not found."],
  NOT_PUBLISHED: [409, "Only a live event can be paused. Reload to see where it is."],
  NOT_PAUSED: [409, "Only a paused event can be released. Reload to see where it is."],
  NOT_CANCELLABLE: [409, "Only a live or paused event can be cancelled here. Reload to see where it is."],
  HOST_NOT_FOUND: [404, "Host not found."],
};

for (const [path, fn] of [
  ["pause", "pauseEvent"], ["release", "releaseEvent"], ["cancel", "cancelEventByAdmin"], ["reports/dismiss", "dismissEventReports"],
] as const) {
  adminEventsRouter.post(`/:id/${path}`, async (req, res) => {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const parsed = moderationReasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "INVALID_INPUT", parsed.error.errors[0]?.message ?? "Add a reason.");
    try {
      const mod = await import("./eventModeration");
      const r = await (mod as any)[fn](id, adminIdOf(req), parsed.data.reason);
      if (r.ok) return res.json({ success: true, ...(r.status ? { status: r.status } : {}), ...(r.dismissed !== undefined ? { dismissed: r.dismissed } : {}) });
      const [status, message] = MODERATION_MESSAGES[r.code] ?? [409, "That didn't work. Reload and try again."];
      return fail(res, status, r.code, message);
    } catch (err) {
      console.error(`[AdminEvents] ${path} failed:`, err);
      fail(res, 500, "SERVER_ERROR", "Couldn't do that. Try again.");
    }
  });
}

const trustSchema = z.object({ trusted: z.boolean(), note: z.string().trim().max(500).optional() }).strict();

/** Trusted host on or off: first event limits don't apply to a trusted personal host. */
adminEventsRouter.post("/hosts/:userId/trust", async (req, res) => {
  const id = String(req.params.userId);
  if (!ID_RE.test(id)) return fail(res, 404, "HOST_NOT_FOUND", "Host not found.");
  const parsed = trustSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", "trusted must be true or false.");
  try {
    const { setHostTrust } = await import("./eventModeration");
    const r = await setHostTrust(id, adminIdOf(req), parsed.data.trusted, parsed.data.note || null);
    if (!r.ok) return fail(res, 404, "HOST_NOT_FOUND", "Host not found.");
    res.json({ success: true, trusted: r.trusted });
  } catch (err) {
    console.error("[AdminEvents] trust failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't change this host.");
  }
});

adminEventsRouter.get("/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
  try {
    const found = await loadAdminEventRow(id);
    if (!found) return fail(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    const { raw, event } = found;
    const [ticketTypes, recoveries, activity, dest] = await Promise.all([
      loadTicketTypes(id), loadRecoveries(id), loadActivity(id),
      // The readiness helper the payout job uses (local record only, no Stripe call).
      hostPayoutDestination({
        host_type: raw.host_type, host_user_id: raw.host_user_id,
        host_business_id: raw.host_business_id, host_photographer_id: raw.host_photographer_id,
      }),
    ]);
    const setup = payoutSetupOf({ accountId: dest.accountId, localReady: dest.localReady });
    res.json({
      success: true,
      event: {
        ...event,
        createdAt: raw.created_at == null ? null : new Date(raw.created_at).toISOString(),
        publishedAt: raw.published_at == null ? null : new Date(raw.published_at).toISOString(),
        cancelledAt: raw.cancelled_at == null ? null : new Date(raw.cancelled_at).toISOString(),
      },
      ticketTypes,
      orders: {
        completed: Number(raw.orders_completed ?? 0), refunded: Number(raw.orders_refunded ?? 0),
        refunding: Number(raw.orders_refunding ?? 0), flagged: Number(raw.orders_flagged ?? 0),
      },
      checkIns: { checkedIn: Number(raw.checked_in ?? 0), validTickets: event.ticketsValid },
      payout: payoutDetailOf(raw, event.payoutDueAt),
      recoveries,
      // Step 4b-2: each team member's pay for this event (additive; today's page doesn't read it).
      teamPayouts: await (async () => {
        try {
          const { teamPayoutsForHost } = await import("./teamSend");
          return (await teamPayoutsForHost(id)).map((t) => ({ ...t, breakdown: undefined }));
        } catch (err) {
          console.error("[AdminEvents] team payouts failed (detail sent without them):", err);
          return [];
        }
      })(),
      host: {
        ...event.host,
        payoutReady: setup === "ready", payoutSetup: setup,
        destinationType: dest.destinationType, connectedAccount: maskAccount(dest.accountId),
      },
      activity,
      // p5-safety (additive): pending reports and whether the host is under the first event limits / trusted.
      moderation: await (async () => {
        try {
          const { moderationSummary } = await import("./eventModeration");
          return await moderationSummary(id);
        } catch (err) {
          console.error("[AdminEvents] moderation summary failed (detail sent without it):", err);
          return null;
        }
      })(),
    });
  } catch (err) {
    console.error("[AdminEvents] detail failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't load this event.");
  }
});

// ─── Actions (each behind a confirm step on the web) ────────────────────────

const adminIdOf = (req: any): string => String(req.adminUser?.id ?? "");

/** Try again: a payout in review goes back to pending with attempts 0, only while the event is published. */
adminEventsRouter.post("/payouts/:payoutId/retry", async (req, res) => {
  const id = String(req.params.payoutId);
  if (!ID_RE.test(id)) return fail(res, 404, "PAYOUT_NOT_FOUND", "Payout not found.");
  try {
    const r = await retryPayout(id, adminIdOf(req));
    if (r.ok) return res.json({ success: true, payout: r.payout });
    if (r.code === "PAYOUT_NOT_FOUND") return fail(res, 404, r.code, "Payout not found.");
    if (r.code === "EVENT_NOT_PUBLISHED") return fail(res, 409, r.code, "This event isn't published, so its payout can't be sent.");
    return fail(res, 409, r.code, "This payout isn't in review any more. Reload to see where it is.");
  } catch (err) {
    console.error("[AdminEvents] retry failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't retry this payout.");
  }
});

const resolveSchema = z.object({ action: z.enum(RECOVERY_ACTIONS) }).strict();

/** Mark collected or Write off: an owed recovery leaves the owed list and is no longer taken from the next payout. */
adminEventsRouter.post("/recoveries/:recoveryId/resolve", async (req, res) => {
  const id = String(req.params.recoveryId);
  if (!ID_RE.test(id)) return fail(res, 404, "RECOVERY_NOT_FOUND", "Refund recovery not found.");
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "BAD_ACTION", "Pick Mark collected or Write off.");
  try {
    const r = await resolveRecovery(id, parsed.data.action, adminIdOf(req));
    if (r.ok) return res.json({ success: true, recovery: r.recovery });
    if (r.code === "RECOVERY_NOT_FOUND") return fail(res, 404, r.code, "Refund recovery not found.");
    return fail(res, 409, r.code, "This amount isn't owed any more. Reload to see where it is.");
  } catch (err) {
    console.error("[AdminEvents] resolve failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't update this amount.");
  }
});

/**
 * Email the host about a held or review payout. At most once per payout every 24 hours, and not once today's email
 * total reaches 70. The claim (audit row) is written first, so a double click sends one email; a failed send gives
 * the claim back. The host's address is read here only: never returned, logged or stored in audit_logs.
 */
adminEventsRouter.post("/payouts/:payoutId/email-host", async (req, res) => {
  const id = String(req.params.payoutId);
  if (!ID_RE.test(id)) return fail(res, 404, "PAYOUT_NOT_FOUND", "Payout not found.");
  try {
    const t = await loadHostEmailTarget(id);
    if (!t) return fail(res, 404, "PAYOUT_NOT_FOUND", "Payout not found.");
    if (t.status !== "held" && t.status !== "review") {
      return fail(res, 409, "NOT_HELD_OR_REVIEW", "Only a payout on hold or in review can be sent to the host.");
    }
    if (!isHostIssue(t)) return fail(res, 409, "NOT_A_HOST_ISSUE", "This payout is not waiting on the host.");
    if (!t.toEmail) return fail(res, 409, "HOST_NO_EMAIL", "This host has no email on their account.");
    const notice = t.status as "held" | "review";
    const claim = await claimHostEmail(id, adminIdOf(req), notice);
    if (!claim.ok) {
      if (claim.code === "EMAIL_RECENTLY_SENT") return fail(res, 429, claim.code, "The host was emailed about this payout in the last 24 hours.");
      if (claim.code === "EMAIL_BUDGET") return fail(res, 503, claim.code, "Today's email budget is used up. Try again tomorrow.");
      return fail(res, 409, claim.code, "Only a payout on hold or in review can be sent to the host.");
    }
    const { subject, text } = hostEmailCopy(notice, t.title);
    try {
      const { sendEventPayoutHostEmail } = await import("../emailService");
      await sendEventPayoutHostEmail({ to: t.toEmail, subject, text });
    } catch (sendErr) {
      await releaseHostEmail(claim.auditId).catch((e) => console.error(`[AdminEvents] couldn't release email claim ${claim.auditId}:`, (e as Error)?.message ?? e));
      // The provider's text can quote the address: drop anything that looks like one.
      const msg = String((sendErr as Error)?.message ?? sendErr).replace(/\S+@\S+/g, "[address]").slice(0, 200);
      console.error(`[AdminEvents] host email for payout ${id} failed: ${msg}`);
      return fail(res, 502, "EMAIL_FAILED", "The email didn't go out. Try again in a minute.");
    }
    res.json({ success: true, sent: true, notice });
  } catch (err) {
    console.error("[AdminEvents] email host failed:", (err as Error)?.message ?? err);
    fail(res, 500, "SERVER_ERROR", "Couldn't email the host.");
  }
});
