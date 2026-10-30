/**
 * /api/events — Events & Ticketing, Phase 1 PR 2: ticket types (host) + free RSVP (guests).
 *
 *   POST   /:id/ticket-types              (auth, host)  add a ticket type
 *   PATCH  /:id/ticket-types/:typeId      (auth, host)  edit one
 *   DELETE /:id/ticket-types/:typeId      (auth, host)  delete if never used, else archive (stop selling)
 *   POST   /:id/rsvp                      (auth)        claim free tickets
 *   POST   /orders/:orderId/cancel        (auth, buyer) cancel my free RSVP
 *   GET    /me/tickets                    (auth)        my tickets with their QR codes
 *
 * neon-http has no transactions, so a claim and a cancel are ONE SQL statement each. The CHECKs from
 * migration 056 stop overselling (ticket type, event capacity, per-account limit). Data-modifying CTEs
 * all run even when a later one matches nothing, so each statement ends with a guard that raises an
 * error (rolling the whole statement back) when the parts didn't all happen.
 * Paid tickets: refused until Phase 2 (checkout, fees, payouts).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { getUserIdFromRequest, hybridAuthMiddleware } from "../auth";
import {
  rows, pgError, iso, fail, zodError, optionalText, loadActiveUser, loadEventAccess, cohostBlocked, loadTicketTypes, hostTicketTypeJson,
} from "./eventsRouter";
import { makeTicketCode, paidEventsEnabled, wouldCreateUnlockLoop, holderCanSeeAddress, visibleAddress, addressRevealAt } from "./eventRules";
import { qrUrlFor } from "./ticketQr";
import { walletUrlFor } from "./walletPass";
import { notifyRsvpConfirmed } from "./ticketNotices";
import { normalizeLinkCode, promoterLinkIdSql } from "./promoterLinks";

const router = Router();

const MAX_PER_ORDER = 20;

/** Error text the guards raise; Postgres reports it as `invalid input syntax for type integer: "GUARD_<CODE>:n"`. */
export function guardCode(err: unknown): string | null {
  const pe = pgError(err);
  if (pe.code !== "22P02") return null;
  const m = /"GUARD_([A-Z_]+):\d+"/.exec(pe.message ?? "");
  return m ? m[1] : null;
}

/**
 * Paid tickets on an event that is already published: switch off -> PAID_TICKETS_NOT_AVAILABLE; switch on but the
 * host can't be paid yet -> PAYOUTS_NOT_SET_UP; otherwise allowed. Answers the request itself when refused.
 */
async function paidOnPublishedAllowed(res: Response, e: any): Promise<boolean> {
  if (!paidEventsEnabled()) {
    fail(res, 409, "PAID_TICKETS_NOT_AVAILABLE", "Paid tickets aren't available yet. Use free tickets for now.");
    return false;
  }
  const { isHostReady } = await import("./hostPayouts");
  if (!(await isHostReady(e)).ready) {
    fail(res, 409, "PAYOUTS_NOT_SET_UP", "Set up payouts before selling paid tickets.");
    return false;
  }
  return true;
}

/** Two statements that lock the same rows in a different order can deadlock; Postgres aborts one (fully rolled back). Retry it. */
export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (pgError(err).code === "40P01" && attempt < 3) continue;
      throw err;
    }
  }
}

// ─── Ticket types (host) ────────────────────────────────────────────────────

const price = z.number().int().refine((v) => v === 0 || (v >= 100 && v <= 1_000_000), "0 for free, or $1.00 to $10,000.00");

