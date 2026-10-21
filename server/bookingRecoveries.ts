/**
 * Booking refund recovery (P1 #5): after a booking refund, the seller's share is later taken back from their
 * Stripe transfer. This file records each Stripe refund (the hook in stripeService.createBookingRefund calls
 * recordBookingRefund); later code works out and takes back the share.
 */
import { sql } from "drizzle-orm";
import { rows } from "./events/eventsRouter";
import { calculateBookingFees } from "./fees";

/** 2026-10-21 00:00 UTC. Refunds Stripe created before this are never recorded. */
export const RECOVERY_START_UNIX = 1792540800;

/** Record one Stripe refund as a pending recovery. Same refund twice is a no-op; older refunds are skipped. */
export async function recordBookingRefund(p: { refundId: string; paymentIntentId: string; refundCents: number; createdUnix: number }): Promise<void> {
  if (p.createdUnix < RECOVERY_START_UNIX) return;
  await rows(sql`
    INSERT INTO booking_refund_recoveries (refund_id, payment_intent_id, refund_cents, refund_created_at, status, next_attempt_at)
    VALUES (${p.refundId}, ${p.paymentIntentId}, ${p.refundCents}, to_timestamp(${p.createdUnix}), 'pending', now())
    ON CONFLICT (refund_id) DO NOTHING`);
}

export type ResolvedBooking = {
  type: "appointment" | "shoot_booking";
  id: string;
  base: number;
  intendedPayout: number;
  recipient: "business" | "staff" | "photographer";
};

/**
 * The booking behind a PaymentIntent, or null when it is on neither appointments nor shoot_bookings (ticket
 * refunds also reach createBookingRefund; those rows are closed as not_booking and never reversed).
 * base is what the payout was figured on: the deposit when there is one, else the total price.
 */
export async function resolveBooking(paymentIntentId: string): Promise<ResolvedBooking | null> {
  const [r] = await rows<any>(sql`
    SELECT 'appointment' AS type, id, total_price, deposit_amount_cents, vendor_net, staff_member_id
    FROM appointments WHERE stripe_payment_intent_id = ${paymentIntentId}
    UNION ALL
    SELECT 'shoot_booking' AS type, id, total_price, deposit_amount_cents, vendor_net, NULL AS staff_member_id
    FROM shoot_bookings WHERE stripe_payment_intent_id = ${paymentIntentId}
    ORDER BY type LIMIT 1`);
  if (!r) return null;
  const base = Number(r.deposit_amount_cents ?? r.total_price);
  if (r.type === "shoot_booking") {
    return { type: "shoot_booking", id: r.id, base, intendedPayout: Number(r.vendor_net ?? 0), recipient: "photographer" };
  }
  return {
    type: "appointment", id: r.id, base,
    intendedPayout: calculateBookingFees(base).vendorNetCents,
    recipient: r.staff_member_id ? "staff" : "business",
  };
}

/**
 * The seller's share of one refund, in cents. intendedPayout x min(1, refund / min(base, amountReceived)),
 * rounded, then capped at what the seller still holds (sentNet minus alreadyTaken). Never negative.
 */
export function computeShare(input: { intendedPayout: number; base: number; amountReceived: number; refundCents: number; sentNet: number; alreadyTaken: number }): number {
  const { intendedPayout, base, amountReceived, refundCents, sentNet, alreadyTaken } = input;
  if (!(refundCents > 0) || !(intendedPayout > 0)) return 0;
  const denom = Math.min(base, amountReceived);
  const ratio = denom > 0 ? Math.min(1, refundCents / denom) : 1;
  const share = Math.round(intendedPayout * ratio);
  const left = Math.max(0, sentNet - alreadyTaken);
  return Math.max(0, Math.min(share, left));
}

type StripeServiceT = typeof import("./stripe/stripeService").stripeService;
export type RecoveryBackfillStripe = Pick<StripeServiceT, "listPaymentIntentRefunds">;

async function realStripe(): Promise<RecoveryBackfillStripe> {
  const { stripeService } = await import("./stripe/stripeService");
  return stripeService;
}

