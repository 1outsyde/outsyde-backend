/**
 * Admin events money (goutsyde.com/admin/events): SQL and shaping for the list and detail routes.
 * Design: docs/superpowers/specs/2026-10-23-admin-events-money-design.md.
 *
 * Money comes only from stored columns, never from fee rates:
 *   sold             = valid tickets on completed orders, plus refunded tickets (a refunded ticket was paid for)
 *   salesCents       = sum tickets.price_cents of sold tickets (ticket prices before refunds)
 *   refundedCents    = sum tickets.price_cents of refunded tickets
 *   hostEarnsCents   = sum tickets.host_net_cents of valid tickets on completed orders (same rule as the payout job)
 *   outsydeFeesCents = buyer fees kept (tickets.service_fee_cents + per_ticket_fee_cents of sold tickets, except
 *                      tickets refunded for an event cancellation, which give everything back: ticketRefunds.ts:9-10)
 *                    + host fee (tickets.platform_fee_cents) of valid tickets on completed orders
 * Never selects any email column, and masks Stripe account ids to their last 4 characters.
 */
import { sql, type SQL } from "drizzle-orm";
import { rows, iso } from "./eventsRouter";
import { hostIdentityFrom } from "./eventList";
import { payoutStatusFor, type PayoutStatus } from "./payoutStatus";
import { HOST_PAYOUT_DELAY_DAYS } from "./payoutTiming";

const DAY_MS = 86400000;
export const DEFAULT_RANGE_DAYS = 90;
export const OWED_ATTENTION_DAYS = 30;
export const ACTIVITY_LIMIT = 50;

/** "acct_••••" + last 4 characters, or null. */
export function maskAccount(id: string | null | undefined): string | null {
  if (!id) return null;
  return `acct_••••${String(id).slice(-4)}`;
}

/** Stripe error text can quote an account id: mask every acct_ id inside free text. */
export function maskText(t: string | null | undefined): string | null {
  if (t == null) return null;
  return String(t).replace(/acct_[A-Za-z0-9]+/g, (m) => maskAccount(m)!);
}

const num = (v: unknown) => Number(v ?? 0);

/**
 * Local payout account readiness, by the same rule as hostPayoutDestination (hostPayouts.ts): business host with a
 * business id -> businesses columns, photographer host with a photographer id -> photographers columns, otherwise
 * user_payout_accounts. Ready = an account id exists and our record says onboarding is complete. No Stripe call.
 */
export function payoutAccountFrom(r: {
  host_type: string; b_id?: string | null; p_id?: string | null;
  b_acct?: string | null; b_done?: boolean | null; p_acct?: string | null; p_done?: boolean | null;
  u_acct?: string | null; u_done?: boolean | null;
}): { accountId: string | null; localReady: boolean } {
  if (r.host_type === "business" && r.b_id) return { accountId: r.b_acct ?? null, localReady: !!r.b_done };
  if (r.host_type === "photographer" && r.p_id) return { accountId: r.p_acct ?? null, localReady: !!r.p_done };
  return { accountId: r.u_acct ?? null, localReady: !!r.u_done };
}

export type PayoutSetup = "ready" | "no_account" | "not_complete";
export const payoutSetupOf = (a: { accountId: string | null; localReady: boolean }): PayoutSetup =>
  !a.accountId ? "no_account" : !a.localReady ? "not_complete" : "ready";

// ─── Shared SQL fragments ───────────────────────────────────────────────────

const VALID = sql`(t.status = 'valid' AND o.status = 'completed')`;
const SOLD = sql`((t.status = 'valid' AND o.status = 'completed') OR t.status = 'refunded')`;
const BUYER_FEES_KEPT = sql`(${SOLD} AND NOT (t.status = 'refunded' AND COALESCE(o.refund_reason, '') = 'event_cancelled'))`;

