/**
 * Quotes step 4b-2b (migration 102): extras. Rules: ./quoteExtrasRules.ts and fees.ts quoteExtraSplit.
 * Tables: quote_extras (one row per extra the vendor sends) and quote_extras_payments (one per booking).
 *
 * Legend 2026-11-05 (B1 to B4, E2 to E7):
 *   - The owner or the staff member who sent the quote sends extras from payment until Job complete. Only the
 *     customer's Approve adds one, and it is held on the card right then, on session, so a bad card fails there. A
 *     new approval replaces the hold with one hold for the new total (the old hold is let go once the new one stands).
 *   - More than about 6 days before the end a hold can't last: Approve checks the card without reserving money (a
 *     SetupIntent) and the hold is placed with the balance, 24 hours before, retried 12 hours before, then Update your
 *     card. Job complete waits until it is held.
 *   - Job complete charges the extras once, with the balance. Unanswered extras lapse. A hold that can't be charged
 *     (the rare backup): Pay for extras, a reminder after 24 hours, and Outsyde doesn't pay the vendor for them.
 *   - The vendor's share is paid after the 6 hour window as its own transfer (quoteWindow.payExtrasShare, group
 *     appointment_extras_<id>). Refunds come from the extras first (quoteBalance.refundQuoteBooking).
 *
 * Money safety, as in quoteBalance.ts: every Stripe call that reserves or moves money is claimed first, looks at
 * Stripe first, sends one idempotency key per try and is bounded. The extras PaymentIntent has its own metadata
 * type, `quote_extras`, never `appointment` or `quote_balance`, and never an `orderId`.
 */
import { randomUUID } from "crypto";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { quoteExtras, quoteExtrasPayments, quotes, BOOKING_STATES, type Quote, type QuoteExtra, type QuoteExtrasPayment } from "@shared/schema";
import { getUncachableStripeClient } from "../stripe/stripeClient";
import { postCardMessage } from "../messaging/postCard";
import { extraPushText } from "./quoteNoticesRules";
import { quoteExtraSplit } from "../fees";
import {
  checkExtraInput, extraCardText, extrasHoldTimes, extrasTotals, holdAtApprove, EXTRAS_CLAIM_MINUTES, MAX_EXTRAS,
  UNPAID_REMINDER_HOURS, type ExtraCardEvent,
} from "./quoteExtrasRules";

export const EXTRAS_PI_TYPE = "quote_extras";
const CLAIM_MINUTES = EXTRAS_CLAIM_MINUTES;
const BOUND = { timeout: 30_000, maxNetworkRetries: 1 } as const;

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}
const chargeIdOf = (pi: any): string | null => (typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id ?? null);
const idOf = (v: any): string | null => (typeof v === "string" ? v : v?.id ?? null);
const isCardError = (err: any) => err?.type === "StripeCardError" || err?.rawType === "card_error";
const errMsg = (err: any) => (err?.message || String(err)).slice(0, 500);
const CANCELABLE = ["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture", "processing"];

export async function extrasPaymentFor(appointmentId: string): Promise<QuoteExtrasPayment | undefined> {
  const [p] = await db.select().from(quoteExtrasPayments).where(eq(quoteExtrasPayments.appointmentId, appointmentId));
  return p;
}
export async function extrasFor(appointmentId: string): Promise<QuoteExtra[]> {
  return db.select().from(quoteExtras).where(eq(quoteExtras.appointmentId, appointmentId)).orderBy(asc(quoteExtras.createdAt));
}
async function extraById(id: string): Promise<QuoteExtra | undefined> {
  const [x] = await db.select().from(quoteExtras).where(eq(quoteExtras.id, id));
  return x;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

/** Posts an extras card. fromCustomer: sent by the customer to the quote's sender. Best effort; returns its id. */
async function postExtraCard(q: Quote, event: ExtraCardEvent, fromCustomer: boolean, o: { extra?: QuoteExtra; amountCents: number }): Promise<string | null> {
  try {
    if (await storage.isUserBlockedEitherWay(q.senderId, q.customerId)) return null;
    const business = await storage.getBusiness(q.businessId);
    const fee = o.extra ? quoteExtraSplit(o.extra.amountCents).serviceFeeCents : 0;
    const msg = await postCardMessage({
      conversationId: q.conversationId,
      senderId: fromCustomer ? q.customerId : q.senderId,
      recipientId: fromCustomer ? q.senderId : q.customerId,
      kind: "quote",
      card: {
        type: "quote", event, quoteId: q.id, version: q.version, businessId: q.businessId, appointmentId: q.appointmentId, title: q.title,
        ...(o.extra ? { extraId: o.extra.id, description: o.extra.description, amountCents: o.extra.amountCents, serviceFeeCents: fee, totalCents: o.extra.amountCents + fee } : { amountCents: o.amountCents }),
      },
      content: extraCardText(event, { businessName: business?.name ?? "", description: o.extra?.description ?? "", amountCents: o.amountCents }),
      // Step 6a call 2: the extra's push says what and how much, with the fee.
      ...(event === "extra_proposed" && o.extra ? { pushBody: extraPushText({ description: o.extra.description, totalCents: o.extra.amountCents + fee }) } : {}),
    });
    return msg.id;
  } catch (err) {
    console.error(`[quote extras] ${event} card failed for ${q.id}:`, err);
    return null;
  }
}
async function quoteOf(id: string): Promise<Quote | undefined> {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
  return q;
}
/** A payment card once (the notice column is the claim). */
async function postPaymentCardOnce(p: QuoteExtrasPayment, event: "extras_failed" | "extras_hold_failed"): Promise<void> {
  const [first] = await rows<{ id: string }>(sql`
    UPDATE quote_extras_payments SET failed_notice_at = now(), updated_at = now() WHERE id = ${p.id} AND failed_notice_at IS NULL RETURNING id`);
  if (!first) return;
  const q = await quoteOf(p.quoteId);
  if (!q) return;
  await postExtraCard(q, event, false, { amountCents: p.holdCents });
  // Step 6a call 6: the business hears a card couldn't be held (no chat card reaches them for it).
  if (event === "extras_hold_failed") {
    const { noticeBusiness } = await import("./quoteNotices");
    await noticeBusiness(q, "card_failed", p.id, { amountCents: p.holdCents });
  }
}

// ─── Send, withdraw, decline ────────────────────────────────────────────────

export type ExtraResult = { ok: true; extra: QuoteExtra } | { ok: false; status: number; code: string; message: string; field?: string };

/** Why extras can't be sent or answered on this quote's booking now (null: they can). */
async function bookingOpen(q: Quote): Promise<{ status: number; code: string; message: string } | null> {
  if (q.kind !== "service" || q.status !== "paid" || !q.appointmentId) return { status: 409, code: "NOT_CONFIRMED", message: "Extras can be added once the quote is paid." };
  const appt = await storage.getAppointment(q.appointmentId);
  const { quoteJobFor } = await import("./quoteBalance");
  const job = await quoteJobFor(q.appointmentId);
  if (appt?.status === BOOKING_STATES.COMPLETED || job?.completedAt) return { status: 409, code: "ALREADY_COMPLETE", message: "The job is already marked complete." };
  if (!appt || appt.status !== BOOKING_STATES.CONFIRMED || !job) return { status: 409, code: "NOT_CONFIRMED", message: "Extras can only be added to a confirmed booking." };
  return null;
}

/** The vendor sends an extra (B3). The 10 and the quote total are checked in the same statement that adds it. */
export async function proposeExtra(q: Quote, proposedBy: string, body: unknown): Promise<ExtraResult> {
  const c = checkExtraInput(body);
  if (!c.ok) return { ok: false, status: 400, code: "INVALID", message: c.message, field: c.field };
  const closed = await bookingOpen(q);
  if (closed) return { ok: false, ...closed };
  const apptId = q.appointmentId!;
  await rows(sql`
    INSERT INTO quote_extras_payments (appointment_id, quote_id, business_id, client_id) VALUES (${apptId}, ${q.id}, ${q.businessId}, ${q.customerId})
    ON CONFLICT (appointment_id) DO NOTHING`);
  // Checked in the statement that adds it. Two sends in the same instant could still both pass; Approve checks the
  // limits again under its claim, so what is held and charged never passes them.
  const [x] = await rows<{ id: string; why: string | null }>(sql`
    WITH live AS (SELECT count(*)::int AS n, COALESCE(SUM(amount_cents), 0)::int AS total FROM quote_extras
              WHERE appointment_id = ${apptId} AND status IN ('proposed', 'approving', 'approved')),
    ins AS (
      INSERT INTO quote_extras (appointment_id, quote_id, business_id, customer_id, proposed_by, description, amount_cents)
      SELECT ${apptId}, ${q.id}, ${q.businessId}, ${q.customerId}, ${proposedBy}, ${c.value.description}, ${c.value.amountCents}::int FROM live
       WHERE live.n < ${MAX_EXTRAS} AND live.total + ${c.value.amountCents}::int <= ${q.totalCents}::int
      RETURNING id)
    SELECT (SELECT id FROM ins) AS id, (SELECT CASE WHEN n >= ${MAX_EXTRAS} THEN 'TOO_MANY' ELSE 'OVER_TOTAL' END FROM live) AS why`);
  if (!x?.id) {
    const code = x?.why === "TOO_MANY" ? "TOO_MANY" : "OVER_TOTAL";
    return { ok: false, status: 409, code, message: code === "TOO_MANY" ? `A booking can have up to ${MAX_EXTRAS} extras.` : "All extras together can be up to the quote total." };
  }
  const extra = (await extraById(x.id))!;
  const msgId = await postExtraCard(q, "extra_proposed", false, { extra, amountCents: extra.amountCents });
  if (msgId) await rows(sql`UPDATE quote_extras SET message_id = ${msgId} WHERE id = ${extra.id}`);
  // Step 6a calls 3 and 4: the customer's Activity row and email.
  const { noticeExtraProposed } = await import("./quoteNotices");
  await noticeExtraProposed(q, extra);
  return { ok: true, extra: (await extraById(x.id))! };
}

const NOT_OPEN = { status: 409, code: "NOT_OPEN", message: "This extra was already answered." };

/** The vendor takes back an extra the customer hasn't answered. */
export async function withdrawExtra(q: Quote, extraId: string): Promise<ExtraResult> {
  const [x] = await rows<{ id: string }>(sql`
    UPDATE quote_extras SET status = 'withdrawn', answered_at = now(), updated_at = now()
     WHERE id = ${extraId} AND quote_id = ${q.id} AND status = 'proposed' RETURNING id`);
  if (!x) return (await extraById(extraId))?.quoteId === q.id ? { ok: false, ...NOT_OPEN } : { ok: false, status: 404, code: "NOT_FOUND", message: "Extra not found" };
  const extra = (await extraById(extraId))!;
  await postExtraCard(q, "extra_withdrawn", false, { extra, amountCents: extra.amountCents });
  const { closeExtraNotice } = await import("./quoteNotices");
  await closeExtraNotice(extraId);
  return { ok: true, extra };
}

/** The customer declines an extra. Nothing is added. */
export async function declineExtra(q: Quote, extraId: string): Promise<ExtraResult> {
  const [x] = await rows<{ id: string; prev_intent: string | null }>(sql`
    UPDATE quote_extras e SET status = 'declined', answered_at = now(), approve_intent_id = NULL, updated_at = now()
      FROM (SELECT id, approve_intent_id AS prev_intent FROM quote_extras WHERE id = ${extraId}) p
     WHERE e.id = p.id AND e.quote_id = ${q.id} AND e.status IN ('proposed', 'approving') RETURNING e.id, p.prev_intent`);
  if (!x) return (await extraById(extraId))?.quoteId === q.id ? { ok: false, ...NOT_OPEN } : { ok: false, status: 404, code: "NOT_FOUND", message: "Extra not found" };
  if (x.prev_intent) await letGoOfIntent(x.prev_intent, "declined while approving");
  const extra = (await extraById(extraId))!;
  await postExtraCard(q, "extra_declined", true, { extra, amountCents: extra.amountCents });
  const { closeExtraNotice, noticeBusiness } = await import("./quoteNotices");
  await closeExtraNotice(extraId);
  await noticeBusiness(q, "extra_declined", extraId, { description: extra.description, amountCents: extra.amountCents });
  return { ok: true, extra };
}

// ─── Stripe helpers ─────────────────────────────────────────────────────────

/** Lets go of a PaymentIntent or SetupIntent nothing should keep (a replaced hold, a lapsed approve). Never throws. */
async function letGoOfIntent(intentId: string, why: string): Promise<boolean> {
  try {
    const stripe: any = await getUncachableStripeClient();
    if (intentId.startsWith("seti_")) {
      const si: any = await stripe.setupIntents.retrieve(intentId, {}, BOUND);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(si?.status)) await stripe.setupIntents.cancel(intentId, {}, BOUND);
      return true;
    }
    const pi: any = await stripe.paymentIntents.retrieve(intentId, {}, BOUND);
    if (CANCELABLE.includes(pi?.status)) await stripe.paymentIntents.cancel(intentId, { cancellation_reason: "abandoned" }, BOUND);
    return true;
  } catch (err) {
    console.error(`[quote extras] could not let go of ${intentId} (${why}):`, err);
    return false;
  }
}

