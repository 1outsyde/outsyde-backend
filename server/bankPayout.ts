/**
 * Daily bank payout (spec docs/superpowers/specs/2026-10-21-daily-bank-payout-design.md, sections B and D).
 *
 * computeHeld(): how much of the money sitting on the Outsyde platform belongs to someone else (sellers, hosts,
 * influencers, buyers) plus refund cover. The daily job (added to this file later) pays the Outsyde bank only
 * available balance - held - buffer. One read-only statement; every part is in cents. Owed event recoveries are
 * never counted (money the platform is owed, not money it holds).
 */
import { sql } from "drizzle-orm";
import { rows } from "./events/eventsRouter";

export type HeldBreakdown = {
  openBookingPayouts: number;
  settledNoTransfer: number;
  unsettledConfirmed: number;
  ordersTransferFailed: number;
  pendingRefundRequests: number;
  ticketHostNetUnpaid: number;
  eventPayoutsOpen: number;
  ticketRefundsSending: number;
  ticketExposureUnstarted: number;
  ticketExposureStarted30d: number;
  influencerOwed: number;
  bookingRefundCover: number;
};

/** Counts that block or flag the payout; not money, so never part of total. */
export type Gates = {
  recentTopups: number;
  openIssueRows: number;
  eventPayoutsWaitingBalance: number;
};

