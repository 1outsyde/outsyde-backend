/**
 * Events & Ticketing Phase 2, PR 5a: the event payout job (spec D, docs/superpowers/specs/2026-10-19-event-host-payouts-design.md).
 *
 * One Stripe transfer per event to the host, 3 days after the event ends, never twice. Runs every minute as its
 * own step in bookingStateMachine.ts (runEventPayoutJob), after the ticket refund step.
 *
 *   1. createDuePayouts: ONE statement per due event inserts the event_payouts row and stamps tickets.payout_id on
 *      every valid ticket of a completed order. Due = published, ends_at + 3 days passed, no payout row yet, and no
 *      unflagged pending or refunding order (those settle first; flagged ones were already sent to the admin and
 *      their tickets are never valid on a completed order, so they are never stamped). Free events never get a row.
 *   2. sendPayout: claim first (attempts + 1, next_attempt_at = now + 10 minutes, the in-flight lock), so two runs
 *      can't both call Stripe. Every Stripe call is bounded (30 s, 1 retry), and the owner re-takes the lock right
 *      before the lookup + create, so a run whose checks were slow enough to lose the row sends nothing. Every status
 *      write matches this claim's ownership tag too, so a run that lost the row writes nothing and sends no email or push. There is no 'sending' status: the claim plays that role, like processTicketRefund. Then:
 *        event paused, or host can't be paid yet -> 'held' with hold_reason, rechecked hourly, admin emailed once.
 *        a transfer already in Stripe for this payout (sent but not saved) -> recorded as 'paid', not sent again.
 *        otherwise transfer with key event_payout_<payoutId>_<claim time in microseconds>, new on every claim
 *        (Stripe replays a saved error for 24 hours) -> 'paid' + host push.
 *        not enough platform balance -> stays 'pending', not counted as a try, retried hourly, admin email at most
 *        once every 24 hours. Other errors -> backoff 10, 20, 40, 60 minutes; after 5 tries 'review' + one email.
 *   Leaving 'review' is manual for now (vault runbook: set status 'pending', attempts 0).
 * The amount is fixed when the row is created (a resent transfer must match the one Stripe may already have). A ticket refunded
 * after it was stamped is paid out, then recovered:
 *   3. openRecoveries: refunded tickets on a 'paid' payout with no recovery row get one ('pending', the ticket's host net).
 *   4. processRecovery: same claim, lock, ownership and bounded calls as sendPayout. Looks for a reversal already made
 *      on the transfer for this ticket (sent but not saved) and records it; otherwise reverses with key
 *      event_recovery_<ticketId>_<claim time in microseconds>, new on every claim. Reversed -> 'reversed'. Not enough
 *      on the host's Stripe balance -> 'owed' at once (after one more look on the transfer). Other errors -> backoff
 *      10, 20, 40, 60 minutes. A claim whose own reversal call just failed never owes (a timed-out call may still
 *      land at Stripe): after the 5th failure it backs off (60 minutes, more than the lock), and the next claim only
 *      looks on the transfer, never sends a reversal: found -> 'reversed'; none -> 'owed'; lookup fails -> pending.
 *      Pending at max tries for over 24 hours (lookups keep failing) -> one admin email (alertStuckRecoveries).
 *   Owed recoveries come back from the same account's next EVENT payout (createDuePayouts, same statement), oldest
 *   first while the payout stays above 0; the rest stays owed. Booking payouts are never touched.
 *   5. alertOldOwed: still owed 30 days after the refund -> one admin email (Legend collects or writes it off by hand).
 */
import { sql } from "drizzle-orm";
import { rows } from "./eventsRouter";
import { guardCode, withDeadlockRetry } from "./ticketsRouter";
import { alertAdmin } from "./ticketCheckout";
import { hostPayoutDestination, isHostReady, type HostEventRef } from "./hostPayouts";
import { notifyPayoutSent } from "./ticketNotices";

type StripeServiceT = typeof import("../stripe/stripeService").stripeService;
export type PayoutStripe = Pick<StripeServiceT, "getPayoutReadiness" | "findEventPayoutTransfer" | "createEventPayoutTransfer">;
export type SendResult = "paid" | "held" | "retry" | "insufficient" | "review" | "not_due";
export type RecoveryStripe = Pick<StripeServiceT, "findEventPayoutReversal" | "reverseEventPayoutTransfer">;
export type RecoveryResult = "reversed" | "owed" | "retry" | "not_due";

export const PAYOUT_MAX_ATTEMPTS = 5;
export const PAYOUT_JOB_LIMIT = 20;
export const RECOVERY_MAX_ATTEMPTS = 5;
export const RECOVERY_JOB_LIMIT = 20;
/** Owed this long after the refund: one admin email. */
export const OWED_ALERT_DAYS = 30;
/** Pending at max tries and opened this long ago (its lookups keep failing): one admin email. */
export const STUCK_RECOVERY_ALERT_HOURS = 24;
/** A claim keeps the row for this long, so a transfer still in flight is never sent again under a new key. */
export const PAYOUT_LOCK_MINUTES = 10;
/** Every Stripe call in a payout attempt is bounded, so the attempt ends well inside the lock. */
const STRIPE_CALL_BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };

/** Test seam only: lets a test hold a run right after its claim (a slow DB read in real life). Never set in production. */
let afterClaimHook: ((payoutId: string) => Promise<void>) | null = null;
let afterRecoveryClaimHook: ((recoveryId: string) => Promise<void>) | null = null;
let afterTeamComputeHook: ((eventId: string) => Promise<void>) | null = null;
export function setPayoutHooksForTest(h: {
  afterClaim?: (payoutId: string) => Promise<void>;
  afterRecoveryClaim?: (recoveryId: string) => Promise<void>;
  afterTeamCompute?: (eventId: string) => Promise<void>;
} | null): void {
  afterClaimHook = h?.afterClaim ?? null;
  afterRecoveryClaimHook = h?.afterRecoveryClaim ?? null;
  afterTeamComputeHook = h?.afterTeamCompute ?? null;
}

async function realStripe(): Promise<PayoutStripe & RecoveryStripe> {
  const { stripeService } = await import("../stripe/stripeService");
  return stripeService;
}

async function isInsufficientFunds(err: unknown): Promise<boolean> {
  try {
    const { stripeService } = await import("../stripe/stripeService");
    return stripeService.isInsufficientFundsError(err);
  } catch {
    return false;
  }
}