/** Lets go of a replaced hold recorded on the payment (release_pi), then clears it. */
async function releaseReplaced(paymentId: string): Promise<boolean> {
  const [p] = await rows<{ release_pi: string | null }>(sql`SELECT release_pi FROM quote_extras_payments WHERE id = ${paymentId}`);
  if (!p?.release_pi) return true;
  if (!(await letGoOfIntent(p.release_pi, "replaced by a new hold"))) return false;
  await rows(sql`UPDATE quote_extras_payments SET release_pi = NULL, updated_at = now() WHERE id = ${paymentId} AND release_pi = ${p.release_pi}`);
  return true;
}

/** The card and customer the deposit was paid with. */
async function depositCard(appointmentId: string): Promise<{ customerId: string | null; paymentMethodId: string | null }> {
  const appt = await storage.getAppointment(appointmentId);
  const user = appt ? await storage.getUser(appt.clientId) : undefined;
  let customerId: string | null = user?.stripeCustomerId ?? null;
  let paymentMethodId: string | null = null;
  if (appt?.stripePaymentIntentId) {
    const stripe: any = await getUncachableStripeClient();
    const dep: any = await stripe.paymentIntents.retrieve(appt.stripePaymentIntentId, {}, BOUND);
    paymentMethodId = idOf(dep?.payment_method);
    customerId = idOf(dep?.customer) ?? customerId;
  }
  return { customerId, paymentMethodId };
}

/** An earlier Approve try for this extra that reached Stripe (its reply lost), found by metadata. */
async function findApproveIntent(stripe: any, customerId: string, extraId: string, setup: boolean): Promise<any | null> {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const list = setup
    ? await stripe.setupIntents.list({ customer: customerId, created: { gte: since }, limit: 100 }, BOUND)
    : await stripe.paymentIntents.list({ customer: customerId, created: { gte: since }, limit: 100 }, BOUND);
  return (list?.data ?? []).find((i: any) => i?.metadata?.extraId === extraId && !["canceled"].includes(i.status)) ?? null;
}

// ─── Approve ────────────────────────────────────────────────────────────────

export type ApproveResult =
  | { ok: true; status: "approved"; extra: QuoteExtra }
  | { ok: true; status: "needs_action"; extra: QuoteExtra; intentType: "payment" | "setup"; clientSecret: string; intentId: string; customerId: string | null }
  | { ok: false; status: number; code: string; message: string };

const BUSY = { ok: false as const, status: 409, code: "BUSY", message: "We're still checking your card. Try again in a few minutes." };
const DECLINED = { ok: false as const, status: 402, code: "CARD_DECLINED", message: "Your card was declined, so the extra wasn't added. Try again with another card." };
const TRY_AGAIN = { ok: false as const, status: 409, code: "TRY_AGAIN", message: "Something changed while you approved. Approve the extra again." };
const STRIPE_DOWN = { ok: false as const, status: 502, code: "TRY_AGAIN", message: "We couldn't reach the card network. Try again in a minute." };

/**
 * The extras payment's one lock (review C1, C2): every Approve finish, Update your card and Pay for extras runs
 * under it, and the far out hold, the Job complete charge and the cancel release refuse to start while it is live
 * (they each move the status out of the set this claim accepts, so the two never overlap).
 */