/**
 * Record Stripe refunds the hook missed. Looks at bookings with a PaymentIntent that were refunded, or went to
 * refunded/canceled, in the last 30 days (up to limit PaymentIntents, newest first), lists each one's Stripe
 * refunds and records every succeeded or pending one (start date and duplicates are handled by
 * recordBookingRefund). Computes and reverses nothing. A Stripe failure on one PaymentIntent is skipped.
 * Returns how many refunds were passed to recordBookingRefund.
 */
export async function backfillRefunds(limit = 50, s?: RecoveryBackfillStripe): Promise<number> {
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const pis = await rows<{ pi: string }>(sql`
    SELECT pi FROM (
      SELECT stripe_payment_intent_id AS pi, updated_at AS ts FROM appointments
      WHERE stripe_payment_intent_id IS NOT NULL
        AND (refunded_at >= now() - interval '30 days' OR (status IN ('refunded', 'canceled') AND updated_at >= now() - interval '30 days'))
      UNION ALL
      SELECT stripe_payment_intent_id AS pi, updated_at AS ts FROM shoot_bookings
      WHERE stripe_payment_intent_id IS NOT NULL
        AND (refunded_at >= now() - interval '30 days' OR (status IN ('refunded', 'canceled') AND updated_at >= now() - interval '30 days'))
    ) b GROUP BY pi ORDER BY max(ts) DESC LIMIT ${lim}`);
  if (!pis.length) return 0;
  const st = s ?? (await realStripe());
  let recorded = 0;
  for (const { pi } of pis) {
    try {
      const refunds = await st.listPaymentIntentRefunds(pi);
      for (const r of refunds) {
        if (r.status === "failed" || r.status === "canceled") continue;
        await recordBookingRefund({ refundId: r.id, paymentIntentId: pi, refundCents: r.amount, createdUnix: r.created });
        recorded++;
      }
    } catch (err) {
      console.error(`[bookingRecoveries] backfill skipped ${pi}:`, String((err as Error)?.message ?? err).slice(0, 200));
    }
  }
  return recorded;
}

// ─── The recovery job (Task 3) ──────────────────────────────────────────────
// Same machine as event recoveries (server/events/eventPayouts.ts processRecovery): claim with a 10 minute lock and
// an ownership tag, re-take before Stripe calls, look up reversals for this refund on every transfer before any
// reverse, one idempotency key per try, owed only after a definite insufficient funds error plus one more lookup,
// backoff 10, 20, 40, 60 minutes, lookup only after 5 failed tries.

export type RecoveryStripe = Pick<StripeServiceT,
  "listBookingTransfers" | "listPaymentIntentRefunds" | "findRecoveryReversals" | "reverseForRecovery" | "getPaymentIntentAmountReceived" | "isInsufficientFundsError">;
export type BookingRecoveryResult = "reversed" | "owed" | "nothing_sent" | "not_booking" | "retry" | "not_due";

export const RECOVERY_LOCK_MINUTES = 10;
export const RECOVERY_MAX_TRIES = 5;
export const RECOVERY_JOB_LIMIT = 20;
/** Owed this long: one admin email. */
export const RECOVERY_OWED_ALERT_DAYS = 30;
/** Owed rows are tried again this often even when no new payout is seen. */
const OWED_RETRY_MINUTES = 60;
/** Every Stripe call is bounded, so a try ends well inside the lock. */
const STRIPE_CALL_BOUND = { timeoutMs: 30000, maxNetworkRetries: 1 };

/** Ownership tag: updated_at in microseconds (copied from eventPayouts.ts). Every write sets updated_at. */
const OWNER_TAG = sql`(extract(epoch from updated_at) * 1000000)::bigint::text`;
/** Backoff 10, 20, 40, then 60 minutes (never shorter than the lock), from the attempts before this write. */
const BACKOFF = sql`now() + make_interval(mins => LEAST(60, ${RECOVERY_LOCK_MINUTES}::int * power(2, LEAST(GREATEST(attempts - 1, 0), 6)))::int)`;

async function realRecoveryStripe(): Promise<RecoveryStripe> {
  const { stripeService } = await import("./stripe/stripeService");
  return stripeService;
}

export type RecoveryNotice =
  | { channel: "email"; to: string; kind: "booking" | "shoot" | "staff" | "ticket"; subject: string; text: string }
  | { channel: "push"; userId: string; title: string; body: string };
