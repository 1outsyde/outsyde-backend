/**
 * Quotes step 4a (migration 099): the balance hold, Job complete, and what cancels and refunds do to the balance.
 * Rules: ./quoteBalanceRules.ts and fees.ts quoteBalanceSplit. Table: quote_jobs (one row per paid service quote).
 *
 * Money safety (the vault's Stripe rules, same pattern as R39 cancellationFees.ts):
 *   - every Stripe call that moves or reserves money is claimed first (one guarded UPDATE, a claim tag), looks at
 *     Stripe first (metadata match), sends one idempotency key per try and is bounded (30 s, 1 retry);
 *   - a failed call never decides "it didn't happen": the row stays claimed and the next try looks it up;
 *   - the balance PaymentIntent has its own metadata type, `quote_balance`, never `appointment` (the webhook's
 *     appointment branch would confirm and settle it) and never an `orderId` (the cancel handler would close an order).
 *
 * 4a keeps the vendor's share of a captured balance with Outsyde (payout_status 'held'); 4b pays it after Confirm or
 * the 6 h window, as its own transfer (group appointment_balance_<id>).
 */
import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { quoteJobs, quotes, BOOKING_STATES, type Appointment, type Quote, type QuoteJob } from "@shared/schema";
import { getUncachableStripeClient } from "../stripe/stripeClient";
import { quoteBalanceSplit } from "../fees";
import { autoCompleteAt, balanceHoldTimes, jobCompleteBlocker, splitHold, type JobCompleteBlock } from "./quoteBalanceRules";
import { formatCents } from "./quoteRules";
import { postCardMessage } from "../messaging/postCard";

export const BALANCE_PI_TYPE = "quote_balance";
const CLAIM_MINUTES = 10;
const BOUND = { timeout: 30_000, maxNetworkRetries: 1 } as const;
export const balanceTransferGroup = (appointmentId: string) => `appointment_balance_${appointmentId}`;

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}
const chargeIdOf = (pi: any): string | null => (typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id ?? null);
const isCardError = (err: any) => err?.type === "StripeCardError" || err?.rawType === "card_error";
const errMsg = (err: any) => (err?.message || String(err)).slice(0, 500);

export async function quoteJobFor(appointmentId: string): Promise<QuoteJob | undefined> {
  const [j] = await db.select().from(quoteJobs).where(eq(quoteJobs.appointmentId, appointmentId));
  return j;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

/** Card text reads on its own (older app builds show only this). No dashes, never the fee rate. */
export function balanceCardText(event: "balance_held" | "balance_failed", title: string, holdCents: number): string {
  const t = title.trim();
  if (event === "balance_held") return `The balance for ${t}, ${formatCents(holdCents)}, is on hold on your card. It is charged when the job is complete.`;
  return `We couldn't hold the balance for ${t}, ${formatCents(holdCents)}, on your card. Update your card to keep this booking.`;
}

/** Posts a balance card once (the notice column is the claim). Best effort. */
async function postBalanceCard(job: QuoteJob, event: "balance_held" | "balance_failed"): Promise<void> {
  try {
    const col = event === "balance_held" ? quoteJobs.heldNoticeAt : quoteJobs.failedNoticeAt;
    const [first] = await db.update(quoteJobs).set(event === "balance_held" ? { heldNoticeAt: new Date() } : { failedNoticeAt: new Date() })
      .where(and(eq(quoteJobs.id, job.id), sql`${col} IS NULL`)).returning({ id: quoteJobs.id });
    if (!first) return;
    const [q] = await db.select().from(quotes).where(eq(quotes.id, job.quoteId));
    if (!q || (await storage.isUserBlockedEitherWay(q.senderId, q.customerId))) return;
    await postCardMessage({
      conversationId: q.conversationId,
      senderId: q.senderId,
      recipientId: q.customerId,
      kind: "quote",
      card: {
        type: "quote", event, quoteId: q.id, version: q.version, businessId: q.businessId, appointmentId: job.appointmentId,
        title: q.title, totalCents: q.totalCents, balanceCents: job.balanceCents, balanceServiceFeeCents: job.serviceFeeCents,
        holdCents: job.holdCents, jobDate: q.jobDate, startTime: q.startTime, timeZone: q.timeZone,
      },
      content: balanceCardText(event, q.title, job.holdCents),
    });
    // Step 6a call 6: the business hears a card couldn't be held (this card goes to the customer only).
    if (event === "balance_failed") {
      const { noticeBusiness } = await import("./quoteNotices");
      await noticeBusiness(q, "card_failed", job.id, { amountCents: job.holdCents });
    }
  } catch (err) {
    console.error(`[quote balance] ${event} card failed for job ${job.id}:`, err);
  }
}

// ─── The job record ─────────────────────────────────────────────────────────

/**
 * Called on every path that confirms a paid service quote (afterQuotePaid). Makes the job record once, and holds
 * the balance at once when the job is less than 24 h away. Safe to run more than once.
 */
export async function ensureQuoteJob(q: Quote, appt: Appointment, now = new Date()): Promise<QuoteJob | undefined> {
  if (q.kind !== "service" || !q.startsAt || !q.durationMinutes) return undefined;
  const startsAt = new Date(q.startsAt);
  // Step 4b-2a (B15): the rest paid to the business directly is never held or charged here.
  const split = quoteBalanceSplit(q.totalCents, q.paymentMode === "deposit" && q.restPaid !== "outside" ? q.depositCents ?? null : null);
  const times = balanceHoldTimes(startsAt, q.paidAt ? new Date(q.paidAt) : now);
  await db.insert(quoteJobs).values({
    appointmentId: appt.id,
    quoteId: q.id,
    businessId: q.businessId,
    clientId: appt.clientId,
    startsAt,
    durationMinutes: q.durationMinutes,
    autoCompleteAt: autoCompleteAt(startsAt, q.durationMinutes),
    balanceCents: split.balanceCents,
    serviceFeeCents: split.serviceFeeCents,
    platformFeeCents: split.platformFeeCents,
    vendorNetCents: split.vendorNetCents,
    holdCents: split.holdCents,
    balanceStatus: split.holdCents > 0 ? "scheduled" : "none",
    holdAt: split.holdCents > 0 ? times.holdAt : null,
    retryAt: split.holdCents > 0 ? times.retryAt : null,
  }).onConflictDoNothing({ target: quoteJobs.appointmentId });
  const job = await quoteJobFor(appt.id);
  if (job && job.balanceStatus === "scheduled" && job.holdAt && new Date(job.holdAt).getTime() <= now.getTime()) {
    await placeBalanceHold(job.id, now).catch((err) => console.error(`[quote balance] hold at payment failed for ${appt.id}:`, err));
    return quoteJobFor(appt.id);
  }
  return job;
}

// ─── The hold ───────────────────────────────────────────────────────────────

export type HoldOutcome = "held" | "declined" | "unknown" | "busy" | "not_due";

/** An earlier balance hold for this booking that went through (or is going through), found at Stripe. */
async function findEarlierHold(stripe: any, customerId: string, appointmentId: string, sinceUnix: number): Promise<any | null> {
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await stripe.paymentIntents.list(
      { customer: customerId, created: { gte: sinceUnix }, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) }, BOUND);
    const hit = (list?.data ?? []).find((pi: any) => pi?.metadata?.type === BALANCE_PI_TYPE && pi?.metadata?.appointmentId === appointmentId
      && ["requires_capture", "succeeded", "processing"].includes(pi.status));
    if (hit) return hit;
    if (!list?.has_more || !list.data?.length) return null;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return null;
}