async function claimPayment(appointmentId: string, statuses: readonly string[]): Promise<{ tag: string; row: any } | null> {
  const tag = randomUUID();
  const [row] = await rows<any>(sql`
    UPDATE quote_extras_payments SET approve_claim_tag = ${tag}, approve_claimed_at = now(), updated_at = now()
     WHERE appointment_id = ${appointmentId} AND status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})
       AND (approve_claimed_at IS NULL OR approve_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
     RETURNING *`);
  return row ? { tag, row } : null;
}
async function unclaimPayment(appointmentId: string, tag: string): Promise<void> {
  await rows(sql`UPDATE quote_extras_payments SET approve_claim_tag = NULL, approve_claimed_at = NULL WHERE appointment_id = ${appointmentId} AND approve_claim_tag = ${tag}`);
}
const APPROVABLE = ["none", "scheduled", "held", "hold_failed"] as const;

type Finish = "approved" | "gone" | "retry";
const isSetupIntent = (i: any) => i?.object === "setup_intent" || String(i?.id ?? "").startsWith("seti_");

/**
 * Makes an approval stand from an intent that went through (requires_capture for a hold, succeeded for a card
 * check). Runs only under the payment claim `tag`. One statement: the extra and the payment's new totals change
 * together, only while the claim is ours and the payment can take it. The hold it replaces is let go after.
 *   approved: it stands (or already stood on this same intent: nothing is let go).
 *   retry: the intent was for an old total; let go, the extra is open again.
 *   gone: the extra can no longer be approved; the intent was let go.
 */
async function finishApproval(extraId: string, intent: any, tag: string): Promise<Finish> {
  const extra = await extraById(extraId);
  if (!extra) { await letGoOfIntent(intent.id, `extra ${extraId} is gone`); return "gone"; }
  const p0 = await extrasPaymentFor(extra.appointmentId);
  if (extra.status === "approved" && (isSetupIntent(intent) || p0?.stripePaymentIntentId === intent.id)) return "approved";
  if (!["proposed", "approving"].includes(extra.status)) { await letGoOfIntent(intent.id, `extra ${extraId} is ${extra.status}`); return "gone"; }
  const approved = (await extrasFor(extra.appointmentId)).filter((x) => x.status === "approved" && x.id !== extraId).map((x) => x.amountCents);
  const t = extrasTotals([...approved, extra.amountCents]);
  const isSetup = isSetupIntent(intent);
  if (isSetup && p0?.status === "held") {
    // A card check can't raise a hold already on the card (the total would pass what is held): approve again.
    await letGoOfIntent(intent.id, "a card check while the extras are held");
    await rows(sql`UPDATE quote_extras SET status = 'proposed', approve_intent_id = NULL, updated_at = now() WHERE id = ${extraId} AND status = 'approving'`);
    return "retry";
  }
  if (!isSetup && Number(intent.amount) !== t.holdCents) {
    await letGoOfIntent(intent.id, `amount ${intent.amount} is not the new total ${t.holdCents}`);
    await rows(sql`UPDATE quote_extras SET status = 'proposed', approve_intent_id = NULL, updated_at = now() WHERE id = ${extraId} AND status = 'approving'`);
    return "retry";
  }
  let holdAt: Date | null = null, retryAt: Date | null = null;
  if (isSetup) {
    const { quoteJobFor } = await import("./quoteBalance");
    const job = await quoteJobFor(extra.appointmentId);
    const times = extrasHoldTimes(job ? new Date(job.startsAt) : new Date(), new Date());
    holdAt = times.holdAt; retryAt = times.retryAt;
  }
  const pm = idOf(intent.payment_method);
  const cus = idOf(intent.customer);
  const [done] = await rows<{ id: string }>(sql`
    WITH e AS (
      UPDATE quote_extras SET status = 'approved', answered_at = now(), approve_intent_id = NULL, updated_at = now()
       WHERE id = ${extraId} AND status IN ('proposed', 'approving')
         AND EXISTS (SELECT 1 FROM quote_extras_payments WHERE appointment_id = ${extra.appointmentId} AND approve_claim_tag = ${tag} AND status IN ('none', 'scheduled', 'held', 'hold_failed'))
      RETURNING appointment_id)
    UPDATE quote_extras_payments p SET
      approved_cents = ${t.approvedCents}::int, fee_cents = ${t.feeCents}::int, platform_fee_cents = ${t.platformFeeCents}::int,
      vendor_net_cents = ${t.vendorNetCents}::int, hold_cents = ${t.holdCents}::int,
      status = CASE WHEN ${isSetup} THEN 'scheduled' ELSE 'held' END,
      release_pi = CASE WHEN NOT ${isSetup} AND p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id <> ${intent.id} THEN p.stripe_payment_intent_id ELSE p.release_pi END,
      stripe_payment_intent_id = CASE WHEN ${isSetup} THEN p.stripe_payment_intent_id ELSE ${intent.id} END,
      held_cents = CASE WHEN ${isSetup} THEN p.held_cents ELSE ${t.holdCents}::int END,
      held_at = CASE WHEN ${isSetup} THEN p.held_at ELSE now() END,
      hold_at = CASE WHEN ${isSetup} THEN ${holdAt}::timestamptz ELSE NULL END,
      retry_at = CASE WHEN ${isSetup} THEN ${retryAt}::timestamptz ELSE NULL END,
      stripe_customer_id = COALESCE(${cus}, p.stripe_customer_id), payment_method_id = COALESCE(${pm}, p.payment_method_id),
      failed_notice_at = NULL, last_error = NULL, updated_at = now()
      FROM e WHERE p.appointment_id = e.appointment_id AND p.approve_claim_tag = ${tag} AND p.status IN ('none', 'scheduled', 'held', 'hold_failed')
    RETURNING p.id`);
  if (!done) {
    await letGoOfIntent(intent.id, `extra ${extraId} could not be added now`);
    await rows(sql`UPDATE quote_extras SET status = 'proposed', approve_intent_id = NULL, updated_at = now() WHERE id = ${extraId} AND status = 'approving'`);
    return "gone";
  }
  await releaseReplaced(done.id);
  const fresh = (await extraById(extraId))!;
  const q = await quoteOf(fresh.quoteId);
  if (q) await postExtraCard(q, "extra_approved", true, { extra: fresh, amountCents: fresh.amountCents });
  const { closeExtraNotice, noticeBusiness } = await import("./quoteNotices");
  await closeExtraNotice(extraId);
  if (q) await noticeBusiness(q, "extra_approved", extraId, { description: fresh.description, amountCents: fresh.amountCents });
  return "approved";
}

/** Finishes an Approve left waiting on 3D Secure (the Stripe event or the job), under the claim. Busy: later. */
async function finishWaiting(extraId: string, intent: any): Promise<Finish | "busy"> {
  const x = await extraById(extraId);
  if (!x) return "gone";
  const c = await claimPayment(x.appointmentId, APPROVABLE);
  if (!c) return "busy";
  try { return await finishApproval(extraId, intent, c.tag); } finally { await unclaimPayment(x.appointmentId, c.tag); }
}

/**
 * The customer approves an extra (B1). Near the job: a hold for the new total on the deposit's card, on session.
 * Far out: a card check that reserves nothing. A card that needs the customer (3D Secure) returns the secret to
 * finish in the app; the approval stands when it goes through (this call again, the Stripe event, or the job).
 * newCard: pay with a different card in the payment sheet.
 */