let notifyForTest: ((m: RecoveryNotice) => Promise<void>) | null = null;
/** Test seam only: records seller emails and pushes instead of sending them. Never set in production. */
export function setRecoveryNotifyForTest(fn: ((m: RecoveryNotice) => Promise<void>) | null): void { notifyForTest = fn; }

/** Sends one seller email or push. Never throws. */
async function deliver(m: RecoveryNotice): Promise<void> {
  try {
    if (notifyForTest) return await notifyForTest(m);
    if (m.channel === "email") {
      const { sendRefundOwedEmail } = await import("./emailService");
      await sendRefundOwedEmail({ to: m.to, kind: m.kind, subject: m.subject, text: m.text });
    } else {
      const { sendExpoPush } = await import("./expoPushService");
      await sendExpoPush({ userId: m.userId, title: m.title, body: m.body, data: { type: "refund_owed" } });
    }
  } catch (err) {
    console.error(`[bookingRecoveries] seller ${m.channel} failed:`, String((err as Error)?.message ?? err).slice(0, 200));
  }
}

async function alertAdmin(subject: string, detail: string): Promise<void> {
  const { alertPayouts } = await import("./bankPayout");
  await alertPayouts(subject, detail);
}

const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300);
type Transfer = { id: string; amount: number; amountReversed: number; destination: string };

/**
 * Takes back one refund's seller share from the booking's Stripe transfers. Safe to run any number of times, at the
 * same time too. Claims a pending row, or an owed row that is due again.
 */