/** Outsyde's available balance for the admin email, when the Stripe in use can tell (never throws). */
async function balanceText(s?: PayoutStripe): Promise<string> {
  try {
    const src = (s ?? (await realStripe())) as Partial<Pick<StripeServiceT, "getAvailableBalanceCents">>;
    if (typeof src.getAvailableBalanceCents !== "function") return "unknown";
    return `${await src.getAvailableBalanceCents()} cents`;
  } catch {
    return "unknown";
  }
}

// ─── Step 1: create the payout (one statement per event) ───────────────────

/** One team member's fixed pay at payout time (4b-1): their total and how it was worked out, per role. */
export type TeamLine = { userId: string; amountCents: number; breakdown: Record<string, unknown>; ready: boolean };

/**
 * Step 4b-1: everyone's pay worked out from the pay the host set, as the team stood when the event ended (Legend
 * 2026-10-30, call 15), and the host earnings it was worked out on. The statement in createDuePayouts checks those
 * earnings again under its locks and stops (guard) if they changed, so pay and payout always use the same tickets.
 */
export async function teamLinesFor(e: { id: string; host_user_id: string; ends_at: Date | string }): Promise<{ lines: TeamLine[]; earningsCents: number }> {
  const { eventPay, rolePayJson } = await import("./teamPay");
  const pay = await eventPay(e, { asOf: e.ends_at });
  const lines: TeamLine[] = [];
  // Step 4b-2 (Legend 2026-10-30, call 22): the deadline for payout setup is now. Not set up -> their share stays with the host.
  const { readyMembers } = await import("./teamSend");
  const ready = await readyMembers(pay.members.filter((m) => m.totalCents > 0).map((m) => m.userId));
  for (const m of pay.members) {
    if (m.totalCents <= 0) continue; // nothing owed (e.g. hourly with no shift): no row
    const roles = m.roles.map((role) => ({ role, ...rolePayJson(pay.byRole.get(`${m.userId}:${role}`)) }));
    const sum = (k: "fixedCents" | "hourlyCents" | "commissionCents" | "extraCents") => roles.reduce((n, r) => n + Number((r as any)[k] ?? 0), 0);
    lines.push({
      userId: m.userId, amountCents: m.totalCents, ready: ready.has(m.userId),
      breakdown: {
        roles, fixedCents: sum("fixedCents"), hourlyCents: sum("hourlyCents"), commissionCents: sum("commissionCents"), extraCents: sum("extraCents"),
        hours: roles.reduce((n, r) => n + Number(r.hours ?? 0), 0),
      },
    });
  }
  return { lines, earningsCents: pay.hostEarningsCents };
}

/**
 * Creates payouts for up to `limit` due events. Returns the new host payout ids as a comma list ("" when none).
 *
 * Step 4b-1 (Legend 2026-10-30): in ONE statement per event, from the host earnings: (1) what the host owes Outsyde
 * from earlier events, oldest first, as long as the running total stays within the earnings (it may take all of it,
 * call 17); (2) team pay, all or nothing against what is left; (3) the host gets the rest, $0 included (recorded as
 * paid, nothing to send). Team rows are written for covered ('pending', sent by teamSend.ts) and uncovered or free events
 * ('host_to_pay'). Step 4b-2 (call 22): this is the payout setup deadline. A covered member not set up by now is
 * 'no_setup' ('host_to_pay'): their share is not taken from the host, who pays them directly. events.team_pay_fixed_at marks the event done, so free events with team pay are visited once.
 */
