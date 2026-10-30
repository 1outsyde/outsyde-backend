/**
 * Daily bank payout (spec docs/superpowers/specs/2026-10-21-daily-bank-payout-design.md, sections B and D).
 *
 * computeHeld(): how much of the money sitting on the Outsyde platform belongs to someone else (sellers, hosts,
 * influencers, buyers) plus refund cover. The daily job (below, runBankPayoutJob) pays the Outsyde bank only
 * available balance - held - buffer. One read-only statement; every part is in cents. Owed event recoveries are
 * never counted (money the platform is owed, not money it holds).
 *
 * A pending refund request counts at most what the admin approval (routes.ts PATCH /api/admin/refund-requests/:id)
 * would really refund: it refunds the request amount on the target's Stripe payment intent (order, appointment or
 * shoot_booking), so each request is LEAST(amount, what was paid on that target less refunds); a target that is
 * missing, has no payment intent, or a target type the approval does not refund counts 0. The amount is set by the
 * requester, so it is never trusted on its own. Ticket exposure includes 'paused' events (still refundable).
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
  /** Business referral cash (072) owed to referrers and not sent yet: pending, held or review. */
  referralPayoutsOpen: number;
  /** Event team pay (087) Outsyde owes team members and hasn't sent yet: pending, held or review. */
  teamPayoutsOpen: number;
};