export async function processBookingRecovery(id: string, s?: RecoveryStripe): Promise<BookingRecoveryResult> {
  // Claim + in-flight lock. A row whose amount is not fixed yet is skipped while another row of the same booking
  // (same PaymentIntent) is claimed with no amount fixed, so two shares of one booking are never worked out at once.
  const [r] = await rows<any>(sql`
    UPDATE booking_refund_recoveries r SET attempts = attempts + 1,
           next_attempt_at = now() + make_interval(mins => ${RECOVERY_LOCK_MINUTES}::int), updated_at = now()
    WHERE r.id = ${id} AND r.status IN ('pending', 'owed') AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
      AND (r.reference_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM booking_refund_recoveries o
        WHERE o.payment_intent_id = r.payment_intent_id AND o.id <> r.id AND o.status = 'pending' AND o.reference_id IS NULL
          AND o.next_attempt_at > now() AND o.updated_at > now() - make_interval(mins => ${RECOVERY_LOCK_MINUTES}::int)))
    RETURNING id, refund_id, payment_intent_id, refund_cents, reference_type, reference_id, connected_account_id,
              amount_cents, status, attempts, last_error, ${OWNER_TAG} AS claim_tag`);
  if (!r) return "not_due";
  let tag = String(r.claim_tag);
  const wasOwed = r.status === "owed";

  if (r.reference_id == null) {
    // Two claims at the same moment can each miss the other in the check above. Both are committed before either
    // looks here, so at least one sees the other and steps back (try given back, due again now).
    const [other] = await rows<any>(sql`
      SELECT 1 AS x FROM booking_refund_recoveries o
      WHERE o.payment_intent_id = ${r.payment_intent_id} AND o.id <> ${r.id} AND o.status = 'pending' AND o.reference_id IS NULL
        AND o.next_attempt_at > now() AND o.updated_at > now() - make_interval(mins => ${RECOVERY_LOCK_MINUTES}::int)
      LIMIT 1`);
    if (other) {
      await rows(sql`
        UPDATE booking_refund_recoveries SET attempts = GREATEST(0, attempts - 1), next_attempt_at = now(), updated_at = now()
        WHERE id = ${r.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}`);
      return "not_due";
    }
  }

  const st = s ?? (await realRecoveryStripe());

  /** Re-take the lock, only while this claim still owns the row (a run whose lock ran out stops here). */
  const retake = async (): Promise<boolean> => {
    const [mine] = await rows<any>(sql`
      UPDATE booking_refund_recoveries SET next_attempt_at = now() + make_interval(mins => ${RECOVERY_LOCK_MINUTES}::int), updated_at = now()
      WHERE id = ${r.id} AND status IN ('pending', 'owed') AND ${OWNER_TAG} = ${tag}
      RETURNING ${OWNER_TAG} AS tag`);
    if (!mine) return false;
    tag = String(mine.tag);
    return true;
  };
  /** Close a row whose amount was never fixed (nothing to take back). */
  const close = async (status: "nothing_sent" | "not_booking", why: string, ref?: { type: string; id: string; recipient: string }): Promise<BookingRecoveryResult> => {
    const [c] = await rows<any>(sql`
      UPDATE booking_refund_recoveries SET status = ${status}, amount_cents = 0, next_attempt_at = NULL, last_error = ${why},
             reference_type = ${ref?.type ?? null}, reference_id = ${ref?.id ?? null}, recipient = ${ref?.recipient ?? null}, updated_at = now()
      WHERE id = ${r.id} AND status = 'pending' AND reference_id IS NULL AND ${OWNER_TAG} = ${tag}
      RETURNING id`);
    return c ? status : "not_due";
  };

  if (!(await retake())) return "not_due";

  let amount = Number(r.amount_cents);
  let transfers: Transfer[] | null = null;
  let justFixed = false;
  // Reversals this claim found or made, by id (the lookup on Stripe is the truth).
  const have = new Map<string, number>();
  const haveTotal = () => Array.from(have.values()).reduce((n, a) => n + a, 0);
  const ids = () => Array.from(have.keys()).join(",") || null;

  try {
    if (r.reference_id == null) {
      // Act only on a refund Stripe finished. Pending: wait (try given back). Failed or canceled: nothing to take back.
      const refund = (await st.listPaymentIntentRefunds(r.payment_intent_id, STRIPE_CALL_BOUND)).find((x) => x.id === r.refund_id);
      if (!refund) throw new Error(`refund ${r.refund_id} not found on Stripe`);
      if (refund.status === "failed" || refund.status === "canceled") return close("nothing_sent", `refund ${refund.status} on Stripe`);
      if (refund.status !== "succeeded") {
        const [w] = await rows<any>(sql`
          UPDATE booking_refund_recoveries SET attempts = GREATEST(0, attempts - 1), next_attempt_at = ${BACKOFF},
                 last_error = ${`refund is ${refund.status || "unknown"} on Stripe`}, updated_at = now()
          WHERE id = ${r.id} AND status = 'pending' AND ${OWNER_TAG} = ${tag}
          RETURNING id`);
        return w ? "retry" : "not_due";
      }
      const b = await resolveBooking(r.payment_intent_id);
      if (!b) return close("not_booking", "not an appointment or shoot booking payment");
      const ref = { type: b.type, id: b.id, recipient: b.recipient };
      const group = b.type === "appointment" ? `appointment_${b.id}` : `shoot_booking_${b.id}`;
      transfers = (await st.listBookingTransfers(group, STRIPE_CALL_BOUND)).filter((t) => t.amount > 0);
      if (!transfers.length) return close("nothing_sent", "no transfer was sent for this booking", ref);
      const account = [...transfers].sort((a, c) => c.amount - a.amount)[0].destination;
      const amountReceived = await st.getPaymentIntentAmountReceived(r.payment_intent_id, STRIPE_CALL_BOUND);
      // Other rows of this booking: their fixed amounts are already taken (or owed); what they reversed on Stripe is
      // added back to what is still on the transfers, so it is not counted twice.
      const [o] = await rows<any>(sql`
        SELECT COALESCE(sum(amount_cents) FILTER (WHERE reference_id IS NOT NULL), 0)::int AS taken, COALESCE(sum(reversed_cents), 0)::int AS back
        FROM booking_refund_recoveries WHERE payment_intent_id = ${r.payment_intent_id} AND id <> ${r.id}`);
      const sentNet = transfers.reduce((n, t) => n + t.amount - t.amountReversed, 0) + Number(o?.back ?? 0);
      const share = computeShare({
        intendedPayout: b.intendedPayout, base: b.base, amountReceived, refundCents: Number(r.refund_cents),
        sentNet, alreadyTaken: Number(o?.taken ?? 0),
      });
      // Fixed once, never changed. This claim counts as the first reversal try.
      const [f] = await rows<any>(sql`
        UPDATE booking_refund_recoveries SET reference_type = ${b.type}, reference_id = ${b.id}, recipient = ${b.recipient},
               connected_account_id = ${account}, amount_cents = ${share}, attempts = 1, last_error = NULL,
               status = CASE WHEN ${share}::int = 0 THEN 'reversed' ELSE status END,
               next_attempt_at = CASE WHEN ${share}::int = 0 THEN NULL ELSE next_attempt_at END, updated_at = now()
        WHERE id = ${r.id} AND status = 'pending' AND reference_id IS NULL AND ${OWNER_TAG} = ${tag}
        RETURNING ${OWNER_TAG} AS tag`);
      if (!f) return "not_due";
      tag = String(f.tag);
      if (share === 0) return "reversed";
      amount = share;
      justFixed = true;
      r.reference_type = b.type;
      r.reference_id = b.id;
    }

    if (!transfers) {
      const group = r.reference_type === "appointment" ? `appointment_${r.reference_id}` : `shoot_booking_${r.reference_id}`;
      transfers = (await st.listBookingTransfers(group, STRIPE_CALL_BOUND)).filter((t) => t.amount > 0);
    }
    // Largest remaining first.
    transfers.sort((a, c) => (c.amount - c.amountReversed) - (a.amount - a.amountReversed));
    // Past the last try: this claim only looks and never reverses. The try that failed last ended at least one lock
    // period ago (its backoff is never shorter), so a reversal it timed out on has landed by now if it ever will.
    const lookupOnly = !justFixed && Number(r.attempts) > RECOVERY_MAX_TRIES;

    // Reversals already made for this refund (lost reply, or a timed-out call that landed later): never made again.
    for (const t of transfers) for (const f of await st.findRecoveryReversals(t.id, r.refund_id, STRIPE_CALL_BOUND)) have.set(f.id, f.amount);
    let need = amount - haveTotal();
    if (need > 0 && lookupOnly) {
      return owe(`the reversal failed ${RECOVERY_MAX_TRIES} times and not all of it is on the transfers, last error: ${r.last_error ?? "none"}`);
    }
    for (const t of transfers) {
      if (need <= 0) break;
      const take = Math.min(need, t.amount - t.amountReversed);
      if (take <= 0) continue;
      // Still ours right before the create (the lookups may have been slow): otherwise send nothing.
      if (!(await retake())) return "not_due";
      // One key per claim and transfer: Stripe replays a saved response for 24 hours, errors included.
      const rev = await st.reverseForRecovery({
        transferId: t.id, amountCents: take, refundId: r.refund_id, bookingType: String(r.reference_type), bookingId: String(r.reference_id),
        idempotencyKey: `booking_recovery_${r.refund_id}_${t.id}_${r.claim_tag}`, ...STRIPE_CALL_BOUND,
      });
      have.set(rev.id, take);
      need -= take;
    }
    // Nothing left on the transfers to cover the rest (reversed some other way): owed, the admin sees it at 30 days.
    if (need > 0) return owe("the booking's transfers have nothing left to reverse");
    return finish();
  } catch (err) {
    const msg = errText(err);
    // Insufficient balance on a fixed amount: owed, after one more look on the transfers. Safe in this claim: this
    // claim's reversal request got a definite no from Stripe, and every earlier claim's call ended a lock period ago.
    if (r.reference_id != null && transfers && st.isInsufficientFundsError(err)) return oweUnlessReversed(msg);
    console.error(`[bookingRecoveries] recovery try ${r.attempts} failed for ${r.id}: ${msg}`);
    // Never owed here: a timed-out reversal may still land. What this claim made is kept; backoff, lookup only after 5.
    const [b] = await rows<any>(sql`
      UPDATE booking_refund_recoveries SET last_error = ${msg}, next_attempt_at = ${BACKOFF},
             reversed_cents = GREATEST(reversed_cents, ${haveTotal()}::int), reversal_ids = COALESCE(${ids()}, reversal_ids), updated_at = now()
      WHERE id = ${r.id} AND status IN ('pending', 'owed') AND ${OWNER_TAG} = ${tag}
      RETURNING id`).catch(() => [] as any[]);
    return b ? "retry" : "not_due";
  }

  /** All of it is on Stripe: status reversed (recovered when it was owed; both return 'reversed'). Saved while ours or while nobody holds it. */
  async function finish(): Promise<BookingRecoveryResult> {
    const [d] = await rows<any>(sql`
      UPDATE booking_refund_recoveries SET status = ${wasOwed ? "recovered" : "reversed"}, reversed_cents = ${amount},
             reversal_ids = ${ids()}, next_attempt_at = NULL, last_error = NULL,
             recovered_at = CASE WHEN ${wasOwed} THEN now() ELSE recovered_at END, updated_at = now()
      WHERE id = ${r.id} AND status IN ('pending', 'owed')
        AND (${OWNER_TAG} = ${tag} OR next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING id`);
    return d ? "reversed" : "not_due";
  }

  /**
   * Owed: the seller's balance can't cover the rest. What is on Stripe stays recorded. Tries start again from 0 and
   * the row is tried again within the hour (sooner once a new payout to the account is seen). owed_at keeps the first time.
   */
  async function owe(why: string): Promise<BookingRecoveryResult> {
    const [o] = await rows<any>(sql`
      UPDATE booking_refund_recoveries SET status = 'owed', reversed_cents = ${haveTotal()}, reversal_ids = ${ids()},
             owed_at = COALESCE(owed_at, now()), alerted_at = CASE WHEN status = 'owed' THEN alerted_at ELSE NULL END,
             attempts = 0, next_attempt_at = now() + make_interval(mins => ${OWED_RETRY_MINUTES}::int),
             last_error = ${why.slice(0, 300)}, updated_at = now()
      WHERE id = ${r.id} AND status IN ('pending', 'owed') AND ${OWNER_TAG} = ${tag}
      RETURNING id`);
    if (!o) return "not_due";
    console.warn(`[bookingRecoveries] recovery ${r.id} owes ${amount - haveTotal()} cents: ${why}`);
    return "owed";
  }

  /** After insufficient funds: one more bounded lookup on every transfer. Lookup fails: backoff, never owed blind. */
  async function oweUnlessReversed(why: string): Promise<BookingRecoveryResult> {
    try {
      for (const t of transfers!) for (const f of await st.findRecoveryReversals(t.id, r.refund_id, STRIPE_CALL_BOUND)) have.set(f.id, f.amount);
    } catch (lookErr) {
      const lm = errText(lookErr);
      const [b] = await rows<any>(sql`
        UPDATE booking_refund_recoveries SET last_error = ${`${why}; reversal lookup before owing failed: ${lm}`.slice(0, 300)},
               next_attempt_at = ${BACKOFF}, reversed_cents = GREATEST(reversed_cents, ${haveTotal()}::int),
               reversal_ids = COALESCE(${ids()}, reversal_ids), updated_at = now()
        WHERE id = ${r.id} AND status IN ('pending', 'owed') AND ${OWNER_TAG} = ${tag}
        RETURNING id`).catch(() => [] as any[]);
      return b ? "retry" : "not_due";
    }
    if (haveTotal() >= amount) return finish();
    return owe(why);
  }
}