export async function approveExtra(q: Quote, extraId: string, opts: { newCard?: boolean } = {}, now = new Date()): Promise<ApproveResult> {
  const extra0 = await extraById(extraId);
  if (!extra0 || extra0.quoteId !== q.id) return { ok: false, status: 404, code: "NOT_FOUND", message: "Extra not found" };
  // Already approved (the Stripe event finished it first, or a second tap): that is the answer.
  if (extra0.status === "approved") return { ok: true, status: "approved", extra: extra0 };
  if (!["proposed", "approving"].includes(extra0.status)) return { ok: false, ...NOT_OPEN };
  const closed = await bookingOpen(q);
  if (closed) return { ok: false, ...closed };
  const apptId = q.appointmentId!;
  const c = await claimPayment(apptId, APPROVABLE);
  if (!c) {
    const p = await extrasPaymentFor(apptId);
    if (p && ["capturing", "captured", "unpaid"].includes(p.status)) return { ok: false, status: 409, code: "ALREADY_COMPLETE", message: "The job is already marked complete." };
    return BUSY;
  }
  const tag = c.tag;
  const claimed = c.row;
  const unclaim = () => unclaimPayment(apptId, tag);
  const note = async (msg: string) => { await rows(sql`UPDATE quote_extras_payments SET last_error = ${msg.slice(0, 500)}, updated_at = now() WHERE appointment_id = ${apptId} AND approve_claim_tag = ${tag}`); };
  const result = (f: Finish): ApproveResult | Promise<ApproveResult> => f === "approved"
    ? extraById(extraId).then((x) => ({ ok: true as const, status: "approved" as const, extra: x! }))
    : f === "retry" ? TRY_AGAIN : { ok: false, ...NOT_OPEN };
  const stripe: any = await getUncachableStripeClient();
  let keepClaim = false;
  try {
    // The booking must still be open under the claim (Job complete or a cancel may have started meanwhile).
    const [still] = await rows(sql`
      SELECT 1 AS x FROM appointments a JOIN quote_jobs j ON j.appointment_id = a.id WHERE a.id = ${apptId} AND a.status = 'confirmed' AND j.completed_at IS NULL`);
    if (!still) return { ok: false, status: 409, code: "NOT_CONFIRMED", message: "Extras can only be added to a confirmed booking." };
    // A hold this one would replace that wasn't let go yet: let it go first, so only one is ever left over.
    if (claimed.release_pi && !(await releaseReplaced(claimed.id))) return BUSY;
    // Another extra half approved (3D Secure never finished): this approval replaces it; it goes back to open.
    const others = await rows<{ id: string; approve_intent_id: string | null }>(sql`
      UPDATE quote_extras e SET status = 'proposed', approve_intent_id = NULL, updated_at = now()
        FROM (SELECT id, approve_intent_id FROM quote_extras WHERE appointment_id = ${apptId} AND status = 'approving' AND id <> ${extraId}) p
       WHERE e.id = p.id AND e.status = 'approving' RETURNING e.id, p.approve_intent_id`);
    for (const o of others) if (o.approve_intent_id) await letGoOfIntent(o.approve_intent_id, "another extra was approved");

    let extra = (await extraById(extraId))!;
    if (extra.status === "approved") return { ok: true, status: "approved", extra };
    // This extra's own earlier try: finish it if it went through, return it again if it still needs the customer.
    if (extra.status === "approving" && extra.approveIntentId) {
      const id = extra.approveIntentId;
      let cur: any;
      try { cur = id.startsWith("seti_") ? await stripe.setupIntents.retrieve(id, {}, BOUND) : await stripe.paymentIntents.retrieve(id, {}, BOUND); }
      catch (err) { await note(`lookup: ${errMsg(err)}`); return STRIPE_DOWN; }
      if (cur?.status === "requires_capture" || (isSetupIntent(cur) && cur?.status === "succeeded")) return result(await finishApproval(extraId, cur, tag));
      if (cur?.status === "requires_action" || cur?.status === "processing" || (cur?.metadata?.newCard === "true" && cur?.status === "requires_payment_method")) {
        if (cur.status === "processing") return BUSY;
        return { ok: true, status: "needs_action", extra, intentType: id.startsWith("seti_") ? "setup" : "payment", clientSecret: cur.client_secret, intentId: id, customerId: idOf(cur.customer) };
      }
      await letGoOfIntent(id, "an earlier approve that didn't go through");
      await rows(sql`UPDATE quote_extras SET status = 'proposed', approve_intent_id = NULL, updated_at = now() WHERE id = ${extraId} AND status = 'approving'`);
      extra = (await extraById(extraId))!;
    }

    const { quoteJobFor } = await import("./quoteBalance");
    const job = await quoteJobFor(apptId);
    // Extras already on hold are always replaced by a hold (a card check can't raise what is held).
    const near = claimed.status === "held" || holdAtApprove(new Date(job!.autoCompleteAt), now);
    const approvedAmounts = (await extrasFor(apptId)).filter((x) => x.status === "approved").map((x) => x.amountCents);
    // The limits again, under the claim (one Approve at a time per booking): what is charged never passes them.
    if (approvedAmounts.length >= MAX_EXTRAS || approvedAmounts.reduce((n, a) => n + a, 0) + extra.amountCents > q.totalCents) {
      return { ok: false, status: 409, code: "OVER_TOTAL", message: "All extras together can be up to the quote total." };
    }
    const total = extrasTotals([...approvedAmounts, extra.amountCents]);
    let card: { customerId: string | null; paymentMethodId: string | null };
    try { card = await depositCard(apptId); } catch (err) { await note(`deposit lookup: ${errMsg(err)}`); return STRIPE_DOWN; }
    if (!card.customerId) return { ok: false, status: 409, code: "NO_CUSTOMER", message: "Open the quote again to approve." };
    const useSaved = !opts.newCard && !!card.paymentMethodId;
    const metadata = { type: EXTRAS_PI_TYPE, appointmentId: apptId, quoteId: q.id, businessId: q.businessId, extraId, ...(near ? {} : { check: "true" }) };

    // A try whose reply was lost: use what reached Stripe. A failed lookup decides nothing.
    let intent: any;
    try { intent = await findApproveIntent(stripe, card.customerId, extraId, !near); }
    catch (err) { await note(`lookup: ${errMsg(err)}`); return STRIPE_DOWN; }
    const reuse = !!intent && (
      (!near && intent.status === "succeeded")
      || (near && intent.status === "requires_capture" && Number(intent.amount) === total.holdCents)
      || (intent.status === "requires_action" && (near ? Number(intent.amount) === total.holdCents : true))
      || (!!opts.newCard && intent.metadata?.newCard === "true" && intent.status === "requires_payment_method" && (near ? Number(intent.amount) === total.holdCents : true)));
    if (!reuse) {
      if (intent) await letGoOfIntent(intent.id, "an earlier approve for another total");
      const key = `quote_extras_${near ? "hold" : "check"}_${extraId}_${tag}`;
      const description = `Extras for ${q.title}`.slice(0, 450);
      try {
        if (near) {
          intent = await stripe.paymentIntents.create({
            amount: total.holdCents, currency: "usd", customer: card.customerId, capture_method: "manual",
            ...(useSaved ? { payment_method: card.paymentMethodId, confirm: true } : { setup_future_usage: "off_session" }),
            automatic_payment_methods: { enabled: true, allow_redirects: "never" },
            metadata: { ...metadata, ...(useSaved ? {} : { newCard: "true" }) }, description,
          }, { idempotencyKey: key, ...BOUND });
        } else {
          intent = await stripe.setupIntents.create({
            customer: card.customerId, usage: "off_session",
            ...(useSaved ? { payment_method: card.paymentMethodId, confirm: true } : {}),
            automatic_payment_methods: { enabled: true, allow_redirects: "never" },
            metadata: { ...metadata, ...(useSaved ? {} : { newCard: "true" }) }, description,
          }, { idempotencyKey: key, ...BOUND });
        }
      } catch (err: any) {
        if (isCardError(err)) {
          const failed = err?.raw?.payment_intent?.id ?? err?.raw?.setup_intent?.id;
          if (failed) await letGoOfIntent(failed, "declined at approve");
          await note(errMsg(err));
          return DECLINED;
        }
        await note(errMsg(err));
        if (err?.statusCode) return STRIPE_DOWN; // Stripe answered: nothing was made
        // No reply: it may have landed. The claim stays until it runs out; the next try looks it up first.
        keepClaim = true;
        return BUSY;
      }
    }
    const wentThrough = near ? intent?.status === "requires_capture" : intent?.status === "succeeded";
    if (wentThrough) return result(await finishApproval(extraId, intent, tag));
    if (intent?.status === "requires_action" || (!useSaved && intent?.status === "requires_payment_method")) {
      await rows(sql`UPDATE quote_extras SET status = 'approving', approve_intent_id = ${intent.id}, updated_at = now() WHERE id = ${extraId} AND status IN ('proposed', 'approving')`);
      return { ok: true, status: "needs_action", extra: (await extraById(extraId))!, intentType: near ? "payment" : "setup", clientSecret: intent.client_secret, intentId: intent.id, customerId: idOf(intent.customer) };
    }
    if (intent?.id) await letGoOfIntent(intent.id, `approve came back ${intent?.status}`);
    await note(`approve: status ${intent?.status}`);
    return DECLINED;
  } catch (err) {
    await note(errMsg(err));
    console.error(`[quote extras] approve ${extraId} failed:`, err);
    keepClaim = true; // unknown: let the claim run out so nothing races a call that may have landed
    return BUSY;
  } finally {
    if (!keepClaim) await unclaim();
  }
}