/** Per-ticket money aggregates, grouped by `groupBy` (t.event_id or t.ticket_type_id). */
const ticketAggs = sql`
  count(*) FILTER (WHERE ${SOLD})::int AS sold,
  count(*) FILTER (WHERE ${VALID})::int AS valid,
  count(*) FILTER (WHERE t.status = 'refunded')::int AS refunded,
  COALESCE(sum(t.price_cents) FILTER (WHERE ${SOLD}), 0)::bigint AS sales_cents,
  COALESCE(sum(t.price_cents) FILTER (WHERE t.status = 'refunded'), 0)::bigint AS refunded_cents,
  COALESCE(sum(t.host_net_cents) FILTER (WHERE ${VALID}), 0)::bigint AS host_earns_cents,
  (COALESCE(sum(t.service_fee_cents + t.per_ticket_fee_cents) FILTER (WHERE ${BUYER_FEES_KEPT}), 0)
   + COALESCE(sum(t.platform_fee_cents) FILTER (WHERE ${VALID}), 0))::bigint AS fees_cents`;

/**
 * One grouped statement: the events matching `where` with their ticket, order and recovery aggregates, the host's
 * public identity and payout account columns, and the payout row (event_payouts.event_id is unique).
 */
function eventRowsSql(where: SQL): SQL {
  return sql`
    WITH ev AS (
      SELECT e.id FROM events e WHERE ${where}
    ),
    tk AS (
      SELECT t.event_id, ${ticketAggs},
        COALESCE(sum(t.host_net_cents) FILTER (WHERE ${VALID} AND t.payout_id IS NULL), 0)::bigint AS unstamped_cents,
        count(*) FILTER (WHERE ${VALID} AND t.checked_in_at IS NOT NULL)::int AS checked_in
      FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
      WHERE t.event_id IN (SELECT id FROM ev)
      GROUP BY t.event_id
    ),
    od AS (
      SELECT o.event_id,
        count(*) FILTER (WHERE o.status = 'completed')::int AS completed,
        count(*) FILTER (WHERE o.status = 'refunded')::int AS refunded,
        count(*) FILTER (WHERE o.status = 'refunding')::int AS refunding,
        count(*) FILTER (WHERE o.needs_review_at IS NOT NULL AND o.status IN ('pending', 'completed', 'refunding'))::int AS flagged
      FROM ticket_orders o WHERE o.event_id IN (SELECT id FROM ev)
      GROUP BY o.event_id
    ),
    rc AS (
      SELECT p.event_id,
        count(*) FILTER (WHERE r.status = 'owed')::int AS owed_n,
        COALESCE(sum(r.amount_cents) FILTER (WHERE r.status = 'owed'), 0)::bigint AS owed_cents
      FROM event_payout_recoveries r JOIN event_payouts p ON p.id = r.payout_id
      WHERE p.event_id IN (SELECT id FROM ev)
      GROUP BY p.event_id
    )
    SELECT e.id, e.slug, e.title, e.city, e.state, e.starts_at, e.ends_at, e.timezone, e.status, e.capacity,
           e.created_at, e.published_at, e.cancelled_at,
           e.host_type, e.host_user_id, e.host_business_id, e.host_photographer_id,
           u.name AS u_name, u.first_name AS u_first_name, u.username AS u_username, u.profile_image_url AS u_image,
           b.id AS b_id, b.name AS b_name, b.logo_image AS b_logo, b.stripe_account_id AS b_acct, b.stripe_onboarding_complete AS b_done,
           ph.id AS p_id, ph.display_name AS p_name, ph.logo_image AS p_logo, ph.stripe_account_id AS p_acct, ph.stripe_onboarding_complete AS p_done,
           upa.stripe_account_id AS u_acct, upa.onboarding_complete AS u_done,
           tk.sold, tk.valid, tk.refunded, tk.sales_cents, tk.refunded_cents, tk.host_earns_cents, tk.fees_cents,
           tk.unstamped_cents, tk.checked_in,
           od.completed AS orders_completed, od.refunded AS orders_refunded, od.refunding AS orders_refunding, od.flagged AS orders_flagged,
           rc.owed_n, rc.owed_cents,
           ep.id AS ep_id, ep.status AS ep_status, ep.hold_reason AS ep_hold_reason, ep.destination_type AS ep_destination_type,
           ep.connected_account_id AS ep_acct, ep.gross_cents AS ep_gross, ep.deducted_cents AS ep_deducted, ep.amount_cents AS ep_amount,
           ep.attempts AS ep_attempts, ep.next_attempt_at AS ep_next_attempt_at, ep.last_error AS ep_last_error,
           ep.alerted_at AS ep_alerted_at, ep.transfer_id AS ep_transfer_id, ep.paid_at AS ep_paid_at,
           ep.created_at AS ep_created_at, ep.updated_at AS ep_updated_at
    FROM ev
    JOIN events e ON e.id = ev.id
    JOIN users u ON u.id = e.host_user_id
    LEFT JOIN businesses b ON b.id = e.host_business_id
    LEFT JOIN photographers ph ON ph.id = e.host_photographer_id
    LEFT JOIN user_payout_accounts upa ON upa.user_id = e.host_user_id
    LEFT JOIN tk ON tk.event_id = e.id
    LEFT JOIN od ON od.event_id = e.id
    LEFT JOIN rc ON rc.event_id = e.id
    LEFT JOIN event_payouts ep ON ep.event_id = e.id
    ORDER BY e.starts_at DESC, e.id`;
}