const typeFields = {
  name: z.string().trim().min(1).max(80),
  description: optionalText(1000),
  priceCents: price,
  quantity: z.number().int().min(1).max(100000),
  salesStartAt: z.string().datetime({ offset: true }).nullable().optional(),
  salesEndAt: z.string().datetime({ offset: true }).nullable().optional(),
  unlockAfterTicketTypeId: z.string().min(1).max(64).nullable().optional(),
  minPerOrder: z.number().int().min(1).max(MAX_PER_ORDER).optional(),
  maxPerOrder: z.number().int().min(1).max(MAX_PER_ORDER).optional(),
  perAccountLimit: z.number().int().min(1).max(1000).nullable().optional(),
  hidden: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

const createTypeSchema = z.object(typeFields).strict();
const updateTypeSchema = z.object({
  ...typeFields,
  name: typeFields.name.optional(),
  priceCents: typeFields.priceCents.optional(),
  quantity: typeFields.quantity.optional(),
}).strict();

const TYPE_COLUMNS: Record<string, string> = {
  name: "name", description: "description", priceCents: "price_cents", quantity: "quantity",
  salesStartAt: "sales_start_at", salesEndAt: "sales_end_at", unlockAfterTicketTypeId: "unlock_after_ticket_type_id",
  minPerOrder: "min_per_order", maxPerOrder: "max_per_order", perAccountLimit: "per_account_limit",
  hidden: "hidden", sortOrder: "sort_order",
};

function typeConstraintError(res: Response, err: unknown) {
  const pe = pgError(err);
  if (pe.code === "23514") {
    if (pe.constraint === "ticket_types_quantity_not_exceeded") return fail(res, 409, "QUANTITY_BELOW_TAKEN", "Quantity can't be lower than the tickets already taken.");
    if (pe.constraint === "ticket_types_order_limits") return fail(res, 400, "INVALID_ORDER_LIMITS", "The most per order has to be at least the least per order.");
    if (pe.constraint === "ticket_types_sales_window") return fail(res, 400, "INVALID_SALES_WINDOW", "Sales have to end after they start.");
  }
  return null;
}

/** Host's event that can still be changed. Co-hosts need the edit level (step 2b). */
async function editableEvent(req: Request, res: Response): Promise<{ userId: string; e: any } | null> {
  const userId = getUserIdFromRequest(req);
  if (!userId) { fail(res, 401, "NO_AUTH", "Sign in to manage tickets."); return null; }
  if (!(await loadActiveUser(userId))) { fail(res, 403, "ACCOUNT_INACTIVE", "This account can't host events."); return null; }
  const a = await loadEventAccess(req.params.id, userId);
  if (!a) { fail(res, 404, "EVENT_NOT_FOUND", "Event not found."); return null; }
  if (cohostBlocked(res, a, "edit")) return null;
  const e = a.event;
  if (e.status === "cancelled") { fail(res, 409, "EVENT_CANCELLED", "A cancelled event can't be changed."); return null; }
  if (e.status === "paused") { fail(res, 409, "EVENT_PAUSED", "This event is paused by Outsyde. Contact support."); return null; }
  return { userId, e };
}

async function checkUnlock(res: Response, eventId: string, typeId: string | null, unlockAfter: string | null | undefined): Promise<boolean> {
  if (!unlockAfter) return true;
  const types = await loadTicketTypes(eventId);
  const target = types.find((t) => t.id === unlockAfter);
  if (!target || target.status !== "active") { fail(res, 400, "INVALID_UNLOCK", "Pick a ticket type from this event to open after."); return false; }
  if (typeId) {
    const parentOf = new Map<string, string | null>(types.map((t) => [t.id, t.unlock_after_ticket_type_id ?? null]));
    if (wouldCreateUnlockLoop(typeId, unlockAfter, parentOf)) { fail(res, 400, "INVALID_UNLOCK", "Two ticket types can't wait on each other."); return false; }
  }
  return true;
}

router.post("/:id/ticket-types", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const parsed = createTypeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodError(res, parsed.error);
  const b = parsed.data;
  try {
    const ctx = await editableEvent(req, res);
    if (!ctx) return;
    const { e } = ctx;
    const paidOnPublished = b.priceCents > 0 && e.status !== "draft";
    if (paidOnPublished && !(await paidOnPublishedAllowed(res, e))) return;
    if (!(await checkUnlock(res, e.id, null, b.unlockAfterTicketTypeId))) return;
    const free = b.priceCents === 0;
    // Free RSVP defaults: 1 per order and 1 per account (the host can raise both).
    const minPer = b.minPerOrder ?? 1;
    const maxPer = b.maxPerOrder ?? (free ? 1 : 10);
    const perAccount = b.perAccountLimit !== undefined ? b.perAccountLimit : free ? 1 : null;
    if (perAccount != null && maxPer > perAccount) {
      return fail(res, 400, "INVALID_ORDER_LIMITS", "The most per order can't be more than the limit per person.");
    }
    try {
      const [created] = await rows(sql`
        INSERT INTO ticket_types (
          event_id, name, description, price_cents, quantity, sales_start_at, sales_end_at,
          unlock_after_ticket_type_id, min_per_order, max_per_order, per_account_limit, hidden, sort_order
        )
        SELECT ${e.id}, ${b.name}, ${b.description ?? null}, ${b.priceCents}, ${b.quantity}, ${b.salesStartAt ?? null},
               ${b.salesEndAt ?? null}, ${b.unlockAfterTicketTypeId ?? null}, ${minPer}, ${maxPer}, ${perAccount},
               ${b.hidden ?? false}, ${b.sortOrder ?? 0}
        FROM events WHERE id = ${e.id} AND host_user_id = ${e.host_user_id} AND status IN ('draft', 'published')
          AND (${b.priceCents} = 0 OR status = 'draft' OR ${paidOnPublished})
        RETURNING *`);
      if (!created) return fail(res, 409, "EVENT_CHANGED", "This event just changed. Reload and try again.");
      return res.status(201).json({ success: true, ticketType: hostTicketTypeJson(created) });
    } catch (err) {
      if (typeConstraintError(res, err)) return;
      throw err;
    }
  } catch (err) {
    console.error("[Events] create ticket type failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't add the ticket type.");
  }
});