/** Counts that block or flag the payout; not money, so never part of total. */
export type Gates = {
  recentTopups: number;
  openIssueRows: number;
  eventPayoutsWaitingBalance: number;
  referralPayoutsWaitingBalance: number;
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
 (SELECT COALESCE(SUM(LEAST(r.amount::bigint, COALESCE(CASE r.target_type
    WHEN 'order' THEN (SELECT GREATEST(o.total_amount, COALESCE(o.gross_charge_amount,0))::bigint FROM orders o WHERE o.id=r.target_id AND o.stripe_payment_intent_id IS NOT NULL)
    WHEN 'appointment' THEN (SELECT GREATEST(c + ROUND(c*0.08) - COALESCE(discount_amount_cents,0) - COALESCE(refund_amount,0),0)::bigint FROM (SELECT COALESCE(deposit_amount_cents,total_price) c, discount_amount_cents, refund_amount FROM appointments WHERE id=r.target_id AND stripe_payment_intent_id IS NOT NULL) a)
    WHEN 'shoot_booking' THEN (SELECT GREATEST(c + ROUND(c*0.08) - COALESCE(discount_amount_cents,0) - COALESCE(refund_amount,0),0)::bigint FROM (SELECT COALESCE(deposit_amount_cents,total_price) c, discount_amount_cents, refund_amount FROM shoot_bookings WHERE id=r.target_id AND stripe_payment_intent_id IS NOT NULL) s)
  END, 0))),0) FROM refund_requests r WHERE r.status='pending')::bigint AS pending_refund_requests,
 (SELECT COALESCE(SUM(t.host_net_cents),0) FROM tickets t JOIN ticket_orders o ON o.id=t.order_id WHERE t.status='valid' AND o.status='completed' AND t.payout_id IS NULL)::bigint AS ticket_host_net_unpaid,
 (SELECT COALESCE(SUM(amount_cents),0) FROM event_payouts WHERE status IN ('pending','held','review'))::bigint AS event_payouts_open,
 (SELECT COALESCE(SUM(refund_amount_cents),0) FROM ticket_orders WHERE status='refunding')::bigint AS ticket_refunds_sending,
 (SELECT COALESCE(SUM(o.total_cents-o.refunded_cents),0) FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE e.status IN ('published','draft','paused') AND e.starts_at > now() AND (o.status='completed' OR (o.status='refunded' AND o.refund_reason IS DISTINCT FROM 'event_cancelled')) AND o.needs_review_at IS NULL)::bigint AS ticket_exposure_unstarted,
 (SELECT COALESCE(SUM(LEAST(o.total_cents-o.refunded_cents, GREATEST(0,o.subtotal_cents+o.tax_cents-o.discount_cents))),0) FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE e.status IN ('published','paused') AND e.starts_at <= now() AND e.ends_at > now() - interval '30 days' AND o.status='completed')::bigint AS ticket_exposure_started_30d,
 (SELECT COALESCE(SUM(amount_cents),0) FROM influencer_earning_ledger WHERE status IN ('pending','ready_for_payout') AND amount_cents > 0)::bigint AS influencer_owed,
 ((SELECT COALESCE(SUM(GREATEST(c + ROUND(c*0.08) - COALESCE(discount_amount_cents,0) - COALESCE(refund_amount,0),0)),0) FROM (SELECT COALESCE(deposit_amount_cents,total_price) c, discount_amount_cents, refund_amount FROM appointments, nyd WHERE status IN ('confirmed','completed','no_show') AND stripe_payment_intent_id IS NOT NULL AND (created_at > (now() AT TIME ZONE 'UTC') - interval '30 days' OR (status='confirmed' AND appointment_date >= nyd.d))) a)
 +(SELECT COALESCE(SUM(GREATEST(c + ROUND(c*0.08) - COALESCE(discount_amount_cents,0) - COALESCE(refund_amount,0),0)),0) FROM (SELECT COALESCE(deposit_amount_cents,total_price) c, discount_amount_cents, refund_amount FROM shoot_bookings, nyd WHERE status IN ('confirmed','completed','no_show') AND stripe_payment_intent_id IS NOT NULL AND (created_at > (now() AT TIME ZONE 'UTC') - interval '30 days' OR (status='confirmed' AND date >= nyd.d))) s))::bigint AS booking_refund_cover,
 (SELECT count(*) FROM booking_payout_issues WHERE topup_requested_at > now() - interval '7 days')::int AS recent_topups,
 (SELECT count(*) FROM booking_payout_issues WHERE status='open')::int AS open_issue_rows,
 (SELECT count(*) FROM event_payouts WHERE status='pending' AND last_error ILIKE '%insufficient%')::int AS event_payouts_waiting_balance,
 (SELECT COALESCE(SUM(amount_cents),0) FROM referral_payouts WHERE status IN ('pending','held','review'))::bigint AS referral_payouts_open,
 (SELECT count(*) FROM referral_payouts WHERE status='pending' AND last_error ILIKE '%insufficient%')::int AS referral_payouts_waiting_balance,
 (SELECT COALESCE(SUM(amount_cents),0) FROM event_team_payouts WHERE status IN ('pending','held','review'))::bigint AS team_payouts_open
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
    referralPayoutsOpen: n(r.referral_payouts_open),
    teamPayoutsOpen: n(r.team_payouts_open),
  };
  const gates: Gates = {
    recentTopups: n(r.recent_topups),
    openIssueRows: n(r.open_issue_rows),
    eventPayoutsWaitingBalance: n(r.event_payouts_waiting_balance),
    referralPayoutsWaitingBalance: n(r.referral_payouts_waiting_balance),
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { breakdown, total, gates };
}