export async function createDuePayouts(limit = PAYOUT_JOB_LIMIT): Promise<string> {
  // Candidates only: the statement below checks every rule again. Events with nothing to pay and no team pay set are
  // skipped here, so they never crowd out paid ones.
  const due = await rows<any>(sql`
    SELECT e.id, e.host_type, e.host_user_id, e.host_business_id, e.host_photographer_id, e.ends_at
    FROM events e
    WHERE e.status = 'published' AND e.ends_at + interval '3 days' <= now() AND e.team_pay_fixed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM event_payouts p WHERE p.event_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM ticket_orders o WHERE o.event_id = e.id AND o.status IN ('pending', 'refunding') AND o.needs_review_at IS NULL)
      AND (EXISTS (SELECT 1 FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
                   WHERE t.event_id = e.id AND t.status = 'valid' AND o.status = 'completed' AND t.payout_id IS NULL AND t.host_net_cents > 0)
           OR EXISTS (SELECT 1 FROM event_team_pay tp WHERE tp.event_id = e.id AND (tp.pay_type <> 'none' OR tp.commission_bps IS NOT NULL))
           -- Step 7: someone whose only pay is a stay longer extra is still recorded (host_to_pay when it can't be covered).
           OR EXISTS (SELECT 1 FROM event_team_extensions x WHERE x.event_id = e.id AND x.status = 'accepted'
                      AND (x.pay_kind IN ('fixed', 'hourly') OR COALESCE(x.final_cents, 0) > 0)))
    ORDER BY e.ends_at
    LIMIT ${limit}`);
  const made: string[] = [];
  for (const e of due) {
    try {
      const { lines, earningsCents } = await teamLinesFor(e);
      if (afterTeamComputeHook) await afterTeamComputeHook(String(e.id));
      const teamTotal = lines.reduce((n, l) => n + l.amountCents, 0);
      // Taken from the host only for members set up for payouts (call 22). All or nothing is still judged on everyone.
      const readyTotal = lines.reduce((n, l) => n + (l.ready ? l.amountCents : 0), 0);
      const linesJson = JSON.stringify(lines.map((l) => ({ member_user_id: l.userId, amount_cents: l.amountCents, breakdown: l.breakdown, ready: l.ready })));
      const [r] = await withDeadlockRetry(() => rows<any>(sql`
        WITH RECURSIVE ev AS (
          SELECT e.id FROM events e
          WHERE e.id = ${e.id} AND e.status = 'published' AND e.ends_at + interval '3 days' <= now() AND e.team_pay_fixed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM event_payouts p WHERE p.event_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM ticket_orders o WHERE o.event_id = e.id AND o.status IN ('pending', 'refunding') AND o.needs_review_at IS NULL)
          FOR UPDATE OF e
        ),
        tk AS (
          -- Locked: a refund running right now either finishes first (its tickets are then 'refunded' and
          -- left out here) or waits for this statement (its tickets are stamped, then recovered in Task 7).
          SELECT t.id, t.host_net_cents FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
          WHERE t.event_id IN (SELECT id FROM ev) AND t.status = 'valid' AND o.status = 'completed' AND t.payout_id IS NULL
          FOR UPDATE OF t
        ),
        g AS (SELECT COALESCE(sum(host_net_cents), 0)::int AS gross FROM tk),
        -- Where the money goes, read in this statement (same rule as hostPayoutDestination): business and
        -- photographer hosts use their profile's account, everyone else their user_payout_accounts row.
        dst AS (
          SELECT CASE WHEN e.host_type = 'business' AND e.host_business_id IS NOT NULL THEN 'business'
                      WHEN e.host_type = 'photographer' AND e.host_photographer_id IS NOT NULL THEN 'photographer'
                      ELSE 'user' END AS dtype,
                 CASE WHEN e.host_type = 'business' AND e.host_business_id IS NOT NULL THEN b.stripe_account_id
                      WHEN e.host_type = 'photographer' AND e.host_photographer_id IS NOT NULL THEN ph.stripe_account_id
                      ELSE u.stripe_account_id END AS acct
          FROM events e
          LEFT JOIN businesses b ON b.id = e.host_business_id
          LEFT JOIN photographers ph ON ph.id = e.host_photographer_id
          LEFT JOIN user_payout_accounts u ON u.user_id = e.host_user_id
          WHERE e.id IN (SELECT id FROM ev)
        ),
        -- Owed recoveries for that account, oldest first (no account: none). Each one is taken only if the running
        -- total of the ones taken stays within gross (Outsyde is paid first, so it may take all of it); one too big is
        -- skipped and stays owed.
        ow AS (
          SELECT r.id, r.amount_cents, row_number() OVER (ORDER BY r.created_at, r.id) AS n
          FROM event_payout_recoveries r JOIN dst ON r.connected_account_id = dst.acct
          WHERE r.status = 'owed'
        ),
        walk(n, id, amount, total, took) AS (
          SELECT 0::bigint, NULL::varchar, 0, 0::bigint, false
          UNION ALL
          SELECT o.n, o.id::varchar, o.amount_cents,
                 CASE WHEN w.total + o.amount_cents <= g.gross THEN w.total + o.amount_cents ELSE w.total END,
                 (w.total + o.amount_cents <= g.gross)
          FROM walk w JOIN ow o ON o.n = w.n + 1 CROSS JOIN g
        ),
        pick AS (SELECT id, amount FROM walk WHERE took),
        d AS (SELECT COALESCE(sum(amount), 0)::int AS ded FROM pick),
        -- Team pay, all or nothing against what is left after the debt. A free event (gross 0) covers nothing.
        tl AS (
          SELECT m.member_user_id, m.amount_cents, m.breakdown, m.ready
          FROM jsonb_to_recordset(${linesJson}::jsonb) AS m(member_user_id varchar, amount_cents int, breakdown jsonb, ready boolean)
        ),
        cov AS (
          SELECT (g.gross > 0 AND ${teamTotal}::int > 0 AND ${teamTotal}::int <= g.gross - d.ded) AS covered FROM g, d
        ),
        ins AS (
          INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, team_cents, amount_cents, status, paid_at)
          SELECT ev.id, dst.dtype, dst.acct, g.gross, d.ded,
                 CASE WHEN cov.covered THEN ${readyTotal}::int ELSE 0 END,
                 g.gross - d.ded - CASE WHEN cov.covered THEN ${readyTotal}::int ELSE 0 END,
                 -- Nothing left for the host: recorded as paid, never sent (Stripe can't send $0).
                 CASE WHEN g.gross - d.ded - CASE WHEN cov.covered THEN ${readyTotal}::int ELSE 0 END = 0 THEN 'paid' ELSE 'pending' END,
                 CASE WHEN g.gross - d.ded - CASE WHEN cov.covered THEN ${readyTotal}::int ELSE 0 END = 0 THEN now() END
          FROM ev, dst, g, d, cov WHERE g.gross > 0
          ON CONFLICT (event_id) DO NOTHING
          RETURNING id
        ),
        tins AS (
          INSERT INTO event_team_payouts (event_id, member_user_id, payout_id, amount_cents, breakdown, outcome, status)
          SELECT ev.id, tl.member_user_id, (SELECT id FROM ins), tl.amount_cents, tl.breakdown,
                 CASE WHEN NOT cov.covered THEN 'not_covered' WHEN tl.ready THEN 'covered' ELSE 'no_setup' END,
                 CASE WHEN cov.covered AND tl.ready THEN 'pending' ELSE 'host_to_pay' END
          FROM ev, tl, cov
          ON CONFLICT (event_id, member_user_id) DO NOTHING
          RETURNING id, amount_cents
        ),
        fx AS (
          UPDATE events SET team_pay_fixed_at = now() WHERE id IN (SELECT id FROM ev) AND team_pay_fixed_at IS NULL RETURNING id
        ),
        -- Still 'owed' when this runs: a payout created at the same time for the same account that took one first
        -- makes the counts differ, and the guard below undoes this whole statement (the next run tries again).
        rec AS (
          UPDATE event_payout_recoveries r SET status = 'recovered', recovered_from_payout_id = ins.id, next_attempt_at = NULL, updated_at = now()
          FROM ins, pick
          WHERE r.id = pick.id AND r.status = 'owed'
          RETURNING r.id, r.amount_cents
        ),
        st AS (
          UPDATE tickets t SET payout_id = ins.id
          FROM ins, tk
          WHERE t.id = tk.id AND t.payout_id IS NULL AND t.status = 'valid'
          RETURNING t.id, t.host_net_cents
        )
        SELECT (SELECT id FROM ins) AS payout_id, EXISTS (SELECT 1 FROM fx) AS fixed,
               CASE WHEN EXISTS (SELECT 1 FROM ins) AND (
                      (SELECT count(*) FROM st) <> (SELECT count(*) FROM tk)
                   OR (SELECT COALESCE(sum(host_net_cents), 0) FROM st) <> (SELECT gross FROM g))
                 THEN ('GUARD_PAYOUT_STAMP:' || (SELECT count(*) FROM st))::int END AS guard_stamp,
               CASE WHEN EXISTS (SELECT 1 FROM ins) AND (
                      (SELECT count(*) FROM rec) <> (SELECT count(*) FROM pick)
                   OR (SELECT COALESCE(sum(amount_cents), 0) FROM rec) <> (SELECT ded FROM d))
                 THEN ('GUARD_PAYOUT_DEDUCT:' || (SELECT count(*) FROM rec))::int END AS guard_deduct,
               -- Pay was worked out on these earnings: if a ticket changed since, nothing is written, the next run redoes it.
               CASE WHEN EXISTS (SELECT 1 FROM ev) AND (SELECT gross FROM g) <> ${earningsCents}::int
                 THEN ('GUARD_TEAM_EARNINGS:' || (SELECT gross FROM g))::int END AS guard_earnings,
               CASE WHEN EXISTS (SELECT 1 FROM fx) AND (SELECT count(*) FROM tins) <> (SELECT count(*) FROM tl)
                 THEN ('GUARD_TEAM_ROWS:' || (SELECT count(*) FROM tins))::int END AS guard_team`));
      if (r?.payout_id) made.push(String(r.payout_id));
    } catch (err) {
      // A guard means something changed mid-statement (nothing was written): the next run tries again.
      const g = guardCode(err);
      console.error(`[Events] payout create for event ${e.id} ${g ? `stopped by guard ${g}` : "failed"}:`, (err as Error)?.message ?? err);
    }
  }
  // Plain text, not a Postgres array: array results don't come back reliably through every driver.
  return made.join(",");
}