router.patch("/:id/ticket-types/:typeId", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const parsed = updateTypeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodError(res, parsed.error);
  const b = parsed.data as Record<string, any>;
  if (Object.keys(b).length === 0) return fail(res, 400, "NOTHING_TO_UPDATE", "Nothing to update.");
  try {
    const ctx = await editableEvent(req, res);
    if (!ctx) return;
    const { e } = ctx;
    const [t] = await rows<any>(sql`SELECT * FROM ticket_types WHERE id = ${req.params.typeId} AND event_id = ${e.id}`);
    if (!t) return fail(res, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found.");
    if (t.status !== "active") return fail(res, 409, "TICKET_TYPE_ARCHIVED", "This ticket type was removed.");
    let patchPaidAllowed = false;
    // Edits that keep the saved price are not gated: readiness was checked when the type became paid.
    const priceUnchanged = b.priceCents === undefined || b.priceCents === Number(t.price_cents);
    if (b.priceCents !== undefined && b.priceCents !== Number(t.price_cents)) {
      if (Number(t.reserved_count) > 0) return fail(res, 409, "PRICE_LOCKED", "The price can't change once tickets are taken.");
      if (b.priceCents > 0 && e.status !== "draft") {
        patchPaidAllowed = true;
        if (!(await paidOnPublishedAllowed(res, e))) return;
      }
    }
    if (b.unlockAfterTicketTypeId !== undefined && !(await checkUnlock(res, e.id, t.id, b.unlockAfterTicketTypeId))) return;
    const nextMax = b.maxPerOrder ?? Number(t.max_per_order);
    const nextLimit = b.perAccountLimit !== undefined ? b.perAccountLimit : t.per_account_limit == null ? null : Number(t.per_account_limit);
    if (nextLimit != null && nextMax > nextLimit) {
      return fail(res, 400, "INVALID_ORDER_LIMITS", "The most per order can't be more than the limit per person.");
    }

    const sets: SQL[] = Object.keys(b)
      .filter((k) => TYPE_COLUMNS[k])
      .map((k) => sql`${sql.raw(TYPE_COLUMNS[k])} = ${b[k] ?? null}`);
    sets.push(sql`updated_at = now()`);
    try {
      // Lands only if nobody took a ticket since the price check above, and the event is still editable.
      const [updated] = await rows(sql`
        UPDATE ticket_types SET ${sql.join(sets, sql`, `)}
        WHERE id = ${t.id} AND event_id = ${e.id} AND status = 'active'
          AND (${b.priceCents === undefined} OR reserved_count = 0 OR price_cents = ${b.priceCents ?? 0})
          AND EXISTS (SELECT 1 FROM events ev WHERE ev.id = ${e.id} AND ev.status IN ('draft', 'published')
                      AND (ev.status = 'draft' OR ${patchPaidAllowed} OR ${b.priceCents === undefined ? Number(t.price_cents) : b.priceCents} = 0
                           OR (${priceUnchanged} AND ticket_types.price_cents = ${Number(t.price_cents)})))
        RETURNING *`);
      if (!updated) return fail(res, 409, "TICKET_TYPE_CHANGED", "This ticket type just changed. Reload and try again.");
      return res.json({ success: true, ticketType: hostTicketTypeJson(updated) });
    } catch (err) {
      if (typeConstraintError(res, err)) return;
      throw err;
    }
  } catch (err) {
    console.error("[Events] update ticket type failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't update the ticket type.");
  }
});