// ═══════════════════════════════════════════════════════════════════════════
// The daily job (spec sections A, C, D). Runs every minute as the last step in bookingStateMachine.ts.
//
//   Off unless DAILY_BANK_PAYOUT_ENABLED === "true" (read on every run): off reads nothing from Stripe, writes nothing.
//   1. checkSentPayouts: each 'sent' row is checked at Stripe (bounded, at most hourly): paid -> 'paid'; failed or
//      canceled -> 'failed' + one email (the money goes back to the balance and the next day's payout picks it up);
//      still not final 10 days after it was sent -> one email. A 'paid' row is re-checked hourly for 7 days after
//      paid_at; failed or canceled then -> 'failed' + the same email.
//      alertStalePending: a 'pending' row from an earlier New York date whose last try never finished -> one email.
//   2. The New York day's first run at or after 06:00. A final row for the day (paid, sent, skipped, failed, review)
//      ends it. Stripe not on manual payouts -> skipped 'stripe_not_manual' with NO row (the day still runs once the
//      schedule is flipped), no email.
//   3. Claim (the unique payout_date): insert the day's 'pending' row, or re-claim it once its next_attempt_at is due.
//      attempts + 1 and a 10 minute in-flight lock; the claim's updated_at in microseconds is the ownership tag
//      (same pattern as eventPayouts.ts) and the idempotency key's suffix, new on every try.
//   4. Lookup FIRST on every try (before any skip), so a payout an earlier try made but never saved (lost response)
//      is always recorded, never sent again and never hidden behind a 'skipped' row: ours for this date -> 'sent'
//      with its id; any other payout created since New York midnight -> skipped 'other_payout_today'; 500 or more
//      listed (the helper's page cap) -> can't tell, a failed try.
//   5. Held money (computeHeld) and gates (recent top-up, open booking payout issue, event payout waiting for
//      balance) -> skipped with a reason. Balance: other currencies -> one email that day (alerted_at), USD still paid.
//      amount = available USD - held - 10000 buffer (never below 0); under 2500 -> skipped 'below_minimum'.
//   6. Re-take the lock while this claim still owns the row (saving the numbers), create with key
//      bank_payout_<date>_<claim microseconds> -> 'sent'. Insufficient funds -> skipped 'insufficient_funds', no email.
//      Other errors -> backoff 10, 20, 40, 60 minutes; the 5th failure -> 'review' + one email. A try never decides
//      "not sent" from its own failed call: the next try's lookup does.
// Every Stripe call is bounded (30 s, 1 network retry). Every write to a claimed row matches the ownership tag, so a
// run that lost the row writes nothing and sends no email. Writes set updated_at = now() (no trigger on this table).
// ═══════════════════════════════════════════════════════════════════════════

type StripeServiceT = typeof import("./stripe/stripeService").stripeService;
export type BankStripe = Pick<StripeServiceT,
  "getPlatformPayoutInterval" | "getAvailableUsdBalance" | "listPlatformPayoutsCreatedSince" | "createPlatformPayout" | "retrievePlatformPayout" | "isInsufficientFundsError">;
export type BankJobResult = { action: "off" | "not_yet" | "done_today" | "skipped" | "sent" | "retry" | "review"; reason?: string };

export const BANK_BUFFER_CENTS = 10000;
export const BANK_MIN_CENTS = 2500;
export const BANK_MAX_ATTEMPTS = 5;
/** A claim keeps the row this long, so a payout still in flight is never sent again under a new key. */
export const BANK_LOCK_MINUTES = 10;
/** A 'sent' row not paid, failed or canceled this long after it was sent: one admin email. */
export const SENT_ALERT_DAYS = 10;
const BANK_RUN_HOUR = 6;
const SENT_CHECK_LIMIT = 20;
/** A sent (or recently paid) row is checked at Stripe at most this often. */
const SENT_CHECK_EVERY_MINUTES = 60;
/** A paid row keeps being checked this long after paid_at (a paid payout can still fail at the bank). */
const PAID_RECHECK_DAYS = 7;
/** listPlatformPayoutsCreatedSince stops at 5 pages of 100: at that count the list may be cut short. */
const LIST_CAP = 500;
const STRIPE_CALL_BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };
const NY_TZ = "America/New_York";

/** Ownership tag: updated_at in microseconds (copied from eventPayouts.ts). Every write sets updated_at. */
const OWNER_TAG = sql`(extract(epoch from updated_at) * 1000000)::bigint::text`;

let bankAlertForTest: ((subject: string, detail: string) => Promise<void>) | null = null;
/** Test seam only: receives the full subject ([Payouts] prefix included) instead of sending an email. */
export function setBankAlertForTest(fn: ((subject: string, detail: string) => Promise<void>) | null): void { bankAlertForTest = fn; }