// ─── Step 2: send it ────────────────────────────────────────────────────────

const HOLD_TEXT: Record<string, string> = {
  event_paused: "the event is paused",
  no_account: "the host has no payout account",
  not_complete: "the host hasn't finished payout setup",
  stripe_not_ready: "Stripe says the host's account can't take payouts yet",
};

/**
 * Ownership tag: updated_at in microseconds. Every write sets updated_at, so a run owns the row only while the tag
 * still equals the one its own last write returned. Each status write below matches on it, so a run that lost the
 * row (its lock ran out and another run claimed) writes nothing and sends no email or push.
 */
const OWNER_TAG = sql`(extract(epoch from updated_at) * 1000000)::bigint::text`;

/** Hold a claimed payout: not counted as a try, rechecked in an hour. Admin emailed once per hold. */
async function hold(p: any, e: any, reason: string, tag: string): Promise<SendResult> {
  const [h] = await rows<any>(sql`
    UPDATE event_payouts SET status = 'held', hold_reason = ${reason}, attempts = GREATEST(0, attempts - 1),
           next_attempt_at = now() + interval '1 hour', alerted_at = now(), updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      AND (status <> 'held' OR alerted_at IS NULL OR hold_reason IS DISTINCT FROM ${reason})
    RETURNING id`);
  if (!h) {
    // Same hold as before (already emailed): only push the next check out and give the try back.
    const [same] = await rows<any>(sql`
      UPDATE event_payouts SET attempts = GREATEST(0, attempts - 1), next_attempt_at = now() + interval '1 hour', updated_at = now()
      WHERE id = ${p.id} AND status = 'held' AND ${OWNER_TAG} = ${tag}
      RETURNING id`);
    return same ? "held" : "not_due"; // not ours any more: another run has it
  }
  await alertAdmin("Event payout on hold",
    `Event payout ${p.id} of ${p.amount_cents} cents for "${e?.title ?? "?"}" (event ${p.event_id}) is on hold: ${HOLD_TEXT[reason] ?? reason}. It is checked again every hour and sent once this is fixed.`);
  return "held";
}

async function toReview(p: any, e: any, why: string, tag: string): Promise<SendResult> {
  const [r] = await rows<any>(sql`
    UPDATE event_payouts SET status = 'review', last_error = ${why.slice(0, 300)}, next_attempt_at = NULL, updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
    RETURNING id`);
  if (!r) return "not_due"; // not ours any more: another run has it (and may be sending it right now)
  await alertAdmin("Event payout needs a look",
    `Event payout ${p.id} of ${p.amount_cents} cents for "${e?.title ?? "?"}" (event ${p.event_id}): ${why}. Check Stripe, then set it back to pending with attempts 0 to retry.`);
  return "review";
}