router.delete("/:id/ticket-types/:typeId", hybridAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const ctx = await editableEvent(req, res);
    if (!ctx) return;
    const { e } = ctx;
    // Never used and nothing opens after it: delete. Otherwise archive, so tickets already issued stay valid.
    const [deleted] = await rows(sql`
      DELETE FROM ticket_types t
      WHERE t.id = ${req.params.typeId} AND t.event_id = ${e.id} AND t.reserved_count = 0
        AND NOT EXISTS (SELECT 1 FROM ticket_order_items i WHERE i.ticket_type_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM ticket_types n WHERE n.unlock_after_ticket_type_id = t.id)
      RETURNING t.id`);
    if (deleted) return res.json({ success: true, removed: "deleted" });
    const [archived] = await rows(sql`
      UPDATE ticket_types SET status = 'archived', updated_at = now()
      WHERE id = ${req.params.typeId} AND event_id = ${e.id} AND status = 'active'
      RETURNING *`);
    if (archived) return res.json({ success: true, removed: "archived", ticketType: hostTicketTypeJson(archived) });
    const [exists] = await rows(sql`SELECT status FROM ticket_types WHERE id = ${req.params.typeId} AND event_id = ${e.id}`);
    if (!exists) return fail(res, 404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found.");
    return fail(res, 409, "TICKET_TYPE_ARCHIVED", "This ticket type was already removed.");
  } catch (err) {
    console.error("[Events] remove ticket type failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't remove the ticket type.");
  }
});

// ─── Free RSVP (guests) ─────────────────────────────────────────────────────

const rsvpSchema = z.object({
  ticketTypeId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(MAX_PER_ORDER).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  // p4-team step 3: the promoter link the guest came through. Anything that isn't a live link is ignored, never refused.
  linkCode: z.unknown().optional(),
}).strict();