export async function computeHeld(): Promise<{ breakdown: HeldBreakdown; total: number; gates: Gates }> {
  const [r] = await rows<Record<string, string | number | null>>(sql.raw(`
WITH nyd AS (SELECT to_char(now() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS d)
SELECT
 (SELECT COALESCE(SUM(amount_cents),0) FROM booking_payout_issues WHERE status='open')::bigint AS open_booking_payouts,
 ((SELECT COALESCE(SUM(a.vendor_net),0) FROM appointments a WHERE a.settled_at IS NOT NULL AND a.stripe_transfer_id IS NULL AND a.status IN ('confirmed','completed','no_show') AND COALESCE(a.refund_amount,0)=0 AND a.vendor_net > 0 AND NOT EXISTS (SELECT 1 FROM booking_payout_issues i WHERE i.reference_type='appointment' AND i.reference_id=a.id AND i.is_base))
 +(SELECT COALESCE(SUM(s.vendor_net),0) FROM shoot_bookings s WHERE s.settled_at IS NOT NULL AND s.stripe_transfer_id IS NULL AND s.status IN ('confirmed','completed','no_show') AND COALESCE(s.refund_amount,0)=0 AND s.vendor_net > 0 AND s.payment_method IS DISTINCT FROM 'checkout_session' AND NOT EXISTS (SELECT 1 FROM booking_payout_issues i WHERE i.reference_type='shoot_booking' AND i.reference_id=s.id AND i.is_base)))::bigint AS settled_no_transfer,
 ((SELECT COALESCE(SUM(vendor_net),0) FROM appointments WHERE status='confirmed' AND settled_at IS NULL AND hold_id IS NOT NULL AND platform_fee > 0)
 +(SELECT COALESCE(SUM(vendor_net),0) FROM shoot_bookings WHERE status='confirmed' AND settled_at IS NULL AND payment_method='payment_intent'))::bigint AS unsettled_confirmed,
 (SELECT COALESCE(SUM(vendor_net),0) FROM orders WHERE status='transfer_failed')::bigint AS orders_transfer_failed,
 (SELECT COALESCE(SUM(amount),0) FROM refund_requests WHERE status='pending')::bigint AS pending_refund_requests,
 (SELECT COALESCE(SUM(t.host_net_cents),0) FROM tickets t JOIN ticket_orders o ON o.id=t.order_id WHERE t.status='valid' AND o.status='completed' AND t.payout_id IS NULL)::bigint AS ticket_host_net_unpaid,
 (SELECT COALESCE(SUM(amount_cents),0) FROM event_payouts WHERE status IN ('pending','held','review'))::bigint AS event_payouts_open,
 (SELECT COALESCE(SUM(refund_amount_cents),0) FROM ticket_orders WHERE status='refunding')::bigint AS ticket_refunds_sending,
 (SELECT COALESCE(SUM(o.total_cents-o.refunded_cents),0) FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE e.status IN ('published','draft') AND e.starts_at > now() AND (o.status='completed' OR (o.status='refunded' AND o.refund_reason IS DISTINCT FROM 'event_cancelled')) AND o.needs_review_at IS NULL)::bigint AS ticket_exposure_unstarted,
 (SELECT COALESCE(SUM(LEAST(o.total_cents-o.refunded_cents, GREATEST(0,o.subtotal_cents+o.tax_cents-o.discount_cents))),0) FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE e.status='published' AND e.starts_at <= now() AND e.ends_at > now() - interval '30 days' AND o.status='completed')::bigint AS ticket_exposure_started_30d,
 (SELECT COALESCE(SUM(amount_cents),0) FROM influencer_earning_ledger WHERE status IN ('pending','ready_for_payout') AND amount_cents > 0)::bigint AS influencer_owed,
 ((SELECT COALESCE(SUM(GREATEST(c + ROUND(c*0.08) - COALESCE(discount_amount_cents,0) - COALESCE(refund_amount,0),0)),0) FROM (SELECT COALESCE(deposit_amount_cents,total_price) c, discount_amount_cents, refund_amount FROM appointments, nyd WHERE status IN ('confirmed','completed','no_show') AND stripe_payment_intent_id IS NOT NULL AND (created_at > (now() AT TIME ZONE 'UTC') - interval '30 days' OR (status='confirmed' AND appointment_date >= nyd.d))) a)
 +(SELECT COALESCE(SUM(GREATEST(c + ROUND(c*0.08) - COALESCE(discount_amount_cents,0) - COALESCE(refund_amount,0),0)),0) FROM (SELECT COALESCE(deposit_amount_cents,total_price) c, discount_amount_cents, refund_amount FROM shoot_bookings, nyd WHERE status IN ('confirmed','completed','no_show') AND stripe_payment_intent_id IS NOT NULL AND (created_at > (now() AT TIME ZONE 'UTC') - interval '30 days' OR (status='confirmed' AND date >= nyd.d))) s))::bigint AS booking_refund_cover,
 (SELECT count(*) FROM booking_payout_issues WHERE topup_requested_at > now() - interval '7 days')::int AS recent_topups,
 (SELECT count(*) FROM booking_payout_issues WHERE status='open')::int AS open_issue_rows,
 (SELECT count(*) FROM event_payouts WHERE status='pending' AND last_error ILIKE '%insufficient%')::int AS event_payouts_waiting_balance
`));
  const n = (v: unknown) => Number(v ?? 0);
  const breakdown: HeldBreakdown = {
    openBookingPayouts: n(r.open_booking_payouts),
    settledNoTransfer: n(r.settled_no_transfer),
    unsettledConfirmed: n(r.unsettled_confirmed),
    ordersTransferFailed: n(r.orders_transfer_failed),
    pendingRefundRequests: n(r.pending_refund_requests),
    ticketHostNetUnpaid: n(r.ticket_host_net_unpaid),
    eventPayoutsOpen: n(r.event_payouts_open),
    ticketRefundsSending: n(r.ticket_refunds_sending),
    ticketExposureUnstarted: n(r.ticket_exposure_unstarted),
    ticketExposureStarted30d: n(r.ticket_exposure_started_30d),
    influencerOwed: n(r.influencer_owed),
    bookingRefundCover: n(r.booking_refund_cover),
  };
  const gates: Gates = {
    recentTopups: n(r.recent_topups),
    openIssueRows: n(r.open_issue_rows),
    eventPayoutsWaitingBalance: n(r.event_payouts_waiting_balance),
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { breakdown, total, gates };
}