/** Sends one payout. Safe to run any number of times, at the same time too. */
export async function sendPayout(payoutId: string, s?: PayoutStripe): Promise<SendResult> {
  const [p] = await rows<any>(sql`
    UPDATE event_payouts SET attempts = attempts + 1,
           -- In-flight lock. Re-taken right before the lookup + create (see below), so it only has to outlast those two
           -- bounded calls: 30 s timeout and 1 network retry each, so about 1 minute per call, or about 2 minutes
           -- with a Retry-After wait of up to 60 s; about 4 minutes for both in the worst case, still well inside
           -- 10 minutes. No other run can claim the row while a transfer may still land. The attempt's end sets
           -- the real next time.
           next_attempt_at = now() + make_interval(mins => ${PAYOUT_LOCK_MINUTES}::int), updated_at = now()
    WHERE id = ${payoutId} AND status IN ('pending', 'held') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    RETURNING id, event_id, status, amount_cents, attempts, ${OWNER_TAG} AS claim_tag`);
  if (!p) return "not_due";
  // This run's ownership tag: the claim's, then whatever each of its own writes returns.
  let tag = String(p.claim_tag);
  if (afterClaimHook) await afterClaimHook(p.id);
  const amount = Number(p.amount_cents);
  const [e] = await rows<any>(sql`
    SELECT id, title, status, host_type, host_user_id, host_business_id, host_photographer_id FROM events WHERE id = ${p.event_id}`);
  if (!e || e.status === "cancelled") return toReview(p, e, "the event was cancelled after its payout was created, so it was not sent", tag);
  if (e.status !== "published") return hold(p, e, "event_paused", tag);

  const st = s ?? (await realStripe());
  const dest = await hostPayoutDestination(e as HostEventRef);
  const ready = await isHostReady(e as HostEventRef, st, STRIPE_CALL_BOUND);
  if (!ready.ready || !dest.accountId) return hold(p, e, ready.reason ?? "no_account", tag);

  // Re-take the lock, only if this claim still owns the row: the checks above may have been slow enough for the
  // lock to run out and another run to claim (its claim changes updated_at). Ready again from a hold -> pending,
  // and a new problem gets its own email.
  const [mine] = await rows<any>(sql`
    UPDATE event_payouts SET next_attempt_at = now() + make_interval(mins => ${PAYOUT_LOCK_MINUTES}::int),
           status = 'pending', hold_reason = NULL,
           alerted_at = CASE WHEN status = 'held' THEN NULL ELSE alerted_at END, updated_at = now()
    WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
    RETURNING ${OWNER_TAG} AS tag`);
  if (!mine) return "not_due";
  tag = String(mine.tag);

  try {
    const existing = await st.findEventPayoutTransfer(e.id, p.id, STRIPE_CALL_BOUND);
    let transferId: string;
    if (existing) {
      // Sent before but not saved: record it, never send again.
      if (existing.amount !== amount) {
        return toReview(p, e, `Stripe already has transfer ${existing.id} of ${existing.amount} cents for this payout, but the payout is ${amount} cents`, tag);
      }
      transferId = existing.id;
    } else {
      // One key per claim (the claim's own timestamp in microseconds, so it only grows): Stripe replays a saved
      // response for 24 hours, errors included, so a fixed key would repeat an insufficient-balance or 500 reply
      // on every retry. No double payment: claims never overlap (the lock is re-taken by its owner just before
      // the bounded lookup + create, and outlasts both), and the group lookup runs before every create, so a
      // transfer an earlier try sent is recorded.
      transferId = (await st.createEventPayoutTransfer({
        eventId: e.id, payoutId: p.id, destination: dest.accountId, amountCents: amount,
        idempotencyKey: `event_payout_${p.id}_${p.claim_tag}`, ...STRIPE_CALL_BOUND,
      })).id;
    }
    // Recorded while this run still owns the row, or while nobody does (the lock ran out and no other run has
    // claimed since). The transfer is real either way. If another run has the row now, nothing is written here and
    // no push goes out: that run's lookup before its create finds this transfer and records it.
    const [done] = await rows<any>(sql`
      UPDATE event_payouts SET status = 'paid', transfer_id = ${transferId}, paid_at = now(),
             destination_type = ${dest.destinationType}, connected_account_id = ${dest.accountId},
             hold_reason = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held')
        AND (${OWNER_TAG} = ${tag} OR next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING id`);
    if (!done) return "not_due";
    void notifyPayoutSent(p.id);
    return "paid";
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    if (await isInsufficientFunds(err)) {
      // Not the host's problem and not a failed try: wait for the balance, email at most once a day.
      const [w] = await rows<any>(sql`
        UPDATE event_payouts SET status = 'pending', attempts = GREATEST(0, attempts - 1),
               next_attempt_at = now() + interval '1 hour', last_error = ${msg},
               alerted_at = CASE WHEN alerted_at IS NULL OR alerted_at < now() - interval '24 hours' THEN now() ELSE alerted_at END,
               updated_at = now()
        WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
        RETURNING (alerted_at = now()) AS emailed`);
      if (!w) return "not_due"; // not ours any more
      if (w.emailed) {
        const [owed] = await rows<any>(sql`SELECT COALESCE(sum(amount_cents), 0)::int AS c, count(*)::int AS n FROM event_payouts WHERE status IN ('pending', 'held')`);
        await alertAdmin("Event payout waiting for balance",
          `Event payout ${p.id} of ${amount} cents for "${e.title}" (event ${e.id}) can't be sent: not enough available balance on Stripe. ` +
          `Event payouts waiting: ${owed?.n ?? "?"} for ${owed?.c ?? "?"} cents. Available balance: ${await balanceText(s)}. It is tried again every hour.`);
      }
      console.warn(`[Events] payout ${p.id} waiting for balance: ${msg}`);
      return "insufficient";
    }
    console.error(`[Events] payout try ${p.attempts} failed for ${p.id}: ${msg}`);
    const [still] = await rows<any>(sql`
      UPDATE event_payouts SET last_error = ${msg},
             -- Backoff 10, 20, 40, then 60 minutes: never shorter than the in-flight lock.
             next_attempt_at = now() + make_interval(mins => LEAST(60, ${PAYOUT_LOCK_MINUTES}::int * power(2, LEAST(attempts - 1, 6)))::int),
             updated_at = now()
      WHERE id = ${p.id} AND status IN ('pending', 'held') AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`).catch(() => [] as any[]);
    if (!still) return "not_due"; // not ours any more, or finished by someone else meanwhile
    tag = String(still.tag);
    if (Number(p.attempts) >= PAYOUT_MAX_ATTEMPTS) return toReview(p, e, `the transfer failed ${p.attempts} times, last error: ${msg}`, tag);
    return "retry";
  }
}

// ─── Step 3: refunds after a payout (recoveries) ────────────────────────────

/**
 * Opens a recovery for each refunded ticket whose payout was already sent (one INSERT ... SELECT). Tickets refunded
 * before their payout was created were never stamped, so they never get one; tickets refunded while their payout
 * is still unpaid get one once it is paid (the payout pays the stamped amount, then this takes it back).
 * A ticket with no host share (free) is skipped. Returns how many were opened.
 */
export async function openRecoveries(limit = 50): Promise<number> {
  // Step 4b-1: a $0 host payout (Outsyde and the team took everything) is paid with no transfer, so there is nothing
  // to reverse: its refunds are owed by the host straight away and come back from their next event payout.
  const made = await rows<any>(sql`
    -- A $0 payout for a host who had no payout account yet has no account on record: the debt is tied to the account
    -- the host has now (same rule as the payout destination), so it comes out of their next payout. No account yet:
    -- it waits, and is opened on the first run after they set up payouts.
    INSERT INTO event_payout_recoveries (ticket_id, payout_id, connected_account_id, amount_cents, status, last_error)
    SELECT t.id, p.id, COALESCE(p.connected_account_id, cur.acct), t.host_net_cents,
           CASE WHEN p.transfer_id IS NULL THEN 'owed' ELSE 'pending' END,
           CASE WHEN p.transfer_id IS NULL THEN 'the payout was $0, so there is no transfer to take it back from' END
    FROM tickets t JOIN event_payouts p ON p.id = t.payout_id
    JOIN events e ON e.id = p.event_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN e.host_type = 'business' AND e.host_business_id IS NOT NULL THEN (SELECT b.stripe_account_id FROM businesses b WHERE b.id = e.host_business_id)
                  WHEN e.host_type = 'photographer' AND e.host_photographer_id IS NOT NULL THEN (SELECT ph.stripe_account_id FROM photographers ph WHERE ph.id = e.host_photographer_id)
                  ELSE (SELECT u.stripe_account_id FROM user_payout_accounts u WHERE u.user_id = e.host_user_id) END AS acct
    ) cur ON true
    WHERE t.status = 'refunded' AND p.status = 'paid'
      AND ((p.transfer_id IS NOT NULL AND p.connected_account_id IS NOT NULL)
        OR (p.transfer_id IS NULL AND p.amount_cents = 0 AND COALESCE(p.connected_account_id, cur.acct) IS NOT NULL))
      AND t.host_net_cents > 0
      AND NOT EXISTS (SELECT 1 FROM event_payout_recoveries r WHERE r.ticket_id = t.id)
    ORDER BY t.refunded_at NULLS LAST, t.id
    LIMIT ${limit}
    ON CONFLICT (ticket_id) DO NOTHING
    RETURNING id`);
  return made.length;
}

/**
 * Owed: the host's Stripe balance can't cover it, or it kept failing. Taken from their next event payout.
 * alerted_at is cleared: a stuck-pending email may have set it, and the 30 day owed email must still go out.
 */