/** A repeated key returns the earlier RSVP only when it was for the same thing and is still active. */
async function repeatedOrder(res: Response, userId: string, key: string, eventId: string, typeId: string, quantity: number) {
  const [prev] = await rows<any>(sql`
    SELECT o.id, o.event_id, o.status, o.ticket_count, i.ticket_type_id
    FROM ticket_orders o LEFT JOIN ticket_order_items i ON i.order_id = o.id
    WHERE o.buyer_user_id = ${userId} AND o.idempotency_key = ${key} LIMIT 1`);
  if (!prev) return false;
  if (prev.event_id !== eventId || prev.ticket_type_id !== typeId || Number(prev.ticket_count) !== quantity || prev.status !== "completed") {
    fail(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different RSVP. Send a new key.");
    return true;
  }
  res.json({ success: true, order: await orderWithTickets(prev.id, userId), repeated: true });
  return true;
}

export async function orderWithTickets(orderId: string, userId: string) {
  const [o] = await rows<any>(sql`
    SELECT o.*, e.slug, e.title FROM ticket_orders o JOIN events e ON e.id = o.event_id
    WHERE o.id = ${orderId} AND o.buyer_user_id = ${userId}`);
  if (!o) return null;
  const tickets = await rows<any>(sql`
    SELECT t.id, t.code, t.status, t.ticket_type_id, tt.name AS ticket_type_name, t.item_index
    FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
    WHERE t.order_id = ${orderId} ORDER BY t.item_index`);
  return {
    id: o.id, status: o.status, eventId: o.event_id, eventSlug: o.slug, eventTitle: o.title,
    ticketCount: Number(o.ticket_count), totalCents: Number(o.total_cents),
    createdAt: iso(o.created_at), cancelledAt: iso(o.cancelled_at),
    tickets: tickets.map((t) => ({ id: t.id, code: t.code, status: t.status, ticketTypeId: t.ticket_type_id, ticketTypeName: t.ticket_type_name })),
  };
}

/** Why a claim matched nothing (read after the fact; the claim itself is the source of truth). */
export async function whyNotClaimable(eventId: string, typeId: string, quantity: number, mode: "free" | "paid" = "free"): Promise<{ status: number; code: string; message: string }> {
  const [e] = await rows<any>(sql`SELECT status, starts_at FROM events WHERE id = ${eventId}`);
  if (!e || e.status === "draft" || e.status === "paused") return { status: 404, code: "EVENT_NOT_FOUND", message: "Event not found." };
  if (e.status === "cancelled") return { status: 409, code: "EVENT_CANCELLED", message: "This event was cancelled." };
  if (new Date(e.starts_at) <= new Date()) return { status: 409, code: "EVENT_STARTED", message: "This event has already started." };
  const [t] = await rows<any>(sql`SELECT * FROM ticket_types WHERE id = ${typeId} AND event_id = ${eventId}`);
  if (!t || t.status !== "active" || t.hidden) return { status: 404, code: "TICKET_TYPE_NOT_FOUND", message: "That ticket isn't available." };
  if (mode === "free" && Number(t.price_cents) > 0) return { status: 409, code: "PAID_TICKET", message: "This ticket isn't free. Check out to buy it." };
  if (mode === "paid" && Number(t.price_cents) === 0) return { status: 409, code: "FREE_TICKET", message: "This ticket is free. RSVP instead." };
  if (quantity < Number(t.min_per_order) || quantity > Number(t.max_per_order)) {
    return { status: 400, code: "INVALID_QUANTITY", message: `Choose between ${t.min_per_order} and ${t.max_per_order}.` };
  }
  const now = new Date();
  if (t.sales_start_at && new Date(t.sales_start_at) > now) return { status: 409, code: "SALES_NOT_STARTED", message: "These tickets aren't available yet." };
  if (t.sales_end_at && new Date(t.sales_end_at) <= now) return { status: 409, code: "SALES_ENDED", message: "These tickets are no longer available." };
  if (t.unlock_after_ticket_type_id) {
    const [s] = await rows<any>(sql`SELECT reserved_count, quantity, status FROM ticket_types WHERE id = ${t.unlock_after_ticket_type_id}`);
    if (s && s.status === "active" && Number(s.reserved_count) < Number(s.quantity)) {
      return { status: 409, code: "NOT_OPEN_YET", message: "These open when the earlier tickets are gone." };
    }
  }
  return { status: 409, code: "TRY_AGAIN", message: "Tickets just changed. Try again." };
}

router.post("/:id/rsvp", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to RSVP.");
  const parsed = rsvpSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodError(res, parsed.error);
  const eventId = String(req.params.id);
  const { ticketTypeId } = parsed.data;
  const quantity = parsed.data.quantity ?? 1;
  const headerKey = req.get("Idempotency-Key");
  const idempotencyKey = parsed.data.idempotencyKey ?? (headerKey && headerKey.length >= 8 && headerKey.length <= 100 ? headerKey : null);

  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't RSVP.");
    if (idempotencyKey && (await repeatedOrder(res, userId, idempotencyKey, eventId, ticketTypeId, quantity))) return;

    const codes = Array.from({ length: quantity }, () => makeTicketCode());
    const codesLiteral = `{${codes.join(",")}}`; // A-Z and 2-9 only: safe as a Postgres array literal
    const promoterLink = promoterLinkIdSql(normalizeLinkCode(parsed.data.linkCode), eventId, userId);
    try {
      // One statement: bump the ticket type, then the event, then the per-account count (each guarded by
      // a CHECK), then write the order, its line and one ticket per guest. Ends with a guard: if the type
      // was bumped but anything after it didn't happen, raise so the whole statement rolls back.
      const [r] = await withDeadlockRetry(() => rows<any>(sql`
        WITH par AS (
          -- The tier this one opens after, locked: read at its latest version, not the statement snapshot.
          SELECT p.id, p.status, p.reserved_count, p.quantity FROM ticket_types p
          WHERE p.id = (SELECT x.unlock_after_ticket_type_id FROM ticket_types x WHERE x.id = ${ticketTypeId})
          FOR UPDATE
        ),
        tt AS (
          UPDATE ticket_types t SET reserved_count = t.reserved_count + ${quantity}, updated_at = now()
          WHERE t.id = ${ticketTypeId} AND t.event_id = ${eventId} AND t.status = 'active' AND t.hidden = false
            AND t.price_cents = 0
            AND ${quantity} BETWEEN t.min_per_order AND t.max_per_order
            AND (t.sales_start_at IS NULL OR t.sales_start_at <= now())
            AND (t.sales_end_at IS NULL OR t.sales_end_at > now())
            AND (t.unlock_after_ticket_type_id IS NULL OR EXISTS (
              SELECT 1 FROM par WHERE par.id = t.unlock_after_ticket_type_id
                AND (par.status <> 'active' OR par.reserved_count >= par.quantity)))
          RETURNING t.id, t.per_account_limit
        ),
        ev AS (
          UPDATE events e SET reserved_count = e.reserved_count + ${quantity}, updated_at = now()
          WHERE e.id = ${eventId} AND e.status = 'published' AND e.starts_at > now() AND EXISTS (SELECT 1 FROM tt)
          RETURNING e.id
        ),
        ac AS (
          INSERT INTO ticket_account_counts (ticket_type_id, user_id, count, max_count)
          SELECT tt.id, ${userId}, ${quantity}, tt.per_account_limit FROM tt, ev
          ON CONFLICT (ticket_type_id, user_id) DO UPDATE
            SET count = ticket_account_counts.count + EXCLUDED.count, max_count = EXCLUDED.max_count, updated_at = now()
          RETURNING 1
        ),
        o AS (
          INSERT INTO ticket_orders (event_id, buyer_user_id, status, ticket_count, fee_model_version, idempotency_key, completed_at, promoter_link_id)
          SELECT ${eventId}, ${userId}, 'completed', ${quantity}, 'events-free-v1', ${idempotencyKey}, now(), ${promoterLink} FROM ac
          RETURNING id
        ),
        it AS (
          INSERT INTO ticket_order_items (order_id, event_id, ticket_type_id, buyer_user_id, quantity, unit_price_cents, status, expires_at)
          SELECT o.id, ${eventId}, ${ticketTypeId}, ${userId}, ${quantity}, 0, 'issued', now() FROM o
          RETURNING id, order_id
        ),
        tk AS (
          INSERT INTO tickets (order_id, order_item_id, event_id, ticket_type_id, holder_user_id, item_index, code, price_cents)
          SELECT it.order_id, it.id, ${eventId}, ${ticketTypeId}, ${userId}, c.ord, c.code, 0
          FROM it, unnest(${codesLiteral}::text[]) WITH ORDINALITY AS c(code, ord)
          RETURNING id
        )
        SELECT (SELECT id FROM o) AS order_id,
               CASE WHEN EXISTS (SELECT 1 FROM tt) AND (SELECT count(*) FROM tk) <> ${quantity}
                 THEN ('GUARD_NOT_OPEN:' || (SELECT count(*) FROM tk))::int END AS guard`));
      if (r?.order_id) {
        // Fire and forget: the confirmation email never delays or fails the RSVP.
        void notifyRsvpConfirmed(String(r.order_id));
        return res.status(201).json({ success: true, order: await orderWithTickets(r.order_id, userId) });
      }
      const why = await whyNotClaimable(eventId, ticketTypeId, quantity);
      return fail(res, why.status, why.code, why.message);
    } catch (err) {
      const pe = pgError(err);
      if (pe.code === "23514") {
        if (pe.constraint === "ticket_types_quantity_not_exceeded") return fail(res, 409, "SOLD_OUT", "Sold out.");
        if (pe.constraint === "events_capacity_not_exceeded") return fail(res, 409, "EVENT_FULL", "This event is full.");
        if (pe.constraint === "ticket_account_counts_limit") return fail(res, 409, "LIMIT_REACHED", "You already have the most tickets allowed for this.");
      }
      if (pe.code === "23505" && pe.constraint === "uq_ticket_orders_idempotency" && idempotencyKey) {
        if (await repeatedOrder(res, userId, idempotencyKey, eventId, ticketTypeId, quantity)) return;
      }
      if (guardCode(err)) {
        const why = await whyNotClaimable(eventId, ticketTypeId, quantity);
        return fail(res, why.status, why.code, why.message);
      }
      throw err;
    }
  } catch (err) {
    console.error("[Events] rsvp failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't save your RSVP.");
  }
});