let afterClaimHook: (() => Promise<void>) | null = null;
let beforeCreateHook: (() => Promise<void>) | null = null;
let beforeHelperWriteHook: ((helper: "skip" | "record" | "toReview") => Promise<void>) | null = null;
/**
 * Test seam only: hold a run right after its claim, or right before its create, or fail a helper's write (skip,
 * record, toReview) as a DB error would. Never set in production.
 */
export function setBankHooksForTest(h: {
  afterClaim?: () => Promise<void>;
  beforeCreate?: () => Promise<void>;
  beforeHelperWrite?: (helper: "skip" | "record" | "toReview") => Promise<void>;
} | null): void {
  afterClaimHook = h?.afterClaim ?? null;
  beforeCreateHook = h?.beforeCreate ?? null;
  beforeHelperWriteHook = h?.beforeHelperWrite ?? null;
}

/** Admin email with the [Payouts] prefix (copy of alertAdmin in events/ticketCheckout.ts). Never throws. */
export async function alertPayouts(subject: string, detail: string): Promise<void> {
  try {
    if (bankAlertForTest) return await bankAlertForTest(`[Payouts] ${subject}`, detail);
    const { sendAdminEmail, ADMIN_NOTIFICATION_EMAIL } = await import("./emailService");
    // Internal alert: no log tag, so it stays out of the customer email History (same as other admin alerts).
    await sendAdminEmail({
      to: ADMIN_NOTIFICATION_EMAIL,
      subject: `[Payouts] ${subject}`,
      html: `<p>${detail.replace(/[<>&]/g, "")}</p>`,
    });
  } catch (err) {
    console.error("[Payouts] admin alert failed:", err);
  }
}

async function realStripe(): Promise<BankStripe> {
  const { stripeService } = await import("./stripe/stripeService");
  return stripeService;
}

const dollars = (cents: number) => `$${(Number(cents) / 100).toFixed(2)}`;
const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300);