async function owe(r: any, why: string, tag: string): Promise<RecoveryResult> {
  const [o] = await rows<any>(sql`
    UPDATE event_payout_recoveries SET status = 'owed', last_error = ${why.slice(0, 300)}, next_attempt_at = NULL, alerted_at = NULL, updated_at = now()
    WHERE id = ${r.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
    RETURNING id`);
  if (!o) return "not_due"; // not ours any more
  console.warn(`[Events] recovery ${r.id} of ${r.amount_cents} cents for ticket ${r.ticket_id} is owed: ${why}`);
  return "owed";
}

/** Reverses one recovery from the host's payout transfer. Safe to run any number of times, at the same time too. */
export async function processRecovery(recoveryId: string, s?: RecoveryStripe): Promise<RecoveryResult> {
  // Claim + in-flight lock, exactly like sendPayout: no other run can claim while a reversal may still land.
  const [r] = await rows<any>(sql`
    UPDATE event_payout_recoveries SET attempts = attempts + 1,
           next_attempt_at = now() + make_interval(mins => ${PAYOUT_LOCK_MINUTES}::int), updated_at = now()
    WHERE id = ${recoveryId} AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    RETURNING id, ticket_id, payout_id, amount_cents, attempts, last_error, ${OWNER_TAG} AS claim_tag`);
  if (!r) return "not_due";
  let tag = String(r.claim_tag);
  // Past the last try: this claim only looks on the transfer and never sends a reversal. The try that failed last
  // ended at least one lock period ago (its backoff is longer than the lock), so a reversal it timed out on has
  // landed by now if it ever will.
  const lookupOnly = Number(r.attempts) > RECOVERY_MAX_ATTEMPTS;
  if (afterRecoveryClaimHook) await afterRecoveryClaimHook(r.id);
  const [p] = await rows<any>(sql`SELECT transfer_id FROM event_payouts WHERE id = ${r.payout_id}`);
  // Opened only for paid payouts, so this can't happen; owed (not lost) if it ever does.
  if (!p?.transfer_id) return owe(r, "its payout has no transfer to reverse", tag);
  const st = s ?? (await realStripe());

  /** Re-take the lock, only while this claim still owns the row (a run whose lock ran out stops here). */
  const retake = async (): Promise<boolean> => {
    const [mine] = await rows<any>(sql`
      UPDATE event_payout_recoveries SET next_attempt_at = now() + make_interval(mins => ${PAYOUT_LOCK_MINUTES}::int), updated_at = now()
      WHERE id = ${r.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`);
    if (!mine) return false;
    tag = String(mine.tag);
    return true;
  };
  if (!(await retake())) return "not_due";

  try {
    const existing = await st.findEventPayoutReversal(p.transfer_id, r.ticket_id, STRIPE_CALL_BOUND);
    let reversalId: string;
    if (existing) {
      // Made before but not saved (lost response, or a timed-out call that landed later): record it, never reverse again.
      reversalId = existing.id;
    } else if (lookupOnly) {
      // Every try failed and no reversal ever landed: owed, taken from the host's next event payout.
      return owe(r, `the reversal failed ${RECOVERY_MAX_ATTEMPTS} times and none is on the transfer, last error: ${r.last_error ?? "none"}`, tag);
    } else {
      // Still ours right before the create (the lookup may have been slow): otherwise send nothing.
      if (!(await retake())) return "not_due";
      // One key per claim: Stripe replays a saved response for 24 hours, errors included.
      reversalId = (await st.reverseEventPayoutTransfer({
        transferId: p.transfer_id, ticketId: r.ticket_id, amountCents: Number(r.amount_cents),
        idempotencyKey: `event_recovery_${r.ticket_id}_${r.claim_tag}`, ...STRIPE_CALL_BOUND,
      })).id;
    }
    // Recorded while this run owns the row, or while nobody does (same rule as a paid payout).
    const [done] = await rows<any>(sql`
      UPDATE event_payout_recoveries SET status = 'reversed', reversal_id = ${reversalId}, next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${r.id} AND status = 'pending'
        AND (${OWNER_TAG} = ${tag} OR next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING id`);
    return done ? "reversed" : "not_due";
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    // Not enough on the host's Stripe balance: owed now, taken from their next event payout (after one more look
    // on the transfer: owed feeds an automatic deduction, so it must never be set while a reversal exists).
    // Owing in this same claim is safe here, unlike after any other error: this claim made exactly one reversal
    // request (one key; the SDK's own retry reuses it, and Stripe answers a retry of a request still running with
    // an idempotency error, never balance_insufficient), and Stripe answered that request with a definite no. Every
    // earlier claim's call ended at least one lock period ago, and the look below finds any of those that landed.
    if (await isInsufficientFunds(err)) return oweUnlessReversed(msg);
    console.error(`[Events] recovery try ${r.attempts} failed for ${r.id}: ${msg}`);
    const [still] = await rows<any>(sql`
      UPDATE event_payout_recoveries SET last_error = ${msg},
             next_attempt_at = now() + make_interval(mins => LEAST(60, ${PAYOUT_LOCK_MINUTES}::int * power(2, LEAST(attempts - 1, 6)))::int),
             updated_at = now()
      WHERE id = ${r.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`).catch(() => [] as any[]);
    if (!still) return "not_due";
    tag = String(still.tag);
    // An unrecognised error (a different Stripe code for a low host balance included) ends here too, and so does a
    // failed lookup on a lookup-only claim. Never owed in this claim: a timed-out reversal may still land at Stripe,
    // and a lookup now could miss it (then owed + reversed = the host charged twice). Backoff (60 minutes from the
    // 5th try on, always at least the lock), and the next claim past the 5th looks only.
    return "retry";
  }

  /**
   * Owed after insufficient funds: an earlier try may have reversed with its reply lost, or reversed and then
   * failed to save. One bounded lookup on the transfer, under this claim's ownership:
   * found -> 'reversed' with that id; lookup fails -> stays pending with backoff (never owed blind); none -> 'owed'.
   */
  async function oweUnlessReversed(why: string): Promise<RecoveryResult> {
    let found: { id: string; amount: number } | null;
    try {
      found = await st.findEventPayoutReversal(p.transfer_id, r.ticket_id, STRIPE_CALL_BOUND);
    } catch (lookErr) {
      const lm = String((lookErr as Error)?.message ?? lookErr);
      console.error(`[Events] recovery ${r.id}: lookup before owing failed, stays pending: ${lm}`);
      const [b] = await rows<any>(sql`
        UPDATE event_payout_recoveries SET last_error = ${`${why}; reversal lookup before owing failed: ${lm}`.slice(0, 300)},
               next_attempt_at = now() + make_interval(mins => LEAST(60, ${PAYOUT_LOCK_MINUTES}::int * power(2, LEAST(attempts - 1, 6)))::int),
               updated_at = now()
        WHERE id = ${r.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
        RETURNING id`).catch(() => [] as any[]);
      return b ? "retry" : "not_due";
    }
    if (found) {
      const [done] = await rows<any>(sql`
        UPDATE event_payout_recoveries SET status = 'reversed', reversal_id = ${found.id}, next_attempt_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = ${r.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
        RETURNING id`);
      return done ? "reversed" : "not_due";
    }
    return owe(r, why, tag);
  }
}