/**
 * Owed rows become due now when the DB shows a newer transfer to the same Connect account: a settled appointment or
 * shoot with a transfer paid to that account, a paid booking payout retry, or a paid event payout, after the debt
 * or the row's last write. Event recoveries are never touched (they keep their own netting). A row written in the
 * last lock period may be in flight and is left alone. Otherwise owed rows come due once an hour on their own.
 */
export async function retryOwed(_s?: RecoveryStripe): Promise<number> {
  const made = await rows<any>(sql`
    UPDATE booking_refund_recoveries r SET next_attempt_at = now(), updated_at = now()
    WHERE r.status = 'owed' AND r.connected_account_id IS NOT NULL AND r.next_attempt_at > now()
      AND r.updated_at <= now() - make_interval(mins => ${RECOVERY_LOCK_MINUTES}::int)
      AND (
        EXISTS (SELECT 1 FROM appointments a JOIN businesses b ON b.id = a.business_id LEFT JOIN staff_members sm ON sm.id = a.staff_member_id
                WHERE a.settled_at > GREATEST(r.owed_at, r.updated_at) AND a.stripe_transfer_id IS NOT NULL
                  AND (CASE WHEN a.staff_member_id IS NOT NULL THEN sm.stripe_account_id ELSE b.stripe_account_id END) = r.connected_account_id)
        OR EXISTS (SELECT 1 FROM shoot_bookings sb JOIN photographers p ON p.id = sb.photographer_id
                   WHERE sb.settled_at > GREATEST(r.owed_at, r.updated_at) AND sb.stripe_transfer_id IS NOT NULL
                     AND p.stripe_account_id = r.connected_account_id)
        OR EXISTS (SELECT 1 FROM booking_payout_issues i
                   WHERE i.status = 'paid' AND i.connected_account_id = r.connected_account_id AND i.resolved_at > GREATEST(r.owed_at, r.updated_at))
        OR EXISTS (SELECT 1 FROM event_payouts ep
                   WHERE ep.status = 'paid' AND ep.connected_account_id = r.connected_account_id AND ep.paid_at > GREATEST(r.owed_at, r.updated_at)))
    RETURNING r.id`);
  return made.length;
}