// ─── Shaping ────────────────────────────────────────────────────────────────

export type AdminHost = {
  type: string; id: string; name: string; avatarUrl: string | null; ownerUsername: string | null;
  payoutReady: boolean; payoutSetup: PayoutSetup;
};

function hostOf(r: any): AdminHost {
  const ident = hostIdentityFrom(r);
  const acct = payoutAccountFrom(r);
  const id = r.host_type === "business" && r.b_id ? r.b_id : r.host_type === "photographer" && r.p_id ? r.p_id : r.host_user_id;
  return {
    type: r.host_type, id, name: ident.publicName, avatarUrl: ident.avatarUrl, ownerUsername: r.u_username ?? null,
    payoutReady: payoutSetupOf(acct) === "ready", payoutSetup: payoutSetupOf(acct),
  };
}

function payoutOf(r: any, dueAt: string) {
  if (!r.ep_id) return null;
  return {
    id: r.ep_id as string, status: r.ep_status as string, dueAt, paidAt: iso(r.ep_paid_at),
    grossCents: num(r.ep_gross), amountCents: num(r.ep_amount), deductedCents: num(r.ep_deducted),
    attempts: num(r.ep_attempts), lastError: maskText(r.ep_last_error), holdReason: (r.ep_hold_reason ?? null) as string | null,
  };
}

/** One event row of the list (also the `event` of the detail route). */
export function shapeEvent(r: any) {
  const endsAt = iso(r.ends_at)!;
  const dueAt = new Date(new Date(endsAt).getTime() + HOST_PAYOUT_DELAY_DAYS * DAY_MS).toISOString();
  const hostEarnsCents = num(r.host_earns_cents);
  const payable = hostEarnsCents > 0;
  // Same expectedAt rule as the host summary (ticketRefunds.ts), so host and admin labels agree.
  const expectedAt = r.status === "published" && payable ? dueAt : null;
  const payoutRow = r.ep_id ? { status: r.ep_status as string, hold_reason: (r.ep_hold_reason ?? null) as string | null } : undefined;
  const payoutStatus: PayoutStatus = payoutStatusFor(payoutRow, { eventStatus: r.status, payable, expectedAt });
  const open = r.ep_id && ["pending", "held", "review"].includes(r.ep_status) ? num(r.ep_amount) : 0;
  return {
    id: r.id as string, slug: r.slug as string, title: r.title as string, city: r.city ?? null, state: r.state ?? null,
    startsAt: iso(r.starts_at)!, endsAt, timezone: r.timezone as string, status: r.status as string,
    capacity: r.capacity == null ? null : num(r.capacity),
    ticketsSold: num(r.sold), ticketsValid: num(r.valid), ticketsRefunded: num(r.refunded),
    salesCents: num(r.sales_cents), refundedCents: num(r.refunded_cents), hostEarnsCents, outsydeFeesCents: num(r.fees_cents),
    // Not paid yet: valid tickets no payout covers yet, plus an open payout (same two parts as bankPayout computeHeld).
    owedToHostCents: num(r.unstamped_cents) + open,
    paidToHostCents: r.ep_id && r.ep_status === "paid" ? num(r.ep_amount) : 0,
    refundsPending: num(r.orders_refunding),
    recoveriesOwed: { count: num(r.owed_n), amountCents: num(r.owed_cents) },
    payoutDueAt: dueAt, payoutExpectedAt: expectedAt,
    host: hostOf(r),
    payout: payoutOf(r, dueAt),
    payoutStatus,
  };
}
export type AdminEventRow = ReturnType<typeof shapeEvent>;