/** Marks a hold placed (or its capture done) from a PaymentIntent Stripe returned or we found. */
async function recordHeld(jobId: string, tag: string | null, pi: any): Promise<boolean> {
  // Only the claim that made (or found) this payment may record it, and never over a different held payment.
  const guard = sql`(${tag}::text IS NULL OR (claim_tag = ${tag} AND balance_status IN ('holding', 'capturing', 'releasing')))
       AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = ${pi.id} OR balance_status = 'holding')`;
  if (pi?.status === "succeeded") {
    const [done] = await rows(sql`
      UPDATE quote_jobs SET balance_status = 'captured', stripe_payment_intent_id = ${pi.id}, stripe_charge_id = ${chargeIdOf(pi)},
             captured_cents = ${Number(pi.amount_received ?? pi.amount)}::int, captured_at = now(), held_at = COALESCE(held_at, now()),
             payout_status = 'held', retry_at = NULL, last_error = NULL, updated_at = now()
       WHERE id = ${jobId} AND ${guard} RETURNING id`);
    return !!done;
  }
  const [done] = await rows(sql`
    UPDATE quote_jobs SET balance_status = 'held', stripe_payment_intent_id = ${pi.id}, held_at = now(), retry_at = NULL, last_error = NULL, updated_at = now()
     WHERE id = ${jobId} AND ${guard} RETURNING id`);
  if (!done && pi?.status === "requires_capture") await letGoOfStrayHold(pi, `job ${jobId} already has another balance payment`);
  return !!done;
}

/** A held balance payment that isn't the one on the booking's record: cancel it so it never sits on the card. */
async function letGoOfStrayHold(pi: any, why: string): Promise<void> {
  try {
    const stripe: any = await getUncachableStripeClient();
    await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: "duplicate" }, BOUND);
    console.warn(`[quote balance] let go of stray hold ${pi.id}: ${why}`);
  } catch (err) {
    console.error(`[quote balance] COULD NOT let go of stray hold ${pi.id} (${why}):`, err);
  }
}

/**
 * Places the balance hold (due now: the first try 24 h before, or the retry 12 h before). The booking must still be
 * confirmed. Returns what happened; only a card decline counts as failed.
 */