// ─── The far out hold (placed with the balance, 24 hours before) ────────────

export type ExtrasHoldOutcome = "held" | "declined" | "unknown" | "busy" | "not_due";

/** An earlier off session hold for this booking's extras (its reply lost). */
async function findEarlierHold(stripe: any, customerId: string, appointmentId: string, amount: number, sinceUnix: number): Promise<any | null> {
  const list = await stripe.paymentIntents.list({ customer: customerId, created: { gte: sinceUnix }, limit: 100 }, BOUND);
  return (list?.data ?? []).find((pi: any) => pi?.metadata?.type === EXTRAS_PI_TYPE && pi?.metadata?.appointmentId === appointmentId
    && pi?.metadata?.scheduled === "true" && Number(pi.amount) === amount && ["requires_capture", "succeeded"].includes(pi.status)) ?? null;
}

/** Places a scheduled extras hold (first try or the retry). Same rules as the balance hold. */
export async function placeExtrasHold(paymentId: string, now = new Date()): Promise<ExtrasHoldOutcome> {
  const tag = randomUUID();
  const [c] = await rows<any>(sql`
    UPDATE quote_extras_payments x SET status = 'holding', attempts = x.attempts + 1, claim_tag = ${tag}, updated_at = now()
      FROM (SELECT id, status AS prev FROM quote_extras_payments WHERE id = ${paymentId}) p
     WHERE x.id = p.id AND x.approved_cents > 0
       AND (x.approve_claimed_at IS NULL OR x.approve_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
       AND EXISTS (SELECT 1 FROM appointments a WHERE a.id = x.appointment_id AND a.status = 'confirmed')
       AND ((x.status = 'scheduled' AND x.hold_at <= ${now})
         OR (x.status = 'hold_failed' AND x.retry_at IS NOT NULL AND x.retry_at <= ${now})
         OR (x.status = 'holding' AND x.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     RETURNING x.*, p.prev`);
  if (!c) {
    const p = await db.select({ s: quoteExtrasPayments.status }).from(quoteExtrasPayments).where(eq(quoteExtrasPayments.id, paymentId));
    return p[0]?.s === "holding" ? "busy" : "not_due";
  }
  const isLastTry = c.prev === "hold_failed" || !c.retry_at || new Date(c.retry_at).getTime() <= now.getTime();
  const note = async (msg: string) => { await rows(sql`UPDATE quote_extras_payments SET last_error = ${msg.slice(0, 500)}, updated_at = now() WHERE id = ${paymentId} AND claim_tag = ${tag}`); };
  const declined = async (msg: string) => {
    const [row] = await rows<{ id: string }>(sql`
      UPDATE quote_extras_payments SET status = 'hold_failed', last_error = ${msg.slice(0, 500)},
             retry_at = CASE WHEN ${isLastTry} THEN NULL ELSE retry_at END, updated_at = now()
       WHERE id = ${paymentId} AND claim_tag = ${tag} RETURNING id`);
    if (row && isLastTry) { const p = await extrasPaymentFor(c.appointment_id); if (p) await postPaymentCardOnce(p, "extras_hold_failed"); }
    return "declined" as const;
  };
  const held = async (pi: any) => {
    const [ok] = await rows<{ id: string }>(sql`
      UPDATE quote_extras_payments SET status = 'held', stripe_payment_intent_id = ${pi.id}, held_cents = ${Number(pi.amount)}::int, held_at = now(),
             retry_at = NULL, last_error = NULL, failed_notice_at = NULL, updated_at = now()
       WHERE id = ${paymentId} AND claim_tag = ${tag} AND status = 'holding' RETURNING id`);
    if (!ok) {
      // The claim was taken over meanwhile (a cancel): this hold is on no record, so it never stays on the card.
      if (pi.status === "requires_capture") await letGoOfIntent(pi.id, "the hold claim was taken over");
      return "busy" as const;
    }
    return "held" as const;
  };
  const stripe: any = await getUncachableStripeClient();
  const customerId: string | null = c.stripe_customer_id;
  const paymentMethodId: string | null = c.payment_method_id;
  if (!customerId || !paymentMethodId) return declined("no checked card for the extras");
  try {
    const earlier = await findEarlierHold(stripe, customerId, c.appointment_id, c.hold_cents, Math.floor(new Date(c.created_at).getTime() / 1000) - 3600);
    if (earlier) return held(earlier);
  } catch (err) {
    await note(`lookup: ${errMsg(err)}`);
    return "unknown";
  }
  const q = await quoteOf(c.quote_id);
  try {
    const pi = await stripe.paymentIntents.create({
      amount: c.hold_cents, currency: "usd", customer: customerId, payment_method: paymentMethodId, capture_method: "manual",
      off_session: true, confirm: true,
      metadata: { type: EXTRAS_PI_TYPE, appointmentId: c.appointment_id, quoteId: c.quote_id, businessId: c.business_id, scheduled: "true" },
      description: `Extras for ${q?.title ?? "your booking"}`.slice(0, 450),
    }, { idempotencyKey: `quote_extras_hold_${c.appointment_id}_${tag}`, ...BOUND });
    if (pi?.status === "requires_capture") return held(pi);
    if (pi?.id && pi.status !== "canceled") await letGoOfIntent(pi.id, `scheduled hold came back ${pi.status}`);
    return declined(`status ${pi?.status}`);
  } catch (err: any) {
    if (isCardError(err)) return declined(errMsg(err));
    await note(errMsg(err));
    return "unknown";
  }
}

// ─── Job complete: charge once, lapse what's open ───────────────────────────

/** Why Job complete must wait for the extras now (null: it needn't). */
export async function extrasBlockFor(appointmentId: string, now = new Date()): Promise<null | "EXTRAS_NOT_HELD" | "EXTRAS_BUSY"> {
  const { extrasCompleteBlocker } = await import("./quoteExtrasRules");
  const p = await extrasPaymentFor(appointmentId);
  return extrasCompleteBlocker(p ? { status: p.status, approvedCents: p.approvedCents, approveClaimedAt: p.approveClaimedAt ? new Date(p.approveClaimedAt) : null } : null, now);
}

/** Closes extras nobody answered (Job complete: lapsed; the booking ended: canceled) and lets their intents go. */
async function closeOpenExtras(appointmentId: string, to: "lapsed" | "canceled"): Promise<void> {
  const closed = await rows<{ id: string; intent: string | null }>(sql`
    UPDATE quote_extras e SET status = ${to}, answered_at = COALESCE(e.answered_at, now()), approve_intent_id = NULL, updated_at = now()
      FROM (SELECT id, approve_intent_id AS intent FROM quote_extras WHERE appointment_id = ${appointmentId} AND status IN ('proposed', 'approving')) p
     WHERE e.id = p.id AND e.status IN ('proposed', 'approving') RETURNING e.id, p.intent`);
  for (const x of closed) if (x.intent) await letGoOfIntent(x.intent, `extra ${to}`);
}

async function alertOutsyde(subject: string, text: string): Promise<void> {
  console.error(`[quote extras] ${subject}: ${text}`);
  try { const { quoteAdminAlert } = await import("./quoteWindow"); await quoteAdminAlert(subject, text); } catch { /* logged above */ }
}

export type ExtrasCapture = { capturedCents: number; status: string };

/**
 * Job complete (quoteBalance.completeQuoteJob, after the balance): charges the held extras once (the whole hold).
 * A hold that can't be charged any more becomes unpaid (Pay for extras); the job still completes (B4). A charge in
 * doubt stays 'capturing' and the extras job finishes it from Stripe. Never starts while an Approve is under way.
 * Never throws.
 */