const TOTAL_KEYS = [
  "ticketsSold", "ticketsValid", "ticketsRefunded", "salesCents", "refundedCents", "hostEarnsCents", "outsydeFeesCents",
  "owedToHostCents", "paidToHostCents",
] as const;

export function totalsOf(events: AdminEventRow[]) {
  const t: Record<string, number> = { events: events.length };
  for (const k of TOTAL_KEYS) t[k] = events.reduce((a, e) => a + e[k], 0);
  return t as { events: number } & Record<(typeof TOTAL_KEYS)[number], number>;
}

// ─── List ───────────────────────────────────────────────────────────────────

/** Default range: events starting from 90 days ago, and every upcoming one. Drafts are left out (no sales). */
export async function listAdminEvents(range: { from: string | null; to: string | null }): Promise<AdminEventRow[]> {
  const conds: SQL[] = [sql`e.status <> 'draft'`];
  if (range.from) conds.push(sql`e.starts_at >= ${range.from}::timestamptz`);
  if (range.to) conds.push(sql`e.starts_at < ${range.to}::timestamptz`);
  if (!range.from && !range.to) conds.push(sql`e.starts_at >= now() - make_interval(days => ${DEFAULT_RANGE_DAYS})`);
  const found = await rows<any>(eventRowsSql(sql.join(conds, sql` AND `)));
  return found.map(shapeEvent);
}

/**
 * Needs attention, platform wide (not limited to the date range, so an old stuck payout is never hidden):
 * payouts in review, payouts held, and recoveries owed for more than 30 days (measured from created_at, the same
 * rule as alertOldOwed in eventPayouts.ts). One statement.
 */
export async function listAttention() {
  const found = await rows<any>(sql`
    WITH items AS (
      SELECT CASE WHEN p.status = 'review' THEN 'payout_review' ELSE 'payout_held' END AS kind,
             p.id AS payout_id, NULL::varchar AS recovery_id, p.event_id, p.amount_cents, p.status,
             CASE WHEN p.status = 'review' THEN p.last_error ELSE p.hold_reason END AS reason,
             p.updated_at AS since
      FROM event_payouts p WHERE p.status IN ('review', 'held')
      UNION ALL
      SELECT 'recovery_owed', r.payout_id, r.id, p.event_id, r.amount_cents, r.status, r.last_error, r.created_at
      FROM event_payout_recoveries r JOIN event_payouts p ON p.id = r.payout_id
      WHERE r.status = 'owed' AND r.created_at <= now() - make_interval(days => ${OWED_ATTENTION_DAYS})
    )
    SELECT i.*, e.title, e.host_type, e.host_user_id,
           u.name AS u_name, u.first_name AS u_first_name, u.username AS u_username, u.profile_image_url AS u_image,
           b.id AS b_id, b.name AS b_name, b.logo_image AS b_logo, b.stripe_account_id AS b_acct, b.stripe_onboarding_complete AS b_done,
           ph.id AS p_id, ph.display_name AS p_name, ph.logo_image AS p_logo, ph.stripe_account_id AS p_acct, ph.stripe_onboarding_complete AS p_done,
           upa.stripe_account_id AS u_acct, upa.onboarding_complete AS u_done
    FROM items i
    JOIN events e ON e.id = i.event_id
    JOIN users u ON u.id = e.host_user_id
    LEFT JOIN businesses b ON b.id = e.host_business_id
    LEFT JOIN photographers ph ON ph.id = e.host_photographer_id
    LEFT JOIN user_payout_accounts upa ON upa.user_id = e.host_user_id
    ORDER BY CASE i.kind WHEN 'payout_review' THEN 0 WHEN 'payout_held' THEN 1 ELSE 2 END, i.since, i.payout_id, i.recovery_id`);
  return found.map((r) => ({
    kind: r.kind as "payout_review" | "payout_held" | "recovery_owed",
    payoutId: r.payout_id as string, recoveryId: (r.recovery_id ?? null) as string | null,
    eventId: r.event_id as string, eventTitle: r.title as string,
    host: hostOf(r),
    amountCents: num(r.amount_cents),
    reason: r.kind === "payout_held" ? (r.reason ?? null) : maskText(r.reason),
    since: iso(r.since),
  }));
}