export async function placeBalanceHold(jobId: string, now = new Date()): Promise<HoldOutcome> {
  const tag = randomUUID();
  const [claimed] = await rows<{ id: string; appointment_id: string; quote_id: string; client_id: string; hold_cents: number; created_at: string; retry_at: string | null; prev: string }>(sql`
    UPDATE quote_jobs j SET balance_status = 'holding', attempts = j.attempts + 1, claim_tag = ${tag}, updated_at = now()
      FROM (SELECT id, balance_status AS prev FROM quote_jobs WHERE id = ${jobId}) p
     WHERE j.id = p.id
       AND EXISTS (SELECT 1 FROM appointments a WHERE a.id = j.appointment_id AND a.status = 'confirmed')
       AND ((j.balance_status = 'scheduled' AND j.hold_at <= ${now})
         OR (j.balance_status = 'hold_failed' AND j.retry_at IS NOT NULL AND j.retry_at <= ${now})
         OR (j.balance_status = 'holding' AND j.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     RETURNING j.id, j.appointment_id, j.quote_id, j.client_id, j.hold_cents, j.created_at, j.retry_at, p.prev`);
  if (!claimed) {
    const j = await db.select({ s: quoteJobs.balanceStatus }).from(quoteJobs).where(eq(quoteJobs.id, jobId));
    return j[0]?.s === "holding" ? "busy" : "not_due";
  }
  // The first try failed and its retry time has come (or there is none): a decline now is final.
  const isLastTry = claimed.prev === "hold_failed" || !claimed.retry_at || new Date(claimed.retry_at).getTime() <= now.getTime();
  const note = async (msg: string) => { await rows(sql`UPDATE quote_jobs SET last_error = ${msg.slice(0, 500)}, updated_at = now() WHERE id = ${jobId} AND claim_tag = ${tag}`); };
  const declined = async (msg: string, _piId: string | null) => {
    const [row] = await rows<{ id: string }>(sql`
      UPDATE quote_jobs SET balance_status = 'hold_failed', last_error = ${msg.slice(0, 500)},
             retry_at = CASE WHEN ${isLastTry} THEN NULL ELSE retry_at END,
             updated_at = now()
       WHERE id = ${jobId} AND claim_tag = ${tag} RETURNING id`);
    if (row && isLastTry) {
      const job = await quoteJobFor(claimed.appointment_id);
      if (job) await postBalanceCard(job, "balance_failed");
    }
    return "declined" as const;
  };

  const appt = await storage.getAppointment(claimed.appointment_id);
  const user = appt ? await storage.getUser(appt.clientId) : undefined;
  const stripe: any = await getUncachableStripeClient();
  let customerId: string | null = user?.stripeCustomerId ?? null;
  let paymentMethodId: string | null = null;
  try {
    if (appt?.stripePaymentIntentId) {
      const dep: any = await stripe.paymentIntents.retrieve(appt.stripePaymentIntentId, {}, BOUND);
      paymentMethodId = typeof dep?.payment_method === "string" ? dep.payment_method : dep?.payment_method?.id ?? null;
      customerId = (typeof dep?.customer === "string" ? dep.customer : dep?.customer?.id) ?? customerId;
    }
  } catch (err) {
    await note(`deposit lookup: ${errMsg(err)}`);
    return "unknown";
  }
  if (!customerId || !paymentMethodId) return declined("no saved card on the deposit payment", null);
  await rows(sql`UPDATE quote_jobs SET stripe_customer_id = ${customerId}, payment_method_id = ${paymentMethodId} WHERE id = ${jobId} AND claim_tag = ${tag}`);

  try {
    const since = Math.floor(new Date(claimed.created_at).getTime() / 1000) - 3600;
    const earlier = await findEarlierHold(stripe, customerId, claimed.appointment_id, since);
    if (earlier) {
      await recordHeld(jobId, tag, earlier);
      const job = await quoteJobFor(claimed.appointment_id);
      if (job?.balanceStatus === "held") await postBalanceCard(job, "balance_held");
      return "held";
    }
  } catch (err) {
    await note(`lookup: ${errMsg(err)}`);
    return "unknown";
  }

  const [q] = await db.select().from(quotes).where(eq(quotes.id, claimed.quote_id));
  const business = appt ? await storage.getBusiness(appt.businessId) : undefined;
  try {
    const pi = await stripe.paymentIntents.create({
      amount: claimed.hold_cents, // fixed on the record at payment, the same on every try
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethodId,
      capture_method: "manual",
      off_session: true,
      confirm: true,
      metadata: { type: BALANCE_PI_TYPE, appointmentId: claimed.appointment_id, quoteId: claimed.quote_id, businessId: appt?.businessId ?? "" },
      description: `Balance for ${q?.title ?? "your booking"}${business?.name ? ` at ${business.name}` : ""}`.slice(0, 450),
    }, { idempotencyKey: `quote_balance_hold_${claimed.appointment_id}_${tag}`, ...BOUND });
    if (pi?.status === "requires_capture" || pi?.status === "succeeded") {
      await recordHeld(jobId, tag, pi);
      const job = await quoteJobFor(claimed.appointment_id);
      if (job?.balanceStatus === "held") await postBalanceCard(job, "balance_held");
      return "held";
    }
    // requires_action or requires_payment_method: the card needs the customer; nothing is reserved.
    if (pi?.id && pi.status !== "canceled") await stripe.paymentIntents.cancel(pi.id, {}, BOUND).catch(() => undefined);
    return declined(`status ${pi?.status}`, pi?.id ?? null);
  } catch (err: any) {
    if (isCardError(err)) return declined(errMsg(err), err?.raw?.payment_intent?.id ?? null);
    await note(errMsg(err)); // may still have landed: the next try looks it up first
    return "unknown";
  }
}

// ─── Capture (Job complete) and release (cancels) ───────────────────────────

type CaptureResult = { ok: true; capturedCents: number; chargeId: string | null } | { ok: false; code: "BALANCE_NOT_HELD" | "BALANCE_BUSY" | "CAPTURE_FAILED"; message: string };

/**
 * Takes amountCents (default: the whole hold) from a held balance. Stripe releases the rest of the hold. Claimed,
 * looked up first, keyed per try, bounded.
 */