/** Owed 30 days after the refund and not yet reported: one admin email listing them (each reported once). */
export async function alertOldOwed(): Promise<number> {
  const old = await rows<any>(sql`
    UPDATE event_payout_recoveries SET alerted_at = now(), updated_at = now()
    WHERE id IN (
      SELECT id FROM event_payout_recoveries
      WHERE status = 'owed' AND alerted_at IS NULL AND created_at <= now() - make_interval(days => ${OWED_ALERT_DAYS}::int)
      ORDER BY created_at LIMIT 100)
      AND status = 'owed' AND alerted_at IS NULL
    RETURNING id, ticket_id, payout_id, connected_account_id, amount_cents`);
  if (!old.length) return 0;
  const titles = await rows<any>(sql`
    SELECT p.id, e.title, e.id AS event_id FROM event_payouts p JOIN events e ON e.id = p.event_id
    WHERE p.id IN (SELECT unnest(string_to_array(${old.map((o) => o.payout_id).join(",")}, ',')))`);
  const byPayout = new Map(titles.map((t) => [String(t.id), t]));
  const total = old.reduce((n, o) => n + Number(o.amount_cents), 0);
  const lines = old.map((o) => {
    const t = byPayout.get(String(o.payout_id));
    return `Recovery ${o.id}: ${o.amount_cents} cents for ticket ${o.ticket_id} of "${t?.title ?? "?"}" (event ${t?.event_id ?? "?"}, payout ${o.payout_id}), Stripe account ${o.connected_account_id}.`;
  });
  await alertAdmin("Event payout refunds still owed",
    `${old.length} refunds made after an event payout are still owed by the host after ${OWED_ALERT_DAYS} days, ${total} cents in all. ` +
    `They come back from the host's next event payout; with no next event, collect them or write them off by hand. ${lines.join(" ")}`);
  return old.length;
}

/** Hosts who owe Outsyde from earlier events get a reminder this often until it's paid back, collected or written off. */
export const OWED_REMIND_DAYS = 7;
/** Shared New York day budget of email_log rows (same ceiling as door invites and the day-of address email). */
export const OWED_REMIND_EMAIL_CEILING = 70;

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Push and email copy for the owed reminder (Legend 2026-10-30, call 18). No dashes. */
export function owedReminderCopy(totalCents: number): { title: string; body: string } {
  return {
    title: "Payment owed to Outsyde",
    body: `You owe Outsyde ${usd(totalCents)} from an earlier event. It will come out of your next event payout. To pay it sooner, contact support.`,
  };
}

/**
 * Step 4b-1 (Legend 2026-10-30, call 18): every 7 days, each host with an owed recovery gets one push and one email
 * with the total. One statement claims the hosts (host_reminded_at on every owed row of theirs), so two runs can't
 * both remind. updated_at is left alone on purpose: it is the recovery's ownership tag. Never throws per host.
 */
export async function remindOwedHosts(limit = 100): Promise<number> {
  const due = await rows<any>(sql`
    WITH owed AS (
      -- Last time this host was told about this debt: the weekly reminder, else the one-time owed notice
      -- (bookingRecoveries notifyOwedSellers, seller_notified_at), else when it was opened. Day one is that notice.
      SELECT r.id, e.host_user_id, r.amount_cents, COALESCE(r.host_reminded_at, r.seller_notified_at, r.created_at) AS last_told
      FROM event_payout_recoveries r JOIN event_payouts p ON p.id = r.payout_id JOIN events e ON e.id = p.event_id
      WHERE r.status = 'owed'
    ),
    hosts AS (
      SELECT host_user_id FROM owed GROUP BY host_user_id
      HAVING max(last_told) <= now() - make_interval(days => ${OWED_REMIND_DAYS}::int)
      ORDER BY host_user_id LIMIT ${limit}
    ),
    claimed AS (
      UPDATE event_payout_recoveries r SET host_reminded_at = now()
      FROM owed JOIN hosts ON hosts.host_user_id = owed.host_user_id
      WHERE r.id = owed.id AND r.status = 'owed'
        -- Re-checked under the row lock: a run that claimed this host a moment ago wins, this one sends nothing.
        AND COALESCE(r.host_reminded_at, r.seller_notified_at, r.created_at) <= now() - make_interval(days => ${OWED_REMIND_DAYS}::int)
      RETURNING owed.host_user_id, r.amount_cents
    )
    SELECT c.host_user_id, sum(c.amount_cents)::int AS total, u.email, u.first_name
    FROM claimed c JOIN users u ON u.id = c.host_user_id
    GROUP BY c.host_user_id, u.email, u.first_name`);
  if (!due.length) return 0;
  const { noticeDeps } = await import("./ticketNotices");
  const { startOfNewYorkDay } = await import("../emailHistory");
  const d = await noticeDeps();
  let sent = 0;
  for (const h of due) {
    const copy = owedReminderCopy(Number(h.total));
    try {
      await d.sendPush({ userId: h.host_user_id, title: copy.title, body: copy.body, data: { type: "event_payout_owed", amountCents: Number(h.total) } });
    } catch (err) {
      console.error(`[Events] owed reminder push failed for host ${h.host_user_id}:`, (err as Error)?.message ?? err);
    }
    try {
      const nyDayStart = startOfNewYorkDay(new Date()).toISOString();
      const [c] = await rows<any>(sql`SELECT count(*)::int AS n FROM email_log WHERE created_at >= ${nyDayStart}::timestamptz AND created_at < ${nyDayStart}::timestamptz + interval '1 day'`);
      if (h.email && d.sendOwedReminder && Number(c?.n ?? 0) < OWED_REMIND_EMAIL_CEILING) {
        await d.sendOwedReminder({ userId: h.host_user_id, toEmail: h.email, firstName: h.first_name ?? null, amountCents: Number(h.total) });
      }
    } catch (err) {
      console.error(`[Events] owed reminder email failed for host ${h.host_user_id}:`, (err as Error)?.message ?? err);
    }
    sent++;
  }
  return sent;
}