// ─── Detail ─────────────────────────────────────────────────────────────────

export async function loadAdminEventRow(id: string): Promise<{ raw: any; event: AdminEventRow } | null> {
  const [r] = await rows<any>(eventRowsSql(sql`e.id = ${id}`));
  return r ? { raw: r, event: shapeEvent(r) } : null;
}

export async function loadTicketTypes(eventId: string) {
  const found = await rows<any>(sql`
    SELECT tt.id, tt.name, tt.price_cents, (tt.status = 'archived') AS archived, ${ticketAggs}
    FROM ticket_types tt
    LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.event_id = tt.event_id
    LEFT JOIN ticket_orders o ON o.id = t.order_id
    WHERE tt.event_id = ${eventId}
    GROUP BY tt.id ORDER BY tt.sort_order, tt.created_at, tt.id`);
  return found.map((t) => ({
    ticketTypeId: t.id as string, name: t.name as string, priceCents: num(t.price_cents), archived: t.archived === true,
    sold: num(t.sold), valid: num(t.valid), refunded: num(t.refunded),
    salesCents: num(t.sales_cents), refundedCents: num(t.refunded_cents), hostEarnsCents: num(t.host_earns_cents),
    outsydeFeesCents: num(t.fees_cents),
  }));
}

/** Every column of the payout row except the full connected account id (masked). */
export function payoutDetailOf(r: any, dueAt: string) {
  if (!r.ep_id) return null;
  return {
    ...payoutOf(r, dueAt)!,
    destinationType: (r.ep_destination_type ?? null) as string | null,
    connectedAccount: maskAccount(r.ep_acct),
    nextAttemptAt: iso(r.ep_next_attempt_at), alertedAt: iso(r.ep_alerted_at),
    transferId: (r.ep_transfer_id ?? null) as string | null,
    createdAt: iso(r.ep_created_at), updatedAt: iso(r.ep_updated_at),
  };
}