export async function captureBalance(appointmentId: string, amountCents?: number): Promise<CaptureResult> {
  const tag = randomUUID();
  const [claimed] = await rows<{ id: string; stripe_payment_intent_id: string; hold_cents: number }>(sql`
    UPDATE quote_jobs SET balance_status = 'capturing', claim_tag = ${tag}, updated_at = now()
     WHERE appointment_id = ${appointmentId} AND stripe_payment_intent_id IS NOT NULL
       AND (balance_status = 'held' OR (balance_status = 'capturing' AND updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     RETURNING id, stripe_payment_intent_id, hold_cents`);
  if (!claimed) {
    const job = await quoteJobFor(appointmentId);
    if (job?.balanceStatus === "captured") return { ok: true, capturedCents: job.capturedCents ?? 0, chargeId: job.stripeChargeId };
    if (job?.balanceStatus === "capturing" || job?.balanceStatus === "releasing") return { ok: false, code: "BALANCE_BUSY", message: "The balance is being charged right now. Try again in a few minutes." };
    return { ok: false, code: "BALANCE_NOT_HELD", message: "The balance isn't on hold on the customer's card, so it can't be charged." };
  }
  const amount = amountCents === undefined ? claimed.hold_cents : Math.max(1, Math.min(claimed.hold_cents, Math.round(amountCents)));
  const stripe: any = await getUncachableStripeClient();
  const back = async (status: "held" | "hold_failed", msg: string) => {
    await rows(sql`UPDATE quote_jobs SET balance_status = ${status}, last_error = ${msg.slice(0, 500)}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
  };
  try {
    const cur: any = await stripe.paymentIntents.retrieve(claimed.stripe_payment_intent_id, {}, BOUND);
    if (cur?.status === "succeeded") {
      await recordHeld(claimed.id, tag, cur);
      return { ok: true, capturedCents: Number(cur.amount_received ?? 0), chargeId: chargeIdOf(cur) };
    }
    if (cur?.status !== "requires_capture") {
      await back("hold_failed", `hold is ${cur?.status} at Stripe`);
      await rows(sql`UPDATE quote_jobs SET retry_at = NULL WHERE id = ${claimed.id}`);
      const job = await quoteJobFor(appointmentId);
      if (job?.balanceStatus === "hold_failed") await postBalanceCard(job, "balance_failed");
      return { ok: false, code: "BALANCE_NOT_HELD", message: "The hold on the customer's card has ended, so the balance can't be charged." };
    }
  } catch (err) {
    await rows(sql`UPDATE quote_jobs SET last_error = ${`lookup: ${errMsg(err)}`}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
    return { ok: false, code: "CAPTURE_FAILED", message: "The balance couldn't be charged right now. Try again in a few minutes." };
  }
  try {
    const pi: any = await stripe.paymentIntents.capture(claimed.stripe_payment_intent_id, { amount_to_capture: amount },
      { idempotencyKey: `quote_balance_capture_${appointmentId}_${amount}_${tag}`, ...BOUND });
    await recordHeld(claimed.id, tag, pi);
    return { ok: true, capturedCents: Number(pi.amount_received ?? amount), chargeId: chargeIdOf(pi) };
  } catch (err) {
    // Unknown: left 'capturing'; the next try (after the claim runs out) reads Stripe first.
    await rows(sql`UPDATE quote_jobs SET last_error = ${errMsg(err)}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
    return { ok: false, code: "CAPTURE_FAILED", message: "The balance couldn't be charged right now. Try again in a few minutes." };
  }
}

export type CancelBalanceResult = { ok: true; capturedCents: number; chargeId: string | null; released: boolean } | { ok: false; code: "BALANCE_BUSY" | "BALANCE_RELEASE_FAILED"; message: string };

/**
 * A quote booking is ending before Job complete (any cancel, decline, no show). The vendor's policy is applied by
 * the caller first; owedCents is what it says is still owed beyond what was paid. Takes only that from the hold and
 * releases the rest; nothing owed: the hold is released. A balance not yet held is simply never held. Returns ok for
 * bookings without a quote job.
 */
export async function settleBalanceOnCancel(appointmentId: string, owedCents = 0): Promise<CancelBalanceResult> {
  // Step 4b-2b: the extras are let go first, on every cancel path (they are never part of a cancellation fee).
  const { releaseExtrasOnCancel } = await import("./quoteExtras");
  // Review I3: an extras release that can't finish now never holds up the balance; the extras job finishes it
  // (and holds the extras again if the booking turns out to stay confirmed).
  const ex = await releaseExtrasOnCancel(appointmentId).catch((err) => ({ ok: false as const, message: String(err?.message ?? err) }));
  if (!ex.ok) console.error(`[quote balance] extras release for ${appointmentId} left to the job: ${ex.message}`);
  return settleBalancePart(appointmentId, owedCents);
}

async function settleBalancePart(appointmentId: string, owedCents: number): Promise<CancelBalanceResult> {
  const job = await quoteJobFor(appointmentId);
  if (!job || job.balanceStatus === "none" || job.balanceStatus === "released") return { ok: true, capturedCents: 0, chargeId: null, released: false };
  if (job.balanceStatus === "captured") return { ok: true, capturedCents: 0, chargeId: null, released: false }; // refund paths handle it
  if (job.balanceStatus === "scheduled" || job.balanceStatus === "hold_failed") {
    const [stopped] = await rows<{ id: string; pi: string | null }>(sql`
      UPDATE quote_jobs SET balance_status = 'released', released_at = now(), retry_at = NULL, updated_at = now()
       WHERE id = ${job.id} AND balance_status IN ('scheduled', 'hold_failed') RETURNING id, stripe_payment_intent_id AS pi`);
    if (stopped) {
      // An "Update your card" payment the customer never finished: let it go too.
      if (stopped.pi) {
        const stripe: any = await getUncachableStripeClient();
        await stripe.paymentIntents.retrieve(stopped.pi, {}, BOUND)
          .then((pi: any) => (["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"].includes(pi?.status) ? stripe.paymentIntents.cancel(pi.id, {}, BOUND) : null))
          .catch((err: any) => console.error(`[quote balance] could not let go of ${stopped.pi}:`, err));
      }
      return { ok: true, capturedCents: 0, chargeId: null, released: true };
    }
    return settleBalancePart(appointmentId, owedCents);
  }
  if (job.balanceStatus !== "held") return { ok: false, code: "BALANCE_BUSY", message: "The balance is being updated right now. Try again in a few minutes." };

  const { captureCents } = splitHold(job.holdCents, owedCents);
  if (captureCents > 0) {
    const c = await captureBalance(appointmentId, captureCents);
    if (!c.ok) return { ok: false, code: c.code === "BALANCE_NOT_HELD" ? "BALANCE_RELEASE_FAILED" : "BALANCE_BUSY", message: c.message };
    // What was taken is a cancellation fee, paid to the vendor as one (payQuoteCancelFeeShare), never a balance payout.
    await rows(sql`UPDATE quote_jobs SET payout_status = 'canceled', updated_at = now() WHERE id = ${job.id}`);
    return { ok: true, capturedCents: c.capturedCents, chargeId: c.chargeId, released: false };
  }
  const tag = randomUUID();
  const [claimed] = await rows<{ id: string; pi: string }>(sql`
    UPDATE quote_jobs SET balance_status = 'releasing', claim_tag = ${tag}, updated_at = now()
     WHERE id = ${job.id} AND balance_status = 'held' RETURNING id, stripe_payment_intent_id AS pi`);
  if (!claimed) return settleBalancePart(appointmentId, owedCents);
  const stripe: any = await getUncachableStripeClient();
  try {
    const cur: any = await stripe.paymentIntents.retrieve(claimed.pi, {}, BOUND);
    if (cur?.status === "requires_capture") await stripe.paymentIntents.cancel(claimed.pi, { cancellation_reason: "requested_by_customer" }, BOUND);
    else if (cur?.status === "succeeded") {
      // Captured meanwhile (a Job complete that raced): record it; the refund paths take it from there.
      await recordHeld(claimed.id, tag, cur);
      return { ok: false, code: "BALANCE_BUSY", message: "The balance was just charged. Refund it instead." };
    }
    await rows(sql`UPDATE quote_jobs SET balance_status = 'released', released_at = now(), updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
    return { ok: true, capturedCents: 0, chargeId: null, released: true };
  } catch (err) {
    await rows(sql`UPDATE quote_jobs SET balance_status = 'held', last_error = ${`release: ${errMsg(err)}`}, updated_at = now() WHERE id = ${claimed.id} AND claim_tag = ${tag}`);
    return { ok: false, code: "BALANCE_RELEASE_FAILED", message: "The hold on the customer's card couldn't be released right now. Try again in a few minutes." };
  }
}

// ─── Refunds of a captured balance ──────────────────────────────────────────

/** What can still be refunded, in the business's cents (the money Outsyde took at Job complete, less refunds). */
export function refundableBalanceCents(job: QuoteJob | undefined | null): number {
  if (!job || job.balanceStatus !== "captured" || job.payoutStatus === "canceled" && (job.capturedCents ?? 0) < job.holdCents) return 0;
  const business = Math.min(job.balanceCents, job.capturedCents ?? 0);
  return Math.max(0, business - job.refundedCents);
}

/**
 * Records a refund of the balance payment (in app, the Stripe dashboard, or a lost dispute). Callers make it once
 * per refund (the in app plan below, the dashboard sync's own refund record). refunded_cents is what Stripe gave
 * back on the balance payment; once it covers the business's part, the vendor's held share is never paid (4b).
 */
export async function recordBalanceRefund(paymentIntentId: string, amountCents: number, refundId: string | null = null): Promise<void> {
  await rows(sql`
    UPDATE quote_jobs SET refunded_cents = refunded_cents + ${amountCents}::int, stripe_refund_id = COALESCE(${refundId}, stripe_refund_id),
           payout_status = CASE WHEN refunded_cents + ${amountCents}::int >= balance_cents AND payout_status IN ('held', 'paused') THEN 'canceled' ELSE payout_status END,
           updated_at = now()
     WHERE stripe_payment_intent_id = ${paymentIntentId}`);
  // Step 4b-2b: or the extras payment (the same refund paths reach it).
  const { recordExtrasRefund } = await import("./quoteExtras");
  await recordExtrasRefund(paymentIntentId, amountCents);
}

/**
 * Refunds up to amountCents from a quote booking: the balance payment first (the later money), then the deposit
 * (review C2). The split is planned once and saved (quote_refunds, keyed by the caller's operation key) and every
 * try works from that saved plan with keys built from it, so a retry after a failed part finishes the same plan and
 * can never refund more. Each part, once Stripe returns it, is recorded once (on the booking's refund total and, for
 * the balance, on the job). A booking with an unfinished plan resumes that plan whatever amount a new call asks for.
 */
/** An unfinished refund plan on this booking (a part failed): the next refund call finishes it first. */
export async function hasOpenQuoteRefund(appointmentId: string): Promise<boolean> {
  const [r] = await rows(sql`SELECT 1 AS x FROM quote_refunds WHERE appointment_id = ${appointmentId} AND done_at IS NULL LIMIT 1`);
  return !!r;
}

export async function refundQuoteBooking(appt: Appointment, amountCents: number, opKey: string, metadata: Record<string, string>): Promise<{ fromExtras: number; fromBalance: number; fromDeposit: number; refundIds: string[]; resumed: boolean }> {
  const { stripeService } = await import("../stripe/stripeService");
  const [open] = await rows<any>(sql`SELECT * FROM quote_refunds WHERE appointment_id = ${appt.id} AND done_at IS NULL ORDER BY created_at LIMIT 1`);
  let plan = open;
  if (!plan) {
    const job = await quoteJobFor(appt.id);
    // Step 4b-2b (B6): the extras first, then the balance, then the deposit.
    const { extrasPaymentFor, refundableExtrasCents } = await import("./quoteExtras");
    const ex = await extrasPaymentFor(appt.id);
    const fromExtras = Math.min(amountCents, refundableExtrasCents(ex));
    const fromBalance = Math.min(amountCents - fromExtras, refundableBalanceCents(job));
    await rows(sql`
      INSERT INTO quote_refunds (op_key, appointment_id, extras_pi, balance_pi, deposit_pi, extras_cents, balance_cents, deposit_cents)
      VALUES (${opKey}, ${appt.id}, ${fromExtras > 0 ? ex?.stripePaymentIntentId ?? null : null}, ${fromBalance > 0 ? job?.stripePaymentIntentId ?? null : null}, ${appt.stripePaymentIntentId ?? null},
              ${fromExtras}::int, ${fromBalance}::int, ${amountCents - fromExtras - fromBalance}::int)
      ON CONFLICT (op_key) DO NOTHING`);
    [plan] = await rows<any>(sql`SELECT * FROM quote_refunds WHERE op_key = ${opKey}`);
  }
  const refundIds: string[] = [];
  const part = async (which: "extras" | "balance" | "deposit") => {
    const cents = Number(plan[`${which}_cents`]);
    const pi = plan[`${which}_pi`];
    if (cents <= 0 || plan[`${which}_refund_id`]) { if (plan[`${which}_refund_id`]) refundIds.push(plan[`${which}_refund_id`]); return; }
    if (!pi) throw new Error(`no ${which} payment to refund`);
    const r: any = await stripeService.createBookingRefund({
      paymentIntentId: pi, amountCents: cents, reason: "requested_by_customer",
      metadata: { ...metadata, appointmentId: appt.id, part: which }, idempotencyKey: `${plan.op_key}_${which}`,
    });
    const got = Number(r.amount ?? cents);
    const [first] = await rows<{ id: string }>(sql`
      UPDATE quote_refunds SET ${sql.raw(`${which}_refund_id`)} = ${r.id}, ${sql.raw(`${which}_refunded_cents`)} = ${got}::int, updated_at = now()
       WHERE id = ${plan.id} AND ${sql.raw(`${which}_refund_id`)} IS NULL RETURNING id`);
    if (first) {
      await rows(sql`UPDATE appointments SET refund_amount = COALESCE(refund_amount, 0) + ${got}::int, refunded_at = now(), stripe_refund_id = ${r.id} WHERE id = ${appt.id}`);
      if (which === "balance") await recordBalanceRefund(pi, got, r.id);
      if (which === "extras") { const { recordExtrasRefund } = await import("./quoteExtras"); await recordExtrasRefund(pi, got); }
    }
    refundIds.push(r.id);
  };
  await part("extras");
  await part("balance");
  await part("deposit");
  await rows(sql`UPDATE quote_refunds SET done_at = now(), updated_at = now() WHERE id = ${plan.id} AND done_at IS NULL`);
  return { fromExtras: Number(plan.extras_cents ?? 0), fromBalance: Number(plan.balance_cents), fromDeposit: Number(plan.deposit_cents), refundIds, resumed: !!open && open.op_key !== opKey };
}

// ─── Job complete ───────────────────────────────────────────────────────────

export type CompleteResult =
  | { ok: true; pointsReleased: number; capturedCents: number; extrasCapturedCents: number }
  | { ok: false; status: number; code: JobCompleteBlock | "BALANCE_BUSY" | "CAPTURE_FAILED" | "NOT_FOUND" | "EXTRAS_NOT_HELD" | "EXTRAS_BUSY"; message: string };

const EXTRAS_BLOCK_TEXT = {
  EXTRAS_NOT_HELD: "The approved extras aren't on hold on the customer's card yet, so the job can't be marked complete until they are.",
  EXTRAS_BUSY: "The customer is approving an extra right now. Try again in a few minutes.",
} as const;

const BLOCK_TEXT: Record<JobCompleteBlock, string> = {
  ALREADY_COMPLETE: "This job is already marked complete.",
  NOT_CONFIRMED: "Only a confirmed booking can be marked complete.",
  PRODUCT_QUOTE: "Custom products are marked delivered, not complete.",
  NOT_STARTED: "The job hasn't started yet.",
  BALANCE_NOT_HELD: "The balance isn't on hold on the customer's card yet, so the job can't be completed. You can cancel and keep the deposit, or wait for the customer to update their card.",
};

/**
 * Job complete for a quote booking: charges the held balance (balance + its fee), then moves the booking to
 * completed and opens the 6 hour Confirm or Report window (4b-1). The vendor's share of the balance stays with
 * Outsyde until the window decides it (quoteWindow.ts); the points wait too. The caller checks who may do it.
 */
export async function completeQuoteJob(appointmentId: string, actor: { userId: string; via: "owner" | "staff" | "auto" }, now = new Date()): Promise<CompleteResult> {
  const appt = await storage.getAppointment(appointmentId);
  if (!appt?.quoteId) return { ok: false, status: 404, code: "NOT_FOUND", message: "Booking not found" };
  const [q] = await db.select().from(quotes).where(eq(quotes.id, appt.quoteId));
  let job = await quoteJobFor(appointmentId);
  if (!job && q && appt.status === BOOKING_STATES.CONFIRMED) job = await ensureQuoteJob(q, appt, now);
  const block = jobCompleteBlocker({
    status: appt.status, quoteKind: q?.kind ?? null, startsAt: job ? new Date(job.startsAt) : q?.startsAt ? new Date(q.startsAt) : null,
    balanceStatus: job ? (job.balanceStatus === "none" ? null : job.balanceStatus) : null, completedAt: job?.completedAt ? new Date(job.completedAt) : null,
  }, now);
  if (block) return { ok: false, status: block === "NOT_CONFIRMED" ? 400 : 409, code: block, message: BLOCK_TEXT[block] };
  // Step 4b-2b (E3): approved extras must be held first.
  const { extrasBlockFor, captureExtrasAtComplete } = await import("./quoteExtras");
  const xBlock = await extrasBlockFor(appointmentId, now);
  if (xBlock) return { ok: false, status: 409, code: xBlock, message: EXTRAS_BLOCK_TEXT[xBlock] };

  let capturedCents = 0;
  if (job && job.balanceStatus !== "none") { // held, a capture in doubt, or charged already: the capture reads Stripe first
    const c = await captureBalance(appointmentId);
    if (!c.ok) return { ok: false, status: c.code === "CAPTURE_FAILED" ? 502 : 409, code: c.code, message: c.message };
    capturedCents = c.capturedCents;
  }
  // The extras with it (B1): one charge. One that can't be charged becomes Pay for extras; the job still completes.
  const extrasCapturedCents = (await captureExtrasAtComplete(appointmentId)).capturedCents;
  const { transitionAppointmentState } = await import("../bookingStateMachine");
  const t = await transitionAppointmentState(appointmentId, BOOKING_STATES.COMPLETED, {
    triggeredBy: actor.userId, triggerSource: actor.via === "auto" ? "system" : "api", metadata: { action: actor.via === "auto" ? "quote_auto_complete" : "quote_job_complete" },
  } as any);
  if (!t.success) {
    const cur = await storage.getAppointment(appointmentId);
    if (cur?.status !== BOOKING_STATES.COMPLETED) {
      console.error(`[quote balance] JOB COMPLETE: balance captured but booking ${appointmentId} could not move to completed (${(t as any).code}); now ${cur?.status}`);
      return { ok: false, status: 409, code: "NOT_CONFIRMED", message: BLOCK_TEXT.NOT_CONFIRMED };
    }
  }
  const pointsReleased = 0;
  if (job) await finishJobComplete(appt, job, capturedCents, actor, now);
  // Same aftercare email as the existing complete route (best effort).
  try {
    const client = await storage.getUser(appt.clientId);
    const business = await storage.getBusiness(appt.businessId);
    if (client?.email) {
      const { sendAftercareEmail } = await import("../emailService");
      const { realName } = await import("../personName");
      await sendAftercareEmail({
        toEmail: client.email, customerName: realName(client) ?? client.email, serviceName: appt.serviceName ?? "your service",
        businessName: business?.name ?? "", loyaltyPointsEarned: pointsReleased || undefined,
      });
    }
  } catch (err) {
    console.error(`[quote balance] aftercare email failed for ${appointmentId}:`, err);
  }
  return { ok: true, pointsReleased, capturedCents, extrasCapturedCents };
}

/**
 * After the booking moved to completed: the Job complete time and the 6 hour window, the balance's points (pending,
 * on what was charged; B8: the deposit's points wait too) and the customer's card. Safe to run again: the window
 * job repairs a booking that moved to completed while these steps never ran (review I4).
 */
export async function finishJobComplete(appt: Appointment, job: QuoteJob, capturedCents: number, actor: { userId: string; via: "owner" | "staff" | "auto" }, now = new Date()): Promise<void> {
  const { windowEndsAt } = await import("./quoteWindowRules");
  await db.update(quoteJobs).set({ completedAt: now, completedBy: actor.userId, completedVia: actor.via, windowEndsAt: windowEndsAt(now), updatedAt: now })
    .where(and(eq(quoteJobs.id, job.id), sql`${quoteJobs.completedAt} IS NULL`));
  if (capturedCents > 0) {
    try {
      const { createPending, pointsForGrossCents } = await import("../loyaltyLedger");
      await createPending({
        userId: appt.clientId, points: pointsForGrossCents(capturedCents), dollarAmountCents: capturedCents, transactionType: "business_transaction",
        referenceType: "quote_balance", referenceId: job.id, releaseAfter: null, businessId: appt.businessId, description: "Points earned on your balance",
      });
    } catch (err) {
      console.error(`[quote balance] balance points failed for ${appt.id}:`, err);
    }
  }
  const { afterJobComplete } = await import("./quoteWindow");
  await afterJobComplete(appt.id).catch((err) => console.error(`[quote balance] job complete card failed for ${appt.id}:`, err));
}

// ─── Webhook ────────────────────────────────────────────────────────────────

/**
 * Stripe events for a balance PaymentIntent (metadata.type quote_balance). Returns true when handled, so the
 * appointment branches never see it.
 *   amount_capturable_updated: an "Update your card" payment (or a hold whose reply was lost) is now held.
 *   succeeded: a capture whose reply was lost.
 *   canceled: Stripe let the hold go (expired, or the dashboard) while we thought it held: not held any more.
 */
export async function handleBalanceEvent(kind: "capturable" | "succeeded" | "canceled", pi: any): Promise<boolean> {
  if (pi?.metadata?.type !== BALANCE_PI_TYPE) return false;
  const apptId = pi.metadata.appointmentId;
  if (!apptId) return true;
  if (kind === "capturable" && pi.status === "requires_capture") {
    const [done] = await rows<{ id: string }>(sql`
      UPDATE quote_jobs SET balance_status = 'held', stripe_payment_intent_id = ${pi.id}, held_at = now(), retry_at = NULL, last_error = NULL, updated_at = now()
       WHERE appointment_id = ${apptId} AND balance_status IN ('hold_failed', 'holding', 'scheduled')
         AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = ${pi.id}) RETURNING id`);
    if (done) {
      const job = await quoteJobFor(apptId);
      if (job) await postBalanceCard(job, "balance_held");
    } else {
      const job = await quoteJobFor(apptId);
      if (job?.stripePaymentIntentId !== pi.id) await letGoOfStrayHold(pi, `not the payment on booking ${apptId}`);
    }
  } else if (kind === "succeeded") {
    await rows(sql`
      UPDATE quote_jobs SET balance_status = 'captured', stripe_charge_id = ${chargeIdOf(pi)}, captured_cents = ${Number(pi.amount_received ?? 0)}::int,
             captured_at = COALESCE(captured_at, now()), payout_status = CASE WHEN payout_status = 'none' THEN 'held' ELSE payout_status END, updated_at = now()
       WHERE appointment_id = ${apptId} AND stripe_payment_intent_id = ${pi.id} AND balance_status IN ('held', 'capturing')`);
  } else if (kind === "canceled") {
    await rows(sql`
      UPDATE quote_jobs SET balance_status = 'hold_failed', retry_at = NULL, last_error = 'hold canceled at Stripe', updated_at = now()
       WHERE appointment_id = ${apptId} AND stripe_payment_intent_id = ${pi.id} AND balance_status = 'held'`);
    const job = await quoteJobFor(apptId);
    if (job?.balanceStatus === "hold_failed") await postBalanceCard(job, "balance_failed");
  }
  return true;
}

// ─── Update your card ───────────────────────────────────────────────────────

export type NewCardResult = { ok: true; pi: any } | { ok: false; status: number; code: string; message: string };

/**
 * The customer pays the balance hold with a new card (after the hold failed). A manual capture PaymentIntent the
 * app or web confirms on session, saved for later off session use. One per try: a second tap returns the same
 * unfinished payment (deterministic key), never a second hold. The webhook (amount_capturable_updated) marks it held.
 */
export async function startNewCardPayment(appointmentId: string, customerId: string): Promise<NewCardResult> {
  const job = await quoteJobFor(appointmentId);
  const appt = await storage.getAppointment(appointmentId);
  if (!job || !appt || appt.status !== BOOKING_STATES.CONFIRMED) return { ok: false, status: 409, code: "NOT_CONFIRMED", message: "This booking can't take a payment now." };
  if (job.balanceStatus === "hold_failed" && job.retryAt) {
    return { ok: false, status: 409, code: "RETRY_PENDING", message: "We'll try your card again before the job. If that doesn't work, you can add a new card." };
  }
  if (job.balanceStatus !== "hold_failed") {
    return { ok: false, status: 409, code: job.balanceStatus === "held" || job.balanceStatus === "captured" ? "ALREADY_HELD" : "NOT_NEEDED", message: job.balanceStatus === "held" ? "The balance is already on hold on your card." : "Nothing to pay right now." };
  }
  const stripe: any = await getUncachableStripeClient();
  if (job.stripePaymentIntentId) {
    const cur: any = await stripe.paymentIntents.retrieve(job.stripePaymentIntentId, {}, BOUND).catch(() => null);
    if (cur && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(cur.status)) return { ok: true, pi: cur };
    if (cur?.status === "requires_capture") {
      await handleBalanceEvent("capturable", cur);
      return { ok: false, status: 409, code: "ALREADY_HELD", message: "The balance is already on hold on your card." };
    }
  }
  const [q] = await db.select().from(quotes).where(eq(quotes.id, job.quoteId));
  const pi = await stripe.paymentIntents.create({
    amount: job.holdCents,
    currency: "usd",
    customer: customerId,
    capture_method: "manual",
    setup_future_usage: "off_session",
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { type: BALANCE_PI_TYPE, appointmentId, quoteId: job.quoteId, businessId: job.businessId, newCard: "true" },
    description: `Balance for ${q?.title ?? "your booking"}`.slice(0, 450),
  }, { idempotencyKey: `quote_balance_card_${appointmentId}_${job.attempts}`, ...BOUND });
  await rows(sql`
    UPDATE quote_jobs SET stripe_payment_intent_id = ${pi.id}, attempts = attempts + 1, updated_at = now()
     WHERE id = ${job.id} AND balance_status = 'hold_failed' AND attempts = ${job.attempts}`);
  return { ok: true, pi };
}

// ─── The job (every 5 minutes, with the quote expiry job) ───────────────────

export async function runQuoteBalanceJob(now = new Date()): Promise<{ holds: number; completed: number; released: number }> {
  let holds = 0, completed = 0, released = 0;
  // Review I6: a hold released for a cancel that never went through (the booking is still confirmed): hold again.
  await rows(sql`
    UPDATE quote_jobs j SET balance_status = 'scheduled', hold_at = ${now}, retry_at = NULL, released_at = NULL, updated_at = now()
      FROM appointments a
     WHERE a.id = j.appointment_id AND a.status = 'confirmed' AND j.balance_status = 'released' AND j.completed_at IS NULL
       AND j.released_at < now() - interval '2 minutes' AND j.starts_at + make_interval(mins => j.duration_minutes) > ${now}`);
  // Holds and retries due (and stale claims), only for confirmed bookings.
  const due = await rows<{ id: string }>(sql`
    SELECT j.id FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id AND a.status = 'confirmed'
     WHERE (j.balance_status = 'scheduled' AND j.hold_at <= ${now})
        OR (j.balance_status = 'hold_failed' AND j.retry_at IS NOT NULL AND j.retry_at <= ${now})
        OR (j.balance_status = 'holding' AND j.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
     ORDER BY j.hold_at LIMIT 25`);
  for (const d of due) {
    try { if ((await placeBalanceHold(d.id, now)) === "held") holds++; } catch (err) { console.error(`[quote balance] hold failed for job ${d.id}:`, err); }
  }
  // Auto complete 2 h after the scheduled end (only when nothing is left to decide: paid in full or balance held).
  const ready = await rows<{ appointment_id: string }>(sql`
    SELECT j.appointment_id FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id AND a.status = 'confirmed'
     WHERE j.completed_at IS NULL AND j.auto_complete_at <= ${now}
       AND (j.balance_status IN ('none', 'held', 'captured') OR (j.balance_status = 'capturing' AND j.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     ORDER BY j.auto_complete_at LIMIT 25`);
  for (const r of ready) {
    try { if ((await completeQuoteJob(r.appointment_id, { userId: "system", via: "auto" }, now)).ok) completed++; }
    catch (err) { console.error(`[quote balance] auto complete failed for ${r.appointment_id}:`, err); }
  }
  // Safety net: a booking that ended by a path that skipped the release (or a stale capture claim on one).
  const ended = await rows<{ appointment_id: string }>(sql`
    SELECT j.appointment_id FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id
     WHERE a.status NOT IN ('confirmed', 'completed') AND j.balance_status IN ('scheduled', 'hold_failed', 'held') LIMIT 25`);
  for (const e of ended) {
    try { if ((await settleBalanceOnCancel(e.appointment_id, 0)).ok) released++; } catch (err) { console.error(`[quote balance] release failed for ${e.appointment_id}:`, err); }
  }
  // Review I5: a claim that never finished (crash, lost reply) on a booking that ended: settle it from Stripe.
  const stuck = await rows<{ id: string }>(sql`
    SELECT j.id FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id
     WHERE ((a.status NOT IN ('confirmed', 'completed') AND j.balance_status IN ('holding', 'releasing', 'capturing')) OR j.balance_status = 'releasing')
       AND j.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES}) LIMIT 25`);
  for (const st of stuck) {
    try { if (await settleStuckClaim(st.id)) released++; } catch (err) { console.error(`[quote balance] stuck claim ${st.id} failed:`, err); }
  }
  return { holds, completed, released };
}

/** A stale hold, release or capture claim on an ended booking: read Stripe and finish it. Never charges. */
async function settleStuckClaim(jobId: string): Promise<boolean> {
  const tag = randomUUID();
  const [j] = await rows<any>(sql`
    UPDATE quote_jobs SET claim_tag = ${tag}, updated_at = now()
     WHERE id = ${jobId} AND balance_status IN ('holding', 'releasing', 'capturing') AND updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})
     RETURNING *`);
  if (!j) return false;
  const stripe: any = await getUncachableStripeClient();
  let pi: any = j.stripe_payment_intent_id ? await stripe.paymentIntents.retrieve(j.stripe_payment_intent_id, {}, BOUND) : null;
  if (!pi && j.stripe_customer_id) pi = await findEarlierHold(stripe, j.stripe_customer_id, j.appointment_id, Math.floor(new Date(j.created_at).getTime() / 1000) - 3600);
  if (pi?.status === "succeeded") {
    await recordHeld(jobId, tag, pi); // charged: the refund paths take it from here
    console.error(`[quote balance] booking ${j.appointment_id} ended but its balance was charged (${pi.id}); refund it from the booking`);
    return true;
  }
  if (pi?.status === "requires_capture") await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: "requested_by_customer" }, BOUND);
  await rows(sql`UPDATE quote_jobs SET balance_status = 'released', released_at = now(), stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ${pi?.id ?? null}), updated_at = now() WHERE id = ${jobId} AND claim_tag = ${tag}`);
  return true;
}

/** Tests: the webhook already awaits the job record and an immediate hold; nothing is left in the background. */
export async function flushQuoteBalanceWorkForTest(): Promise<void> {}

/** The balance in the quote's JSON (additive). */
export function balanceJson(job: QuoteJob | undefined | null) {
  if (!job) return null;
  return {
    status: job.balanceStatus,
    balanceCents: job.balanceCents,
    serviceFeeCents: job.serviceFeeCents,
    holdCents: job.holdCents,
    holdAt: job.holdAt,
    heldAt: job.heldAt,
    capturedCents: job.capturedCents,
    capturedAt: job.capturedAt,
    refundedCents: job.refundedCents,
    autoCompleteAt: job.autoCompleteAt,
    completedAt: job.completedAt,
    completedVia: job.completedVia,
    needsNewCard: job.balanceStatus === "hold_failed" && job.retryAt === null,
  };
}