/**
 * Pending at max tries and opened over 24 hours ago (so its lookups have kept failing for about a day): one admin
 * email listing them, each once (alerted_at). updated_at is left alone on purpose: it is the ownership tag, and a run
 * holding the row must not lose it to this email. owe() clears alerted_at, so the 30 day owed email still fires.
 */
export async function alertStuckRecoveries(): Promise<number> {
  const stuck = await rows<any>(sql`
    UPDATE event_payout_recoveries SET alerted_at = now()
    WHERE id IN (
      SELECT id FROM event_payout_recoveries
      WHERE status = 'pending' AND attempts >= ${RECOVERY_MAX_ATTEMPTS} AND alerted_at IS NULL
        AND created_at <= now() - make_interval(hours => ${STUCK_RECOVERY_ALERT_HOURS}::int)
      ORDER BY created_at LIMIT 100)
      AND status = 'pending' AND alerted_at IS NULL
    RETURNING id, ticket_id, payout_id, connected_account_id, amount_cents, attempts, last_error`);
  if (!stuck.length) return 0;
  const lines = stuck.map((o) =>
    `Recovery ${o.id}: ${o.amount_cents} cents for ticket ${o.ticket_id} (payout ${o.payout_id}, Stripe account ${o.connected_account_id}), ${o.attempts} tries, last error: ${String(o.last_error ?? "none").slice(0, 200)}.`);
  await alertAdmin("Event payout refunds stuck",
    `${stuck.length} refunds made after an event payout could not be taken back from the host for over ${STUCK_RECOVERY_ALERT_HOURS} hours. ` +
    `Stripe can't be checked for an existing reversal, so they are not marked owed yet and are tried again every hour. Check Stripe. ${lines.join(" ")}`);
  return stuck.length;
}

/**
 * Every minute: create due payouts, send up to 20 that are due (least recently tried first), then open recoveries,
 * reverse up to 20 due ones and report old owed and stuck ones. Each step has its own try/catch, so one can't starve the others.
 */
export async function runEventPayoutJob(s?: PayoutStripe & RecoveryStripe & Partial<import("./teamSend").TeamStripe>): Promise<{
  created: number; paid: number; held: number; review: number; opened: number; reversed: number; owed: number; alerted: number; stuck: number; reminded: number;
  teamTold: number; teamSent: number; teamHeld: number; teamReview: number; setupReminded: number; teamFlagged: number;
}> {
  const out = { created: 0, paid: 0, held: 0, review: 0, opened: 0, reversed: 0, owed: 0, alerted: 0, stuck: 0, reminded: 0,
    teamTold: 0, teamSent: 0, teamHeld: 0, teamReview: 0, setupReminded: 0, teamFlagged: 0 };
  try {
    const ids = await createDuePayouts();
    out.created = ids ? ids.split(",").length : 0;
  } catch (err) {
    console.error("[Events] payout create step failed:", (err as Error)?.message ?? err);
  }
  try {
    const due = await rows<any>(sql`
      SELECT id FROM event_payouts
      WHERE status IN ('pending', 'held') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY updated_at
      LIMIT ${PAYOUT_JOB_LIMIT}`);
    for (const d of due) {
      try {
        const r = await sendPayout(d.id, s);
        if (r === "paid") out.paid++;
        else if (r === "held") out.held++;
        else if (r === "review") out.review++;
      } catch (err) {
        console.error(`[Events] payout ${d.id} failed:`, (err as Error)?.message ?? err);
      }
    }
  } catch (err) {
    console.error("[Events] payout send step failed:", (err as Error)?.message ?? err);
  }
  try {
    out.opened = await openRecoveries();
  } catch (err) {
    console.error("[Events] recovery open step failed:", (err as Error)?.message ?? err);
  }
  try {
    const due = await rows<any>(sql`
      SELECT id FROM event_payout_recoveries
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY updated_at
      LIMIT ${RECOVERY_JOB_LIMIT}`);
    for (const d of due) {
      try {
        const r = await processRecovery(d.id, s);
        if (r === "reversed") out.reversed++;
        else if (r === "owed") out.owed++;
      } catch (err) {
        console.error(`[Events] recovery ${d.id} failed:`, (err as Error)?.message ?? err);
      }
    }
  } catch (err) {
    console.error("[Events] recovery step failed:", (err as Error)?.message ?? err);
  }
  try {
    out.alerted = await alertOldOwed();
  } catch (err) {
    console.error("[Events] owed alert step failed:", (err as Error)?.message ?? err);
  }
  try {
    out.stuck = await alertStuckRecoveries();
  } catch (err) {
    console.error("[Events] stuck recovery alert step failed:", (err as Error)?.message ?? err);
  }
  try {
    out.reminded = await remindOwedHosts();
  } catch (err) {
    console.error("[Events] owed reminder step failed:", (err as Error)?.message ?? err);
  }
  // Step 4b-2: team pay. Each step on its own, like the ones above.
  const team = await import("./teamSend");
  try {
    out.teamTold = await team.notifyNoSetupMembers();
  } catch (err) {
    console.error("[Events] team no setup notice step failed:", (err as Error)?.message ?? err);
  }
  try {
    const t = await team.runTeamPayoutSends(s && typeof (s as any).createEventTeamPayoutTransfer === "function" ? (s as any) : undefined);
    out.teamSent = t.sent; out.teamHeld = t.held; out.teamReview = t.review;
  } catch (err) {
    console.error("[Events] team pay send step failed:", (err as Error)?.message ?? err);
  }
  try {
    out.setupReminded = await team.remindTeamSetup();
  } catch (err) {
    console.error("[Events] team setup reminder step failed:", (err as Error)?.message ?? err);
  }
  try {
    out.teamFlagged = await team.flagNotReceived();
  } catch (err) {
    console.error("[Events] team not received flag step failed:", (err as Error)?.message ?? err);
  }
  if (Object.values(out).some((n) => n > 0)) {
    console.log(`[Events] payout job: created ${out.created}, paid ${out.paid}, held ${out.held}, review ${out.review}, ` +
      `recoveries opened ${out.opened}, reversed ${out.reversed}, owed ${out.owed}, owed alerts ${out.alerted}, stuck alerts ${out.stuck}, owed reminders ${out.reminded}, ` +
      `team: told ${out.teamTold}, sent ${out.teamSent}, held ${out.teamHeld}, review ${out.teamReview}, setup reminders ${out.setupReminded}, flagged ${out.teamFlagged}`);
  }
  return out;
}