const money = (c: number) => `$${(Number(c) / 100).toFixed(2)}`;
const OWED_SUBJECT = "Money owed for a refund";
function owedText(refundCents: number, owedCents: number, what: string): string {
  return `A customer was refunded ${money(refundCents)} for your ${what}. Your Stripe balance didn't cover your share of ${money(owedCents)}, so it will be taken from your next payout.`;
}
function dateText(d: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
  if (!m) return String(d ?? "");
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
async function tell(email: string | null | undefined, userId: string | null | undefined, kind: "booking" | "shoot" | "staff" | "ticket", text: string) {
  if (email) await deliver({ channel: "email", to: email, kind, subject: OWED_SUBJECT, text });
  if (userId) await deliver({ channel: "push", userId, title: OWED_SUBJECT, body: text });
}

/**
 * One email and one push per owed recovery, once (claimed by setting seller_notified_at before sending). Booking
 * rows: the business owner, or the staff member and the business owner, or the photographer. Event rows created
 * at or after the start date: the host user. Returns how many rows were told.
 */
export async function notifyOwedSellers(): Promise<number> {
  const bk = await rows<any>(sql`
    UPDATE booking_refund_recoveries SET seller_notified_at = now(), updated_at = now()
    WHERE id IN (SELECT id FROM booking_refund_recoveries WHERE status = 'owed' AND seller_notified_at IS NULL ORDER BY owed_at LIMIT 50)
      AND status = 'owed' AND seller_notified_at IS NULL
    RETURNING id, reference_type, reference_id, recipient, refund_cents, amount_cents, reversed_cents`);
  for (const r of bk) {
    try {
      const owed = Math.max(0, Number(r.amount_cents) - Number(r.reversed_cents));
      if (r.reference_type === "shoot_booking") {
        const [x] = await rows<any>(sql`
          SELECT sb.date AS d, p.user_id, u.email FROM shoot_bookings sb JOIN photographers p ON p.id = sb.photographer_id
          LEFT JOIN users u ON u.id = p.user_id WHERE sb.id = ${r.reference_id}`);
        if (!x) continue;
        await tell(x.email, x.user_id, "shoot", owedText(r.refund_cents, owed, `booking on ${dateText(x.d)}`));
      } else {
        const [x] = await rows<any>(sql`
          SELECT a.appointment_date AS d, b.owner_id, COALESCE(b.contact_email, ou.email) AS owner_email, sm.email AS staff_email, sm.user_id AS staff_user
          FROM appointments a JOIN businesses b ON b.id = a.business_id LEFT JOIN users ou ON ou.id = b.owner_id
          LEFT JOIN staff_members sm ON sm.id = a.staff_member_id WHERE a.id = ${r.reference_id}`);
        if (!x) continue;
        const text = owedText(r.refund_cents, owed, `booking on ${dateText(x.d)}`);
        if (r.recipient === "staff") {
          await tell(x.staff_email, x.staff_user, "staff", text);
          await tell(x.owner_email, x.owner_id, "staff", text);
        } else {
          await tell(x.owner_email, x.owner_id, "booking", text);
        }
      }
    } catch (err) {
      console.error(`[bookingRecoveries] seller notice for ${r.id} failed:`, errText(err));
    }
  }
  const ev = await rows<any>(sql`
    UPDATE event_payout_recoveries SET seller_notified_at = now(), updated_at = now()
    WHERE id IN (SELECT id FROM event_payout_recoveries
                 WHERE status = 'owed' AND seller_notified_at IS NULL AND created_at >= to_timestamp(${RECOVERY_START_UNIX})
                 ORDER BY created_at LIMIT 50)
      AND status = 'owed' AND seller_notified_at IS NULL
    RETURNING id, ticket_id, payout_id, amount_cents`);
  for (const r of ev) {
    try {
      const [x] = await rows<any>(sql`
        SELECT e.title, e.host_user_id, u.email, t.price_cents FROM event_payouts p JOIN events e ON e.id = p.event_id
        LEFT JOIN users u ON u.id = e.host_user_id LEFT JOIN tickets t ON t.id = ${r.ticket_id}
        WHERE p.id = ${r.payout_id}`);
      if (!x) continue;
      await tell(x.email, x.host_user_id, "ticket", owedText(Number(x.price_cents ?? 0), Number(r.amount_cents), `event ${x.title}`));
    } catch (err) {
      console.error(`[bookingRecoveries] host notice for event recovery ${r.id} failed:`, errText(err));
    }
  }
  return bk.length + ev.length;
}

/** Booking recoveries owed over 30 days and not yet reported: one admin email listing them (each once). */
export async function alertOldOwed(): Promise<number> {
  const old = await rows<any>(sql`
    UPDATE booking_refund_recoveries SET alerted_at = now(), updated_at = now()
    WHERE id IN (SELECT id FROM booking_refund_recoveries
                 WHERE status = 'owed' AND alerted_at IS NULL AND owed_at <= now() - make_interval(days => ${RECOVERY_OWED_ALERT_DAYS}::int)
                 ORDER BY owed_at LIMIT 100)
      AND status = 'owed' AND alerted_at IS NULL
    RETURNING id, refund_id, reference_type, reference_id, recipient, connected_account_id, amount_cents, reversed_cents`);
  if (!old.length) return 0;
  const owedOf = (o: any) => Math.max(0, Number(o.amount_cents) - Number(o.reversed_cents));
  const total = old.reduce((n, o) => n + owedOf(o), 0);
  const lines = old.map((o) => `Recovery ${o.id}: ${owedOf(o)} cents for refund ${o.refund_id} on ${o.reference_type} ${o.reference_id} (${o.recipient}), Stripe account ${o.connected_account_id}.`);
  await alertAdmin("Booking refunds still owed",
    `${old.length} booking refunds are still owed by the seller after ${RECOVERY_OWED_ALERT_DAYS} days, ${total} cents in all. ` +
    `They are tried again every hour and after each new payout to the seller; collect them or write them off by hand. ${lines.join(" ")}`);
  return old.length;
}

/**
 * Every minute: record refunds the hook missed, take back up to 20 due recoveries (least recently tried first), make
 * owed ones due after a new payout, tell sellers, report old owed ones. Each step has its own try/catch.
 */
export async function runBookingRecoveryJob(s?: RecoveryStripe): Promise<{ recorded: number; reversed: number; owed: number; retried: number; notified: number; alerted: number }> {
  const out = { recorded: 0, reversed: 0, owed: 0, retried: 0, notified: 0, alerted: 0 };
  try {
    out.recorded = await backfillRefunds(50, s);
  } catch (err) {
    console.error("[bookingRecoveries] backfill step failed:", errText(err));
  }
  try {
    const dueRows = await rows<any>(sql`
      SELECT id FROM booking_refund_recoveries
      WHERE status IN ('pending', 'owed') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY updated_at LIMIT ${RECOVERY_JOB_LIMIT}`);
    for (const d of dueRows) {
      try {
        const res = await processBookingRecovery(String(d.id), s);
        if (res === "reversed") out.reversed++;
        else if (res === "owed") out.owed++;
      } catch (err) {
        console.error(`[bookingRecoveries] recovery ${d.id} failed:`, errText(err));
      }
    }
  } catch (err) {
    console.error("[bookingRecoveries] recovery step failed:", errText(err));
  }
  try {
    out.retried = await retryOwed(s);
  } catch (err) {
    console.error("[bookingRecoveries] owed retry step failed:", errText(err));
  }
  try {
    out.notified = await notifyOwedSellers();
  } catch (err) {
    console.error("[bookingRecoveries] seller notice step failed:", errText(err));
  }
  try {
    out.alerted = await alertOldOwed();
  } catch (err) {
    console.error("[bookingRecoveries] old owed alert step failed:", errText(err));
  }
  return out;
}
