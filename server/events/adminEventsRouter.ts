/**
 * Admin events money (goutsyde.com/admin/events). Mounted at /api/admin/events, every route behind requirePlatformAdmin.
 *
 *   GET /api/admin/events?from=&to=   { success, range, totals, attention, events }
 *   GET /api/admin/events/:id         { success, event, ticketTypes, orders, checkIns, payout, recoveries, host, activity }
 *
 * Read only. Shapes and money rules: adminEventsQueries.ts and docs/superpowers/specs/2026-10-23-admin-events-money-design.md.
 * No response carries an email address, a full Stripe account id or a person's real name.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin";
import { hostPayoutDestination } from "./hostPayouts";
import {
  listAdminEvents, listAttention, totalsOf, loadAdminEventRow, loadTicketTypes, loadRecoveries, loadActivity,
  payoutDetailOf, maskAccount, payoutSetupOf,
} from "./adminEventsQueries";

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/** ISO date (YYYY-MM-DD) or ISO date-time with Z or an offset. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const isoParam = z.string().trim().max(40).regex(ISO_RE).refine((v) => Number.isFinite(Date.parse(v)));
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