export async function loadRecoveries(eventId: string) {
  const found = await rows<any>(sql`
    SELECT r.id, r.ticket_id, r.payout_id, r.connected_account_id, r.amount_cents, r.status, r.reversal_id,
           r.recovered_from_payout_id, r.attempts, r.last_error, r.created_at, r.updated_at, r.resolved_at,
           ru.username AS resolved_by_username, tt.name AS ticket_type_name
    FROM event_payout_recoveries r
    JOIN event_payouts p ON p.id = r.payout_id
    LEFT JOIN users ru ON ru.id = r.resolved_by
    LEFT JOIN tickets t ON t.id = r.ticket_id
    LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
    WHERE p.event_id = ${eventId}
    ORDER BY r.created_at DESC, r.id`);
  return found.map((r) => ({
    id: r.id as string, ticketId: r.ticket_id as string, ticketTypeName: (r.ticket_type_name ?? null) as string | null,
    payoutId: r.payout_id as string, amountCents: num(r.amount_cents), status: r.status as string,
    connectedAccount: maskAccount(r.connected_account_id), reversalId: (r.reversal_id ?? null) as string | null,
    recoveredFromPayoutId: (r.recovered_from_payout_id ?? null) as string | null,
    attempts: num(r.attempts), lastError: maskText(r.last_error),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), resolvedAt: iso(r.resolved_at),
    resolvedByUsername: (r.resolved_by_username ?? null) as string | null,
    owedOver30Days: r.status === "owed" && r.created_at != null && Date.now() - new Date(r.created_at).getTime() >= OWED_ATTENTION_DAYS * DAY_MS,
  }));
}

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const REASON_TEXT: Record<string, string> = { buyer: "by the buyer", host: "by the host", event_cancelled: "because the event was cancelled" };
/** audit_logs actions written by adminEventsActions.ts. */
const ADMIN_ACTION_TEXT: Record<string, string> = {
  "event_payout.retry": "Payout set to try again",
  "event_payout.email_host": "Host emailed about the payout",
  "event_payout_recovery.collected": "Owed amount marked collected",
  "event_payout_recovery.written_off": "Owed amount written off",
};
const HOLD_TEXT: Record<string, string> = {
  no_account: "the host has no payout account", not_complete: "the host hasn't finished payout setup",
  stripe_not_ready: "Stripe isn't ready to pay the host", event_paused: "the event is paused",
};

/**
 * Activity, newest first, at most 50, built from timestamps that already exist (there is no history table):
 * event created, published, cancelled, ended; order refund requested and refunded; payout created, paid, and the
 * current held or review state (at updated_at); recovery created and its current state; admin actions from
 * audit_logs (target_type event_payout or event_payout_recovery, for this event's payout and recovery ids).
 */