export async function captureExtrasAtComplete(appointmentId: string): Promise<ExtrasCapture> {
  try {
    await closeOpenExtras(appointmentId, "lapsed");
    const tag = randomUUID();
    const [c] = await rows<any>(sql`
      UPDATE quote_extras_payments SET status = 'capturing', claim_tag = ${tag}, updated_at = now()
       WHERE appointment_id = ${appointmentId} AND stripe_payment_intent_id IS NOT NULL AND approved_cents > 0
         AND (approve_claimed_at IS NULL OR approve_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
         AND (status = 'held' OR (status = 'capturing' AND updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
       RETURNING *`);
    if (!c) {
      const p = await extrasPaymentFor(appointmentId);
      return { capturedCents: p?.status === "captured" ? p.capturedCents ?? 0 : 0, status: p?.status ?? "none" };
    }
    const stripe: any = await getUncachableStripeClient();
    let cur: any;
    try { cur = await stripe.paymentIntents.retrieve(c.stripe_payment_intent_id, {}, BOUND); } catch (err) {
      await rows(sql`UPDATE quote_extras_payments SET last_error = ${`lookup: ${errMsg(err)}`}, updated_at = now() WHERE id = ${c.id} AND claim_tag = ${tag}`);
      return { capturedCents: 0, status: "capturing" };
    }
    if (cur?.status === "requires_capture") {
      try {
        cur = await stripe.paymentIntents.capture(c.stripe_payment_intent_id, { amount_to_capture: c.hold_cents },
          { idempotencyKey: `quote_extras_capture_${appointmentId}_${c.hold_cents}_${tag}`, ...BOUND });
      } catch (err) {
        await rows(sql`UPDATE quote_extras_payments SET last_error = ${errMsg(err)}, updated_at = now() WHERE id = ${c.id} AND claim_tag = ${tag}`);
        return { capturedCents: 0, status: "capturing" };
      }
    }
    if (cur?.status === "succeeded") {
      const r = await recordCaptured(c.id, cur, tag);
      if (!r.recorded) await alertOutsyde("Extras charge not on record", `Extras payment ${cur.id} on quote booking ${appointmentId} was charged (${r.got} cents) but the record had moved on. Check it in Stripe.`);
      return { capturedCents: r.got, status: "captured" };
    }
    // The hold ended (expired, let go at Stripe): the backup, Pay for extras.
    await rows(sql`UPDATE quote_extras_payments SET status = 'unpaid', last_error = ${`hold is ${cur?.status} at Stripe`}, failed_notice_at = NULL, updated_at = now() WHERE id = ${c.id} AND claim_tag = ${tag}`);
    const p = await extrasPaymentFor(appointmentId);
    if (p?.status === "unpaid") await postPaymentCardOnce(p, "extras_failed");
    return { capturedCents: 0, status: "unpaid" };
  } catch (err) {
    console.error(`[quote extras] capture at Job complete failed for ${appointmentId}:`, err);
    return { capturedCents: 0, status: "error" };
  }
}

/** Records a charged extras payment once: the vendor's share held for the window, and the points pending. */
async function recordCaptured(paymentId: string, pi: any, tag: string | null): Promise<{ got: number; recorded: boolean }> {
  const got = Number(pi.amount_received ?? pi.amount);
  const [done] = await rows<any>(sql`
    UPDATE quote_extras_payments SET status = 'captured', stripe_payment_intent_id = ${pi.id}, stripe_charge_id = ${chargeIdOf(pi)},
           captured_cents = ${got}::int, captured_at = COALESCE(captured_at, now()), payout_status = CASE WHEN payout_status = 'none' THEN 'held' ELSE payout_status END,
           last_error = NULL, updated_at = now()
     WHERE id = ${paymentId} AND (${tag}::text IS NULL OR claim_tag = ${tag}) AND status IN ('held', 'capturing', 'unpaid')
       AND stripe_payment_intent_id = ${pi.id}
     RETURNING id, appointment_id, client_id, business_id`);
  if (!done) {
    const [already] = await rows(sql`SELECT 1 AS x FROM quote_extras_payments WHERE id = ${paymentId} AND status = 'captured' AND stripe_payment_intent_id = ${pi.id}`);
    return { got, recorded: !!already };
  }
  try {
    const { createPending, pointsForGrossCents } = await import("../loyaltyLedger");
    await createPending({
      userId: done.client_id, points: pointsForGrossCents(got), dollarAmountCents: got, transactionType: "business_transaction",
      referenceType: "quote_extras", referenceId: done.id, releaseAfter: null, businessId: done.business_id, description: "Points earned on your extras",
    });
  } catch (err) {
    console.error(`[quote extras] points failed for ${done.appointment_id}:`, err);
  }
  return { got, recorded: true };
}

// ─── A booking that ends before Job complete ────────────────────────────────

export type ExtrasReleaseResult = { ok: true } | { ok: false; message: string };

/** Every extras PaymentIntent on this booking that still reserves money or could (found at Stripe by metadata). */
async function liveExtrasIntents(stripe: any, customerId: string, appointmentId: string, sinceUnix: number): Promise<any[]> {
  const out: any[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await stripe.paymentIntents.list({ customer: customerId, created: { gte: sinceUnix }, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) }, BOUND);
    for (const pi of list?.data ?? []) if (pi?.metadata?.type === EXTRAS_PI_TYPE && pi?.metadata?.appointmentId === appointmentId) out.push(pi);
    if (!list?.has_more || !list.data?.length) break;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return out;
}

/**
 * The booking is ending before Job complete (any cancel path, through quoteBalance.settleBalanceOnCancel, and the
 * job's safety net): open extras are closed and every extras hold on the booking is let go (extras are never part
 * of a cancellation fee). Claimed ('releasing'), never while an Approve is under way; a stale hold or release claim
 * is taken over. Every extras PaymentIntent for the booking is looked up at Stripe, so a hold whose reply was lost
 * is let go too. Charged extras are left to the refund paths.
 */
export async function releaseExtrasOnCancel(appointmentId: string): Promise<ExtrasReleaseResult> {
  await closeOpenExtras(appointmentId, "canceled");
  const tag = randomUUID();
  const [c] = await rows<any>(sql`
    UPDATE quote_extras_payments SET status = 'releasing', claim_tag = ${tag}, updated_at = now()
     WHERE appointment_id = ${appointmentId}
       AND ((status IN ('none', 'scheduled', 'held', 'hold_failed') AND (approve_claimed_at IS NULL OR approve_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
         OR (status IN ('holding', 'releasing') AND updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     RETURNING *`);
  if (!c) {
    const p = await extrasPaymentFor(appointmentId);
    if (!p || ["released", "captured", "unpaid"].includes(p.status)) return { ok: true };
    return { ok: false, message: "The extras are being updated right now. Try again in a few minutes." };
  }
  const stripe: any = await getUncachableStripeClient();
  try {
    const ids = new Set<string>([c.stripe_payment_intent_id, c.release_pi].filter(Boolean));
    const customerId = c.stripe_customer_id ?? (await depositCard(appointmentId)).customerId;
    if (customerId) {
      for (const pi of await liveExtrasIntents(stripe, customerId, appointmentId, Math.floor(new Date(c.created_at).getTime() / 1000) - 3600)) ids.add(pi.id);
    }
    for (const id of Array.from(ids)) {
      const cur: any = await stripe.paymentIntents.retrieve(id, {}, BOUND);
      if (cur?.status === "succeeded") {
        await alertOutsyde("Extras charged on a booking that ended", `Extras payment ${id} on quote booking ${appointmentId} was charged before the booking ended. Refund it from the booking.`);
        continue;
      }
      if (CANCELABLE.includes(cur?.status)) await stripe.paymentIntents.cancel(id, { cancellation_reason: "requested_by_customer" }, BOUND);
    }
  } catch (err) {
    // Left 'releasing': the job takes the claim over once it is stale and tries again.
    await rows(sql`UPDATE quote_extras_payments SET last_error = ${`release: ${errMsg(err)}`}, updated_at = now() WHERE id = ${c.id} AND claim_tag = ${tag}`);
    return { ok: false, message: "The extras hold couldn't be released right now. Try again in a few minutes." };
  }
  await rows(sql`
    UPDATE quote_extras_payments SET status = 'released', released_at = now(), release_pi = NULL, retry_at = NULL, hold_at = NULL, updated_at = now()
     WHERE id = ${c.id} AND claim_tag = ${tag} AND status = 'releasing'`);
  return { ok: true };
}