router.post("/orders/:orderId/cancel", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to cancel.");
  const orderId = String(req.params.orderId);
  try {
    if (!(await loadActiveUser(userId))) return fail(res, 403, "ACCOUNT_INACTIVE", "This account can't change RSVPs.");
    // One statement. The guest's spot always goes back to the event's capacity. The ticket type's own
    // spot reopens only until a tier that opens after it has sold (decision 2026-10-18). When it stays
    // closed, ticket_types.reserved_count keeps that spot on purpose: never rebuild it from issued items.
    const [r] = await withDeadlockRetry(() => rows<any>(sql`
      WITH o AS (
        UPDATE ticket_orders SET status = 'cancelled', cancelled_at = now(), updated_at = now()
        WHERE id = ${orderId} AND buyer_user_id = ${userId} AND status = 'completed' AND total_cents = 0
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = ${orderId} AND t.checked_in_at IS NOT NULL)
        RETURNING id, event_id, ticket_count
      ),
      ev AS (
        UPDATE events e SET reserved_count = e.reserved_count - o.ticket_count, updated_at = now()
        FROM o WHERE e.id = o.event_id AND e.status = 'published' AND e.starts_at > now()
        RETURNING e.id
      ),
      it AS (
        UPDATE ticket_order_items i SET status = 'released', updated_at = now()
        FROM o WHERE i.order_id = o.id AND i.status = 'issued'
        RETURNING i.ticket_type_id, i.quantity
      ),
      kids AS (
        -- Tiers that open after the cancelled one, locked: read at their latest version.
        SELECT n.unlock_after_ticket_type_id AS parent_id, n.reserved_count FROM ticket_types n
        WHERE n.unlock_after_ticket_type_id IN (SELECT ticket_type_id FROM it)
        FOR UPDATE
      ),
      tt AS (
        UPDATE ticket_types t SET reserved_count = t.reserved_count - it.quantity, updated_at = now()
        FROM it WHERE t.id = it.ticket_type_id
          AND NOT EXISTS (SELECT 1 FROM kids WHERE kids.parent_id = t.id AND kids.reserved_count > 0)
        RETURNING t.id
      ),
      ac AS (
        UPDATE ticket_account_counts a SET count = a.count - it.quantity, updated_at = now()
        FROM it WHERE a.ticket_type_id = it.ticket_type_id AND a.user_id = ${userId}
        RETURNING 1
      ),
      tk AS (
        UPDATE tickets t SET status = 'cancelled', cancelled_at = now()
        FROM o WHERE t.order_id = o.id AND t.status = 'valid'
        RETURNING t.id
      )
      SELECT (SELECT id FROM o) AS order_id, (SELECT count(*) FROM tt) AS reopened,
             CASE WHEN EXISTS (SELECT 1 FROM o) AND NOT EXISTS (SELECT 1 FROM ev)
               THEN ('GUARD_EVENT_CLOSED:' || (SELECT count(*) FROM o))::int END AS guard_event,
             CASE WHEN EXISTS (SELECT 1 FROM o) AND (SELECT count(*) FROM ac) <> (SELECT count(*) FROM it)
               THEN ('GUARD_COUNTS:' || (SELECT count(*) FROM ac))::int END AS guard_counts,
             CASE WHEN EXISTS (SELECT 1 FROM o) AND (
                    (SELECT count(*) FROM tk) <> (SELECT ticket_count FROM o)
                 OR (SELECT COALESCE(sum(quantity), 0) FROM it) <> (SELECT ticket_count FROM o))
               THEN ('GUARD_TICKETS:' || (SELECT count(*) FROM tk))::int END AS guard_tickets`));
    if (r?.order_id) {
      return res.json({ success: true, spotReopened: Number(r.reopened) > 0, order: await orderWithTickets(r.order_id, userId) });
    }
    const [o] = await rows<any>(sql`
      SELECT o.status, o.total_cents, e.status AS event_status, e.starts_at,
             EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id AND t.checked_in_at IS NOT NULL) AS checked_in
      FROM ticket_orders o JOIN events e ON e.id = o.event_id
      WHERE o.id = ${orderId} AND o.buyer_user_id = ${userId}`);
    if (!o) return fail(res, 404, "ORDER_NOT_FOUND", "Order not found.");
    if (o.status === "cancelled") return fail(res, 409, "ALREADY_CANCELLED", "This RSVP is already cancelled.");
    if (Number(o.total_cents) > 0) return fail(res, 409, "PAID_ORDER", "Paid tickets follow the host's refund policy.");
    if (o.checked_in) return fail(res, 409, "CHECKED_IN", "You've already checked in.");
    return fail(res, 409, "ORDER_NOT_CANCELLABLE", "This RSVP can't be cancelled.");
  } catch (err) {
    if (guardCode(err) === "COUNTS" || guardCode(err) === "TICKETS") return fail(res, 409, "TRY_AGAIN", "Something changed. Try again.");
    if (guardCode(err) === "EVENT_CLOSED") return fail(res, 409, "EVENT_CLOSED", "This event has started, ended, been paused or been cancelled, so RSVPs can't change.");
    console.error("[Events] rsvp cancel failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't cancel your RSVP.");
  }
});