export async function loadActivity(eventId: string) {
  const found = await rows<any>(sql`
    WITH ev AS (SELECT * FROM events WHERE id = ${eventId}),
    pay AS (SELECT * FROM event_payouts WHERE event_id = ${eventId}),
    rec AS (SELECT r.* FROM event_payout_recoveries r WHERE r.payout_id IN (SELECT id FROM pay)),
    a AS (
      SELECT created_at AS at, 'event_created' AS kind, NULL::text AS ref_id, NULL::bigint AS amount, NULL::text AS detail, NULL::int AS n, NULL::text AS actor FROM ev
      UNION ALL SELECT published_at, 'event_published', NULL, NULL, NULL, NULL, NULL FROM ev WHERE published_at IS NOT NULL
      UNION ALL SELECT cancelled_at, 'event_cancelled', NULL, NULL, NULL, NULL, NULL FROM ev WHERE cancelled_at IS NOT NULL
      UNION ALL SELECT ends_at, 'event_ended', NULL, NULL, NULL, NULL, NULL FROM ev WHERE ends_at <= now() AND status <> 'cancelled'
      UNION ALL SELECT o.refund_requested_at, 'order_refund_requested', o.id, (o.refunded_cents + o.refund_amount_cents)::bigint, o.refund_reason, o.ticket_count, NULL
        FROM ticket_orders o WHERE o.event_id = ${eventId} AND o.refund_requested_at IS NOT NULL
      UNION ALL SELECT o.refunded_at, 'order_refunded', o.id, o.refunded_cents::bigint, o.refund_reason, o.ticket_count, NULL
        FROM ticket_orders o WHERE o.event_id = ${eventId} AND o.refunded_at IS NOT NULL
      UNION ALL SELECT p.created_at, 'payout_created', p.id, p.gross_cents::bigint, NULL,
        (SELECT count(*)::int FROM tickets t WHERE t.payout_id = p.id), NULL FROM pay p
      UNION ALL SELECT p.paid_at, 'payout_paid', p.id, p.amount_cents::bigint, NULL, NULL, NULL FROM pay p WHERE p.paid_at IS NOT NULL
      UNION ALL SELECT p.updated_at, 'payout_' || p.status, p.id, p.amount_cents::bigint,
        CASE WHEN p.status = 'review' THEN p.last_error ELSE p.hold_reason END, p.attempts, NULL
        FROM pay p WHERE p.status IN ('held', 'review')
      UNION ALL SELECT r.created_at, 'recovery_created', r.id, r.amount_cents::bigint, NULL, NULL, NULL FROM rec r
      UNION ALL SELECT COALESCE(r.resolved_at, r.updated_at), 'recovery_' || r.status, r.id, r.amount_cents::bigint, NULL, NULL, NULL
        FROM rec r WHERE r.status <> 'pending'
      UNION ALL SELECT al.created_at AT TIME ZONE 'UTC', 'admin_action', al.target_id, NULL, al.action, NULL, (SELECT username FROM users WHERE id = al.actor_id)
        FROM audit_logs al
        WHERE (al.target_type = 'event_payout' AND al.target_id IN (SELECT id FROM pay))
           OR (al.target_type = 'event_payout_recovery' AND al.target_id IN (SELECT id FROM rec))
    )
    SELECT * FROM a WHERE at IS NOT NULL ORDER BY at DESC, kind LIMIT ${ACTIVITY_LIMIT}`);
  return found.map((r) => {
    const amountCents = r.amount == null ? null : num(r.amount);
    const n = r.n == null ? null : num(r.n);
    const kind = r.kind as string;
    const detail = kind === "admin_action" ? (r.detail ?? null) : maskText(r.detail);
    let text: string;
    switch (kind) {
      case "event_created": text = "Event created."; break;
      case "event_published": text = "Event published."; break;
      case "event_cancelled": text = "Event cancelled by the host."; break;
      case "event_ended": text = "Event ended."; break;
      case "order_refund_requested": text = `Refund of ${usd(amountCents ?? 0)} started${REASON_TEXT[r.detail] ? ` ${REASON_TEXT[r.detail]}` : ""} for ${n} ticket${n === 1 ? "" : "s"}.`; break;
      case "order_refunded": text = `${usd(amountCents ?? 0)} refunded to the buyer for ${n} ticket${n === 1 ? "" : "s"}.`; break;
      case "payout_created": text = `Payout of ${usd(amountCents ?? 0)} created for ${n} ticket${n === 1 ? "" : "s"}.`; break;
      case "payout_paid": text = `Payout of ${usd(amountCents ?? 0)} sent to the host.`; break;
      case "payout_held": text = `Payout on hold: ${HOLD_TEXT[r.detail] ?? "waiting"}.`; break;
      // Review also comes from an amount mismatch or a cancelled event, so the count is only told when it says something.
      case "payout_review": text = `Payout moved to review.${n != null && n > 1 ? ` Tried ${n} times.` : ""}`; break;
      case "recovery_created": text = `Ticket refunded after payout, ${usd(amountCents ?? 0)} to take back from the host.`; break;
      case "recovery_reversed": text = `${usd(amountCents ?? 0)} taken back from the host's Stripe balance.`; break;
      case "recovery_owed": text = `Host owes ${usd(amountCents ?? 0)}: taking it back from Stripe failed.`; break;
      case "recovery_recovered": text = `${usd(amountCents ?? 0)} taken from a later payout.`; break;
      case "recovery_collected": text = `${usd(amountCents ?? 0)} marked collected by an admin.`; break;
      case "recovery_written_off": text = `${usd(amountCents ?? 0)} written off by an admin.`; break;
      case "admin_action": text = `${ADMIN_ACTION_TEXT[r.detail] ?? `Admin action: ${String(r.detail ?? "").replace(/[_.]/g, " ")}`}${r.actor ? ` by @${r.actor}` : ""}.`; break;
      default: text = kind.replace(/_/g, " ");
    }
    return { at: iso(r.at)!, kind, refId: (r.ref_id ?? null) as string | null, amountCents, detail, actorUsername: (r.actor ?? null) as string | null, text };
  });
}