// ─── Refunds ────────────────────────────────────────────────────────────────

/** What can still be refunded of the extras (the business's part; the service fee is never refunded). */
export function refundableExtrasCents(p: QuoteExtrasPayment | undefined | null): number {
  if (!p || p.status !== "captured") return 0;
  return Math.max(0, Math.min(p.approvedCents, p.capturedCents ?? 0) - p.refundedCents);
}

/** Records a refund of the extras payment (in app, the dashboard, or a lost dispute): the held share shrinks. */
export async function recordExtrasRefund(paymentIntentId: string, amountCents: number): Promise<void> {
  await rows(sql`
    UPDATE quote_extras_payments SET refunded_cents = refunded_cents + ${amountCents}::int,
           payout_status = CASE WHEN refunded_cents + ${amountCents}::int >= approved_cents AND payout_status IN ('held', 'paused') THEN 'canceled' ELSE payout_status END,
           updated_at = now()
     WHERE stripe_payment_intent_id = ${paymentIntentId}`);
}

// ─── Webhook ────────────────────────────────────────────────────────────────

/**
 * Stripe events for an extras PaymentIntent (metadata.type quote_extras). Returns true when handled.
 *   capturable: an Approve that needed the customer went through (finished under the claim), or Update your card is
 *     now held. Never lets an intent go while an Approve is under way (it may be that Approve's own hold).
 *   succeeded: Pay for extras paid, or a capture whose reply was lost. One that isn't on record is flagged to Outsyde.
 *   canceled: Stripe let the hold go while we thought it held.
 */
export async function handleExtrasEvent(kind: "capturable" | "succeeded" | "canceled", pi: any): Promise<boolean> {
  if (pi?.metadata?.type !== EXTRAS_PI_TYPE) return false;
  const apptId = pi.metadata.appointmentId;
  if (!apptId) return true;
  const p = await extrasPaymentFor(apptId);
  const claimLive = !!p?.approveClaimedAt && new Date(p.approveClaimedAt).getTime() > Date.now() - CLAIM_MINUTES * 60_000;
  if (kind === "capturable" && pi.status === "requires_capture") {
    if (p && p.stripePaymentIntentId === pi.id && p.status !== "hold_failed") return true; // already the hold on record
    const extraId = pi.metadata.extraId;
    if (extraId) {
      const x = await extraById(extraId);
      if (x?.status === "approving" && x.approveIntentId === pi.id) { await finishWaiting(extraId, pi); return true; } // busy: Approve or the job finishes it
      if (!claimLive && x?.status !== "approving") await letGoOfIntent(pi.id, `not an extra waiting on it (${x?.status ?? "none"})`);
      return true;
    }
    if (pi.metadata.newCard === "true") {
      const [done] = await rows<{ id: string }>(sql`
        UPDATE quote_extras_payments SET status = 'held', held_cents = ${Number(pi.amount)}::int, held_at = now(), retry_at = NULL, last_error = NULL, updated_at = now()
         WHERE appointment_id = ${apptId} AND status = 'hold_failed' AND stripe_payment_intent_id = ${pi.id} AND hold_cents = ${Number(pi.amount)}::int RETURNING id`);
      if (!done && !claimLive) await letGoOfIntent(pi.id, `extras are ${p?.status}, not waiting on this card`);
    }
    return true;
  }
  if (kind === "succeeded") {
    if (p && p.stripePaymentIntentId === pi.id && ["held", "capturing", "unpaid"].includes(p.status)) { await recordCaptured(p.id, pi, null); return true; }
    if (!(p && p.stripePaymentIntentId === pi.id && p.status === "captured")) {
      await alertOutsyde("Extras payment not on record", `Extras payment ${pi.id} (${Number(pi.amount_received ?? 0)} cents) on quote booking ${apptId} went through but isn't the payment on record (status ${p?.status ?? "none"}). Refund it or record it.`);
    }
    return true;
  }
  if (kind === "canceled" && p && p.stripePaymentIntentId === pi.id && p.status === "held") {
    await rows(sql`UPDATE quote_extras_payments SET status = 'hold_failed', retry_at = NULL, last_error = 'hold canceled at Stripe', failed_notice_at = NULL, updated_at = now() WHERE id = ${p.id} AND status = 'held' AND stripe_payment_intent_id = ${pi.id}`);
    const fresh = await extrasPaymentFor(apptId);
    if (fresh?.status === "hold_failed") await postPaymentCardOnce(fresh, "extras_hold_failed");
  }
  return true;
}

// ─── Update your card, Pay for extras ───────────────────────────────────────

export type ExtrasCardResult = { ok: true; pi: any; captureMethod: "manual" | "automatic" } | { ok: false; status: number; code: string; message: string };

/**
 * The customer pays with a new card: a hold that failed for good (Update your card, before Job complete) or extras
 * that couldn't be charged at Job complete (Pay for extras, charged now). Under the payment claim. A second tap
 * returns the same unfinished payment; one that is processing or already went through is never replaced, and a
 * failed lookup decides nothing.
 */
export async function startExtrasCardPayment(appointmentId: string, customerId: string): Promise<ExtrasCardResult> {
  const c = await claimPayment(appointmentId, ["hold_failed", "unpaid"]);
  if (!c) {
    const p = await extrasPaymentFor(appointmentId);
    if (!p || !["hold_failed", "unpaid"].includes(p.status)) {
      return { ok: false, status: 409, code: p?.status === "held" || p?.status === "captured" ? "ALREADY_HELD" : "NOT_NEEDED", message: p?.status === "held" ? "The extras are already on hold on your card." : p?.status === "captured" ? "The extras are paid." : "Nothing to pay right now." };
    }
    return BUSY;
  }
  const p = c.row;
  try {
    const appt = await storage.getAppointment(appointmentId);
    const payNow = p.status === "unpaid";
    if (!payNow) {
      if (p.retry_at) return { ok: false, status: 409, code: "RETRY_PENDING", message: "We'll try your card again before the job. If that doesn't work, you can add a new card." };
      if (appt?.status !== BOOKING_STATES.CONFIRMED) return { ok: false, status: 409, code: "NOT_CONFIRMED", message: "This booking can't take a payment now." };
    }
    const stripe: any = await getUncachableStripeClient();
    if (p.stripe_payment_intent_id) {
      let cur: any;
      try { cur = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id, {}, BOUND); }
      catch { return STRIPE_DOWN; }
      const mine = cur?.metadata?.newCard === "true" && (cur?.capture_method === "manual") === !payNow;
      if (mine && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(cur.status)) return { ok: true, pi: cur, captureMethod: payNow ? "automatic" : "manual" };
      if (cur?.status === "processing") return { ok: false, status: 409, code: "PROCESSING", message: "Your payment is going through. Check back in a minute." };
      if (cur?.status === "succeeded" && payNow) { await recordCaptured(p.id, cur, null); return { ok: false, status: 409, code: "ALREADY_PAID", message: "The extras are paid." }; }
      if (cur?.status === "requires_capture" && !payNow && mine) { await handleExtrasEvent("capturable", cur); return { ok: false, status: 409, code: "ALREADY_HELD", message: "The extras are already on hold on your card." }; }
    }
    const q = await quoteOf(p.quote_id);
    const pi = await stripe.paymentIntents.create({
      amount: p.hold_cents, currency: "usd", customer: customerId,
      ...(payNow ? {} : { capture_method: "manual" }),
      setup_future_usage: "off_session",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { type: EXTRAS_PI_TYPE, appointmentId, quoteId: p.quote_id, businessId: p.business_id, newCard: "true", ...(payNow ? { payNow: "true" } : {}) },
      description: `Extras for ${q?.title ?? "your booking"}`.slice(0, 450),
    }, { idempotencyKey: `quote_extras_card_${appointmentId}_${p.attempts}`, ...BOUND });
    await rows(sql`
      UPDATE quote_extras_payments SET stripe_payment_intent_id = ${pi.id}, attempts = attempts + 1, updated_at = now()
       WHERE id = ${p.id} AND approve_claim_tag = ${c.tag} AND status = ${p.status}`);
    return { ok: true, pi, captureMethod: payNow ? "automatic" : "manual" };
  } finally {
    await unclaimPayment(appointmentId, c.tag);
  }
}