router.get("/me/tickets", hybridAuthMiddleware, async (req: Request, res: Response) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return fail(res, 401, "NO_AUTH", "Sign in to see your tickets.");
  try {
    const list = await rows<any>(sql`
      SELECT t.id, t.code, t.status, t.order_id, t.checked_in_at, tt.name AS ticket_type_name,
             e.id AS event_id, e.slug, e.title, e.status AS event_status, e.starts_at, e.ends_at, e.timezone,
             e.cover_image_url, e.city, e.state, e.venue_name, e.address_line1, e.address_line2, e.postal_code, e.address_visibility
      FROM tickets t
      JOIN ticket_types tt ON tt.id = t.ticket_type_id
      JOIN events e ON e.id = t.event_id
      WHERE t.holder_user_id = ${userId} AND t.status = 'valid'
      ORDER BY (e.ends_at < now()), e.starts_at, t.item_index
      LIMIT 500`);
    return res.json({
      success: true,
      tickets: list.map((t) => {
        const dayOf = t.address_visibility === "ticket_holders_day_of";
        const addr = visibleAddress(
          {
            venueName: t.venue_name ?? null, addressLine1: t.address_line1 ?? null, addressLine2: t.address_line2 ?? null,
            city: t.city ?? null, state: t.state ?? null, postalCode: t.postal_code ?? null, latitude: null, longitude: null,
          },
          {
            addressVisibility: t.address_visibility, viewerIsHost: false, viewerHasTicket: true,
            holderRevealed: holderCanSeeAddress(t.address_visibility, new Date(t.starts_at), t.timezone, new Date()),
          },
        );
        return {
        id: t.id, code: t.code, status: t.status, orderId: t.order_id, checkedInAt: iso(t.checked_in_at),
        ticketTypeName: t.ticket_type_name,
        // Only a valid ticket gets a QR image (the query returns valid tickets only today; the guard stays in case that widens).
        qrUrl: t.status === "valid" ? qrUrlFor(t.id) : null,
        // Apple Wallet pass link (p3-wallet): null while Wallet isn't configured. Additive; old clients ignore it.
        walletUrl: t.status === "valid" ? walletUrlFor(t.id) : null,
        event: {
          id: t.event_id, slug: t.slug, title: t.title, status: t.event_status, startsAt: iso(t.starts_at),
          endsAt: iso(t.ends_at), timezone: t.timezone, coverImageUrl: t.cover_image_url ?? null, city: t.city ?? null, state: t.state ?? null,
          venueName: addr.venueName, addressLine1: addr.addressLine1, addressLine2: addr.addressLine2, postalCode: addr.postalCode,
          addressHidden: addr.addressHidden,
          addressRevealAt: dayOf ? iso(addressRevealAt(new Date(t.starts_at), t.timezone)) : null,
        },
        };
      }),
    });
  } catch (err) {
    console.error("[Events] my tickets failed:", err);
    return fail(res, 500, "SERVER_ERROR", "Couldn't load your tickets.");
  }
});

export default router;
