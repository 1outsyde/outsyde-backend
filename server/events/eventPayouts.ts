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
 * after it was stamped is paid out, then recovered (Task 7, event_payout_recoveries).
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

export const PAYOUT_MAX_ATTEMPTS = 5;
export const PAYOUT_JOB_LIMIT = 20;
/** A claim keeps the row for this long, so a transfer still in flight is never sent again under a new key. */
export const PAYOUT_LOCK_MINUTES = 10;
/** Every Stripe call in a payout attempt is bounded, so the attempt ends well inside the lock. */
const STRIPE_CALL_BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };

/** Test seam only: lets a test hold a run right after its claim (a slow DB read in real life). Never set in production. */
let afterClaimHook: ((payoutId: string) => Promise<void>) | null = null;
export function setPayoutHooksForTest(h: { afterClaim?: (payoutId: string) => Promise<void> } | null): void {
  afterClaimHook = h?.afterClaim ?? null;
}

async function realStripe(): Promise<PayoutStripe> {
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

/** Creates payouts for up to `limit` due events. Returns the new payout ids as a comma list ("" when none). */
export async function createDuePayouts(limit = PAYOUT_JOB_LIMIT): Promise<string> {
  // Candidates only: the statement below checks every rule again. Events with nothing to pay (free, or every
  // ticket refunded) are skipped here, so they never crowd out paid ones.
  const due = await rows<any>(sql`
    SELECT e.id, e.host_type, e.host_user_id, e.host_business_id, e.host_photographer_id
    FROM events e
    WHERE e.status = 'published' AND e.ends_at + interval '3 days' <= now()
      AND NOT EXISTS (SELECT 1 FROM event_payouts p WHERE p.event_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM ticket_orders o WHERE o.event_id = e.id AND o.status IN ('pending', 'refunding') AND o.needs_review_at IS NULL)
      AND EXISTS (SELECT 1 FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
                  WHERE t.event_id = e.id AND t.status = 'valid' AND o.status = 'completed' AND t.payout_id IS NULL AND t.host_net_cents > 0)
    ORDER BY e.ends_at
    LIMIT ${limit}`);
  const made: string[] = [];
  for (const e of due) {
    try {
      const dest = await hostPayoutDestination(e as HostEventRef);
      const [r] = await withDeadlockRetry(() => rows<any>(sql`
        WITH ev AS (
          SELECT e.id FROM events e
          WHERE e.id = ${e.id} AND e.status = 'published' AND e.ends_at + interval '3 days' <= now()
            AND NOT EXISTS (SELECT 1 FROM event_payouts p WHERE p.event_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM ticket_orders o WHERE o.event_id = e.id AND o.status IN ('pending', 'refunding') AND o.needs_review_at IS NULL)
        ),
        tk AS (
          -- Locked: a refund running right now either finishes first (its tickets are then 'refunded' and
          -- left out here) or waits for this statement (its tickets are stamped, then recovered in Task 7).
          SELECT t.id, t.host_net_cents FROM tickets t JOIN ticket_orders o ON o.id = t.order_id
          WHERE t.event_id IN (SELECT id FROM ev) AND t.status = 'valid' AND o.status = 'completed' AND t.payout_id IS NULL
          FOR UPDATE OF t
        ),
        g AS (SELECT COALESCE(sum(host_net_cents), 0)::int AS gross FROM tk),
        -- Task 7 adds the owed recoveries deduction HERE: a CTE that takes event_payout_recoveries with status 'owed'
        -- for this destination account, dest.accountId (capped so amount_cents stays > 0, the rest stays owed), marks them 'recovered'
        -- with recovered_from_payout_id, and sets deducted_cents. Until then deducted_cents = 0 and amount = gross.
        ins AS (
          INSERT INTO event_payouts (event_id, destination_type, connected_account_id, gross_cents, deducted_cents, amount_cents, status)
          SELECT ev.id, ${dest.destinationType}, ${dest.accountId}, g.gross, 0, g.gross, 'pending'
          FROM ev, g WHERE g.gross > 0
          ON CONFLICT (event_id) DO NOTHING
          RETURNING id
        ),
        st AS (
          UPDATE tickets t SET payout_id = ins.id
          FROM ins, tk
          WHERE t.id = tk.id AND t.payout_id IS NULL AND t.status = 'valid'
          RETURNING t.id, t.host_net_cents
        )
        SELECT (SELECT id FROM ins) AS payout_id,
               CASE WHEN EXISTS (SELECT 1 FROM ins) AND (
                      (SELECT count(*) FROM st) <> (SELECT count(*) FROM tk)
                   OR (SELECT COALESCE(sum(host_net_cents), 0) FROM st) <> (SELECT gross FROM g))
                 THEN ('GUARD_PAYOUT_STAMP:' || (SELECT count(*) FROM st))::int END AS guard_stamp`));
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

/** Every minute: create due payouts, then send up to 20 that are due, least recently tried first. */
export async function runEventPayoutJob(s?: PayoutStripe): Promise<{ created: number; paid: number; held: number; review: number }> {
  const out = { created: 0, paid: 0, held: 0, review: 0 };
  try {
    const ids = await createDuePayouts();
    out.created = ids ? ids.split(",").length : 0;
  } catch (err) {
    console.error("[Events] payout create step failed:", (err as Error)?.message ?? err);
  }
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
  if (out.created || out.paid || out.held || out.review) {
    console.log(`[Events] payout job: created ${out.created}, paid ${out.paid}, held ${out.held}, review ${out.review}`);
  }
  return out;
}