const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function nyParts(ms: number) {
  const p: Record<string, number> = {};
  for (const x of nyFormat.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
/** New York offset from UTC at that instant, in ms (negative: -4 h EDT, -5 h EST). */
function nyOffsetMs(ms: number): number {
  const t = nyParts(ms);
  return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) - Math.floor(ms / 1000) * 1000;
}

/** The New York date (YYYY-MM-DD), hour (0-23) and New York midnight of that date as Unix seconds. */
export function nyDayAndHour(now: Date): { date: string; hour: number; dayStartUnix: number } {
  const t = nyParts(now.getTime());
  const date = `${t.y}-${String(t.mo).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
  // Midnight's own offset (it differs from now's on a daylight saving change day): guess, then correct once.
  const wall = Date.UTC(t.y, t.mo - 1, t.d);
  let start = wall - nyOffsetMs(now.getTime());
  start = wall - nyOffsetMs(start);
  return { date, hour: t.h, dayStartUnix: Math.floor(start / 1000) };
}

// ─── Step 1: follow up on sent payouts ──────────────────────────────────────

/**
 * Checks up to 20 due rows at Stripe (one bounded retrieve each): 'sent' rows, and 'paid' rows for 7 days after
 * paid_at (a payout Stripe called paid can still fail at the bank). A row is checked at most hourly: next_attempt_at
 * is the next check time, set to now() + 1 hour after every check that is not final (a failed retrieve too).
 * Writes are guarded by the status the row was read with (no claim here: nothing is sent, and each change happens once).
 * Returns how many rows became paid or failed.
 */
export async function checkSentPayouts(s?: BankStripe): Promise<number> {
  const due = await rows<any>(sql`
    SELECT id, status, payout_date::text AS payout_date, stripe_payout_id, amount_cents
    FROM bank_payouts
    WHERE stripe_payout_id IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (status = 'sent' OR (status = 'paid' AND paid_at > now() - make_interval(days => ${PAID_RECHECK_DAYS}::int)))
    ORDER BY next_attempt_at NULLS FIRST, sent_at NULLS FIRST, id LIMIT ${SENT_CHECK_LIMIT}`);
  if (!due.length) return 0;
  const st = s ?? (await realStripe());
  let done = 0;
  for (const r of due) {
    let status: string | null = null;
    let final = false;
    try {
      const p = await st.retrievePlatformPayout(r.stripe_payout_id, STRIPE_CALL_BOUND);
      status = p.status;
      if (p.status === "paid" && r.status === "sent") {
        final = true;
        const [u] = await rows<any>(sql`
          UPDATE bank_payouts SET status = 'paid', stripe_status = 'paid', paid_at = now(),
                 next_attempt_at = now() + make_interval(mins => ${SENT_CHECK_EVERY_MINUTES}::int), updated_at = now()
          WHERE id = ${r.id} AND status = 'sent' RETURNING id`);
        if (u) done++;
        continue;
      }
      if (p.status === "failed" || p.status === "canceled") {
        final = true;
        const [u] = await rows<any>(sql`
          UPDATE bank_payouts SET status = 'failed', stripe_status = ${p.status}, failed_at = now(), next_attempt_at = NULL,
                 last_error = ${p.failureCode ? `Stripe failure code ${p.failureCode}` : `Stripe status ${p.status}`}, updated_at = now()
          WHERE id = ${r.id} AND status = ${r.status} RETURNING id`);
        if (u) {
          done++;
          await alertPayouts("Bank payout failed",
            `The bank payout ${r.stripe_payout_id} of ${dollars(r.amount_cents)} for ${r.payout_date} ${p.status === "failed" ? "failed" : "was canceled"} at Stripe` +
            `${p.failureCode ? `, failure code ${p.failureCode}` : ""}. The money goes back to the Stripe balance and is picked up by the next daily payout. ` +
            `Check the bank account in Stripe.`);
        }
        continue;
      }
    } catch (err) {
      console.error(`[Payouts] bank payout ${r.stripe_payout_id} status check failed: ${errText(err)}`);
    } finally {
      if (!final) {
        // Not final (or Stripe could not be asked): the next check in an hour.
        await rows<any>(sql`
          UPDATE bank_payouts SET stripe_status = COALESCE(${status}::text, stripe_status),
                 next_attempt_at = now() + make_interval(mins => ${SENT_CHECK_EVERY_MINUTES}::int), updated_at = now()
          WHERE id = ${r.id} AND status = ${r.status} RETURNING id`).catch((err) => {
          console.error(`[Payouts] bank payout ${r.stripe_payout_id} next check time not saved: ${errText(err)}`);
        });
      }
    }
    if (r.status !== "sent") continue;
    // Still sent: one email once it is 10 days past the send. An alerted_at from before the send (the other
    // currency email that day) does not count.
    try {
      const [old] = await rows<any>(sql`
        UPDATE bank_payouts SET alerted_at = now(), updated_at = now()
        WHERE id = ${r.id} AND status = 'sent' AND sent_at <= now() - make_interval(days => ${SENT_ALERT_DAYS}::int)
          AND (alerted_at IS NULL OR alerted_at < sent_at)
        RETURNING id`);
      if (old) {
        await alertPayouts("Bank payout has not arrived",
          `The bank payout ${r.stripe_payout_id} of ${dollars(r.amount_cents)} for ${r.payout_date} was sent over ${SENT_ALERT_DAYS} days ago ` +
          `and Stripe still reports it as ${status ?? "unknown (the status check failed)"}. Check it in Stripe.`);
      }
    } catch (err) {
      console.error(`[Payouts] bank payout ${r.stripe_payout_id} age check failed: ${errText(err)}`);
    }
  }
  return done;
}

/**
 * A 'pending' row from an earlier New York date whose last try never finished (its lock or backoff has run out and
 * it is never claimed again): one admin email, alerted_at set, status unchanged. An alerted_at set during that day's
 * own tries (the other currency email) is older than the row's last next_attempt_at, so it does not stop this one;
 * the alerted_at this sets is newer, so it is never sent again.
 */
export async function alertStalePending(today: string): Promise<number> {
  const stale = await rows<any>(sql`
    UPDATE bank_payouts SET alerted_at = now(), updated_at = now()
    WHERE status = 'pending' AND payout_date < ${today}::date
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (alerted_at IS NULL OR alerted_at < next_attempt_at)
    RETURNING payout_date::text AS payout_date, attempts`);
  for (const r of stale) {
    await alertPayouts("Bank payout did not finish",
      `A bank payout try for ${r.payout_date} did not finish, so a payout may have reached Stripe. ` +
      `Check the payouts for that day in Stripe. Nothing more is tried for that day.`);
  }
  return stale.length;
}

// ─── Steps 2 to 6: today's payout ───────────────────────────────────────────

/** One run of the daily bank payout. Safe to run any number of times, at the same time too. */
export async function runBankPayoutJob(now: Date = new Date(), s?: BankStripe): Promise<BankJobResult> {
  if (process.env.DAILY_BANK_PAYOUT_ENABLED !== "true") return { action: "off" };
  const st = s ?? (await realStripe());

  try {
    await checkSentPayouts(st);
  } catch (err) {
    console.error(`[Payouts] sent payout check failed: ${errText(err)}`);
  }

  const { date, hour, dayStartUnix } = nyDayAndHour(now);
  try {
    await alertStalePending(date);
  } catch (err) {
    console.error(`[Payouts] unfinished payout check failed: ${errText(err)}`);
  }
  if (hour < BANK_RUN_HOUR) return { action: "not_yet" };

  const [today] = await rows<any>(sql`
    SELECT status, (next_attempt_at IS NULL OR next_attempt_at <= now()) AS due FROM bank_payouts WHERE payout_date = ${date}::date`);
  if (today && (today.status !== "pending" || !today.due)) return { action: "done_today" };

  // Live check, before any row: not manual is the expected state until Legend flips it, so no row and no email.
  if (!today) {
    let interval: string | null;
    try {
      interval = await st.getPlatformPayoutInterval(STRIPE_CALL_BOUND);
    } catch (err) {
      console.error(`[Payouts] payout schedule check failed: ${errText(err)}`);
      return { action: "retry", reason: "schedule_check_failed" };
    }
    if (interval !== "manual") return { action: "skipped", reason: "stripe_not_manual" };
  }

  // Claim: the day's row (unique payout_date), or the due pending one. Two runs can't both get it.
  let [p] = await rows<any>(sql`
    INSERT INTO bank_payouts (payout_date, status, attempts, buffer_cents, next_attempt_at, updated_at)
    VALUES (${date}::date, 'pending', 1, ${BANK_BUFFER_CENTS}, now() + make_interval(mins => ${BANK_LOCK_MINUTES}::int), now())
    ON CONFLICT (payout_date) DO NOTHING
    RETURNING id, attempts, alerted_at, ${OWNER_TAG} AS claim_tag`);
  if (!p) {
    [p] = await rows<any>(sql`
      UPDATE bank_payouts SET attempts = attempts + 1, next_attempt_at = now() + make_interval(mins => ${BANK_LOCK_MINUTES}::int), updated_at = now()
      WHERE payout_date = ${date}::date AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING id, attempts, alerted_at, ${OWNER_TAG} AS claim_tag`);
  }
  if (!p) return { action: "done_today" };
  const claimTag = String(p.claim_tag);
  let tag = claimTag;
  const attempts = Number(p.attempts);
  if (afterClaimHook) await afterClaimHook();

  /** Skip the day, only while this claim owns the row. */
  const skip = async (reason: string, nums?: { available?: number; held?: number; breakdown?: HeldBreakdown }, error?: string): Promise<BankJobResult> => {
    if (beforeHelperWriteHook) await beforeHelperWriteHook("skip");
    const [u] = await rows<any>(sql`
      UPDATE bank_payouts SET status = 'skipped', skip_reason = ${reason}, next_attempt_at = NULL,
             available_cents = COALESCE(${nums?.available ?? null}::int, available_cents),
             held_cents = COALESCE(${nums?.held ?? null}::int, held_cents),
             held_breakdown = COALESCE(${nums?.breakdown ? JSON.stringify(nums.breakdown) : null}::jsonb, held_breakdown),
             last_error = COALESCE(${error ?? null}::text, last_error), updated_at = now()
      WHERE id = ${p.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
      RETURNING id`);
    if (!u) return { action: "retry", reason: "lost_claim" };
    console.log(`[Payouts] bank payout ${date} skipped: ${reason}`);
    return { action: "skipped", reason };
  };

  /** Record a payout that exists at Stripe (made by this try, or an earlier one whose reply was lost). */
  const record = async (payoutId: string, status: string, amount: number, mineOnly: boolean): Promise<BankJobResult> => {
    if (beforeHelperWriteHook) await beforeHelperWriteHook("record");
    // A payout this try just made is recorded while this run owns the row or while nobody does (as eventPayouts.ts).
    const [u] = await rows<any>(sql`
      UPDATE bank_payouts SET status = 'sent', stripe_payout_id = ${payoutId}, stripe_status = ${status}, amount_cents = ${amount},
             sent_at = now(), next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${p.id} AND status = 'pending'
        AND (${OWNER_TAG} = ${tag} OR (${!mineOnly} AND (next_attempt_at IS NULL OR next_attempt_at <= now())))
      RETURNING id`);
    if (!u) return { action: "retry", reason: "lost_claim" };
    console.log(`[Payouts] bank payout ${date}: ${payoutId} of ${amount} cents sent`);
    return { action: "sent" };
  };

  try {
    // Lookup first: anything created since New York midnight.
    // Every helper below is `return await`ed so its rejection (a DB error) reaches the catch: backoff, 5 try limit, review.
    const todaysPayouts = await st.listPlatformPayoutsCreatedSince(dayStartUnix, STRIPE_CALL_BOUND);
    if (todaysPayouts.length >= LIST_CAP) throw new Error(`Stripe listed ${todaysPayouts.length} payouts today (the lookup limit), can't tell if one is ours`);
    const ours = todaysPayouts.filter((x) => x.metadata?.type === "outsyde_bank_payout" && x.metadata?.payoutDate === date);
    if (ours.length > 1) return await toReview(`Stripe has ${ours.length} bank payouts for ${date} (${ours.map((x) => x.id).join(", ")})`);
    if (ours.length === 1) return await record(ours[0].id, ours[0].status, ours[0].amount, true);
    if (todaysPayouts.length) return await skip("other_payout_today");

    const held = await computeHeld();
    if (held.gates.recentTopups > 0) return await skip("recent_topup", { held: held.total, breakdown: held.breakdown });
    if (held.gates.openIssueRows > 0) return await skip("open_booking_payout_issues", { held: held.total, breakdown: held.breakdown });
    if (held.gates.eventPayoutsWaitingBalance > 0) return await skip("event_payout_waiting_balance", { held: held.total, breakdown: held.breakdown });
    if (held.gates.referralPayoutsWaitingBalance > 0) return await skip("referral_payout_waiting_balance", { held: held.total, breakdown: held.breakdown });

    const bal = await st.getAvailableUsdBalance(STRIPE_CALL_BOUND);
    const available = Number(bal.usdCents);
    if (bal.otherCurrencies.length) {
      // At most one email per day: the day's row alerted_at.
      const [a] = await rows<any>(sql`
        UPDATE bank_payouts SET alerted_at = now(), updated_at = now()
        WHERE id = ${p.id} AND status = 'pending' AND alerted_at IS NULL AND ${OWNER_TAG} = ${tag}
        RETURNING ${OWNER_TAG} AS tag`);
      if (a) {
        tag = String(a.tag);
        await alertPayouts("Bank payout found other currencies",
          `The Stripe balance on ${date} holds money in ${bal.otherCurrencies.map((c) => c.toUpperCase()).join(", ")}. ` +
          `The daily bank payout only pays out USD, so that money stays in Stripe. Check it in Stripe.`);
      }
    }
    const amount = Math.max(0, available - held.total - BANK_BUFFER_CENTS);
    const nums = { available, held: held.total, breakdown: held.breakdown };
    if (amount < BANK_MIN_CENTS) return await skip("below_minimum", nums);

    // Re-take the lock, only while this claim still owns the row (the reads above may have been slow), saving the numbers.
    const [mine] = await rows<any>(sql`
      UPDATE bank_payouts SET next_attempt_at = now() + make_interval(mins => ${BANK_LOCK_MINUTES}::int),
             available_cents = ${available}, held_cents = ${held.total}, held_breakdown = ${JSON.stringify(held.breakdown)}::jsonb,
             buffer_cents = ${BANK_BUFFER_CENTS}, updated_at = now()
      WHERE id = ${p.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`);
    if (!mine) return { action: "retry", reason: "lost_claim" };
    tag = String(mine.tag);
    if (beforeCreateHook) await beforeCreateHook();

    // One key per try (the claim's own time in microseconds): Stripe replays a saved reply for 24 hours, errors too.
    const made = await st.createPlatformPayout({
      amountCents: amount, payoutDate: date, rowId: p.id,
      idempotencyKey: `bank_payout_${date}_${claimTag}`, ...STRIPE_CALL_BOUND,
    });
    return await record(made.id, made.status, amount, false);
  } catch (err) {
    const msg = errText(err);
    if (st.isInsufficientFundsError(err)) {
      // The balance moved since the read: a definite no from Stripe. Skip the day, no email.
      return skip("insufficient_funds", undefined, msg);
    }
    console.error(`[Payouts] bank payout ${date} try ${attempts} failed: ${msg}`);
    // Never "not sent" from this failure (a timed out create may still land): backoff, and the next try's lookup decides.
    const [still] = await rows<any>(sql`
      UPDATE bank_payouts SET last_error = ${msg},
             -- Backoff 10, 20, 40, then 60 minutes: never shorter than the in-flight lock.
             next_attempt_at = now() + make_interval(mins => LEAST(60, ${BANK_LOCK_MINUTES}::int * power(2, LEAST(attempts - 1, 6)))::int),
             updated_at = now()
      WHERE id = ${p.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`).catch((dbErr) => {
        console.error(`[Payouts] bank payout ${date} backoff not saved: ${errText(dbErr)}`);
        return [] as any[];
      });
    if (!still) return { action: "retry", reason: "lost_claim" };
    tag = String(still.tag);
    if (attempts >= BANK_MAX_ATTEMPTS) {
      return toReview(`it failed ${attempts} times, last error: ${msg}. A payout from the last try may still have reached Stripe`);
    }
    return { action: "retry", reason: "error" };
  }

  async function toReview(why: string): Promise<BankJobResult> {
    if (beforeHelperWriteHook) await beforeHelperWriteHook("toReview");
    const [u] = await rows<any>(sql`
      UPDATE bank_payouts SET status = 'review', last_error = ${why.slice(0, 300)}, next_attempt_at = NULL, updated_at = now()
      WHERE id = ${p.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
      RETURNING id`);
    if (!u) return { action: "retry", reason: "lost_claim" };
    await alertPayouts("Bank payout needs a look",
      `The daily bank payout for ${date} was stopped: ${why}. Check the payouts for that day in Stripe. Nothing more is tried for this day, ` +
      `and the next day's payout runs as usual.`);
    return { action: "review" };
  }
}