// ─── The job (every 5 minutes, with the quote expiry job) ───────────────────

export async function runQuoteExtrasJob(now = new Date()): Promise<{ holds: number; charged: number; released: number; reminders: number }> {
  let holds = 0, charged = 0, released = 0, reminders = 0;
  // Step 6a: Activity rows for extras closed some other way (lapsed at Job complete, canceled with the booking).
  const { sweepExtraNotices } = await import("./quoteNotices");
  await sweepExtraNotices();
  // Review I2: extras released for a cancel that never went through (the booking is still confirmed): hold again.
  await rows(sql`
    UPDATE quote_extras_payments x SET status = 'scheduled', hold_at = ${now}::timestamptz, retry_at = NULL, released_at = NULL, failed_notice_at = NULL, updated_at = now()
      FROM appointments a, quote_jobs j
     WHERE a.id = x.appointment_id AND j.appointment_id = x.appointment_id AND a.status = 'confirmed' AND j.completed_at IS NULL
       AND x.status = 'released' AND x.approved_cents > 0 AND x.released_at < now() - interval '2 minutes'`);
  // Far out holds and retries due, for confirmed bookings.
  const due = await rows<{ id: string }>(sql`
    SELECT x.id FROM quote_extras_payments x JOIN appointments a ON a.id = x.appointment_id AND a.status = 'confirmed'
     WHERE x.approved_cents > 0 AND ((x.status = 'scheduled' AND x.hold_at <= ${now}::timestamptz)
        OR (x.status = 'hold_failed' AND x.retry_at IS NOT NULL AND x.retry_at <= ${now}::timestamptz)
        OR (x.status = 'holding' AND x.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     ORDER BY x.hold_at LIMIT 25`);
  for (const d of due) {
    try { if ((await placeExtrasHold(d.id, now)) === "held") holds++; } catch (err) { console.error(`[quote extras] hold failed for ${d.id}:`, err); }
  }
  // A charge in doubt at Job complete (no reply), or held extras on a completed booking: finish from Stripe.
  const doubt = await rows<{ appointment_id: string }>(sql`
    SELECT x.appointment_id FROM quote_extras_payments x JOIN appointments a ON a.id = x.appointment_id AND a.status = 'completed'
     WHERE (x.status = 'capturing' AND x.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
        OR (x.status = 'held' AND EXISTS (SELECT 1 FROM quote_jobs j WHERE j.appointment_id = x.appointment_id AND j.completed_at IS NOT NULL))
     LIMIT 25`);
  for (const d of doubt) { if ((await captureExtrasAtComplete(d.appointment_id)).status === "captured") charged++; }
  // Safety net: a booking that ended by a path that skipped the release, a stale hold or release claim (review I3),
  // and a release left half done on a booking still confirmed.
  const ended = await rows<{ appointment_id: string }>(sql`
    SELECT x.appointment_id FROM quote_extras_payments x JOIN appointments a ON a.id = x.appointment_id
     WHERE (a.status NOT IN ('confirmed', 'completed') AND (x.status IN ('none', 'scheduled', 'hold_failed', 'held')
             OR (x.status IN ('holding', 'releasing') AND x.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
             OR EXISTS (SELECT 1 FROM quote_extras e WHERE e.appointment_id = x.appointment_id AND e.status IN ('proposed', 'approving'))))
        OR (x.status = 'releasing' AND x.updated_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
     LIMIT 25`);
  for (const e of ended) { try { if ((await releaseExtrasOnCancel(e.appointment_id)).ok) released++; } catch (err) { console.error(`[quote extras] release failed for ${e.appointment_id}:`, err); } }
  // Replaced holds not let go yet (only while no Approve is under way, which may be letting it go itself).
  const replaced = await rows<{ id: string }>(sql`
    SELECT id FROM quote_extras_payments WHERE release_pi IS NOT NULL AND updated_at < now() - interval '2 minutes'
       AND (approve_claimed_at IS NULL OR approve_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES})) LIMIT 25`);
  for (const r of replaced) if (await releaseReplaced(r.id)) released++;
  // An Approve that needed the customer and was left: finish it if it went through (under the claim).
  const waiting = await rows<{ id: string; intent: string }>(sql`
    SELECT id, approve_intent_id AS intent FROM quote_extras WHERE status = 'approving' AND approve_intent_id IS NOT NULL
       AND updated_at < now() - make_interval(mins => ${CLAIM_MINUTES}) LIMIT 25`);
  for (const w of waiting) {
    try {
      const stripe: any = await getUncachableStripeClient();
      const cur: any = w.intent.startsWith("seti_") ? await stripe.setupIntents.retrieve(w.intent, {}, BOUND) : await stripe.paymentIntents.retrieve(w.intent, {}, BOUND);
      if (cur?.status === "requires_capture" || (isSetupIntent(cur) && cur?.status === "succeeded")) await finishWaiting(w.id, cur);
      else if (["canceled", "requires_payment_method"].includes(cur?.status) && !cur?.metadata?.newCard) {
        await rows(sql`UPDATE quote_extras SET status = 'proposed', approve_intent_id = NULL, updated_at = now() WHERE id = ${w.id} AND status = 'approving' AND approve_intent_id = ${w.intent}`);
      }
    } catch (err) { console.error(`[quote extras] approve sweep ${w.id} failed:`, err); }
  }
  // E7: unpaid extras, one reminder after 24 hours.
  const late = await rows<{ id: string }>(sql`
    UPDATE quote_extras_payments SET reminder_at = now(), updated_at = now()
     WHERE status = 'unpaid' AND reminder_at IS NULL AND failed_notice_at IS NOT NULL
       AND failed_notice_at < ${now}::timestamptz - make_interval(hours => ${UNPAID_REMINDER_HOURS}) RETURNING id`);
  for (const l of late) {
    const p = (await db.select().from(quoteExtrasPayments).where(eq(quoteExtrasPayments.id, l.id)))[0];
    const q = p ? await quoteOf(p.quoteId) : undefined;
    if (p && q && (await postExtraCard(q, "extras_reminder", false, { amountCents: p.holdCents }))) reminders++;
  }
  return { holds, charged, released, reminders };
}

// ─── The quote's JSON (additive) ────────────────────────────────────────────

export function extraJson(x: QuoteExtra, viewer: { isCustomer: boolean; canManage: boolean }, open: boolean) {
  const fee = quoteExtraSplit(x.amountCents).serviceFeeCents;
  return {
    id: x.id, description: x.description, amountCents: x.amountCents, serviceFeeCents: fee, totalCents: x.amountCents + fee,
    status: x.status, createdAt: x.createdAt, answeredAt: x.answeredAt,
    canApprove: open && viewer.isCustomer && (x.status === "proposed" || x.status === "approving"),
    canDecline: open && viewer.isCustomer && (x.status === "proposed" || x.status === "approving"),
    canWithdraw: open && viewer.canManage && x.status === "proposed",
  };
}

export async function extrasJson(q: Quote, viewerId: string, canManage: boolean) {
  if (!q.appointmentId) return { extras: [], extrasPayment: null };
  const list = await extrasFor(q.appointmentId);
  const p = await extrasPaymentFor(q.appointmentId);
  const open = (await bookingOpen(q)) === null;
  const viewer = { isCustomer: viewerId === q.customerId, canManage };
  return {
    extras: list.map((x) => extraJson(x, viewer, open)),
    extrasPayment: p && (p.approvedCents > 0 || p.status !== "none") ? {
      status: p.status, approvedCents: p.approvedCents, serviceFeeCents: p.feeCents, holdCents: p.holdCents, holdAt: p.holdAt, heldAt: p.heldAt,
      capturedCents: p.capturedCents, capturedAt: p.capturedAt, refundedCents: p.refundedCents,
      needsNewCard: p.status === "hold_failed" && p.retryAt === null, unpaid: p.status === "unpaid",
      ...(canManage ? { payout: { status: p.payoutStatus, cents: p.payoutCents ?? null, paidAt: p.paidOutAt ?? null } } : {}),
    } : null,
  };
}
