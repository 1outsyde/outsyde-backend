/**
 * Admin events money (goutsyde.com/admin/events). Mounted at /api/admin/events, every route behind requirePlatformAdmin.
 *
 *   GET /api/admin/events?from=&to=   { success, range, totals, attention, events }
 *   GET /api/admin/events/:id         { success, event, ticketTypes, orders, checkIns, payout, recoveries, host, activity }
 *   POST /api/admin/events/payouts/:payoutId/retry          { success, payout: { id, status, attempts, nextAttemptAt } }
 *   POST /api/admin/events/recoveries/:recoveryId/resolve   body { action: "collected" | "written_off" } -> { success, recovery: { id, status, resolvedAt } }
 *   POST /api/admin/events/payouts/:payoutId/email-host     { success, sent: true, notice: "held" | "review" }
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
  retryPayout, resolveRecovery, loadHostEmailTarget, claimHostEmail, releaseHostEmail, hostEmailCopy, RECOVERY_ACTIONS,
} from "./adminEventsActions";
import {
  listAdminEvents, listAttention, totalsOf, loadAdminEventRow, loadTicketTypes, loadRecoveries, loadActivity,
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
    res.json({
      success: true,
      range: { from, to, default: !from && !to },
      totals: totalsOf(events),
      attention,
      events,
    });
  } catch (err) {
    console.error("[AdminEvents] list failed:", err);
    fail(res, 500, "SERVER_ERROR", "Couldn't load events.");
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
      host: {
        ...event.host,
        payoutReady: setup === "ready", payoutSetup: setup,
        destinationType: dest.destinationType, connectedAccount: maskAccount(dest.accountId),
      },
      activity,
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
