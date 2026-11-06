/**
 * Paying a quote (Quotes in Messages, step 3, migration 098): everything that touches the database.
 * Rules: ./quotePayments.ts. The pay route itself lives in routes.ts next to the booking PaymentIntent route, so
 * it reuses the same builder, fees, points code checks and Stripe customer (POST /api/quotes/:id/pay).
 *
 * Flow: pay route checks the quote and the business, locks the quote (paying_until), holds the time
 * (booking_holds, the database refuses an overlapping hold), creates a pending_payment appointment with
 * quote_id and the booking PaymentIntent. Stripe's payment_intent.succeeded runs the normal appointment branch;
 * just before it confirms, claimQuotePaid marks the quote paid (same guard: still sent, same version). If the
 * quote can't be claimed (changed, withdrawn), the payment is refunded in full and the booking canceled.
 */
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  appointments, bookingHolds, estimateRequests, providerBlocks, quotes, staffMembers,
  type Appointment, type Quote,
} from "@shared/schema";
import { BOOKING_STATES } from "@shared/schema";
import { jobDaySegments } from "./quotePayments";
import { quoteAmounts, quoteMessageText } from "./quoteRules";
import { postCardMessage } from "../messaging/postCard";
import { calculateBookingFees } from "../fees";
import { stripeService } from "../stripe/stripeService";

export const PAY_LOCK_MINUTES = 15;

/** A quote with a date, start time and length: the only kind a service quote can be paid as (it becomes a booking). */
export type ScheduledQuote = Quote & { jobDate: string; startTime: string; durationMinutes: number };
export const isScheduled = (q: Quote): q is ScheduledQuote => !!q.jobDate && !!q.startTime && typeof q.durationMinutes === "number";
const LIVE_STATES = [BOOKING_STATES.DRAFT, BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.PENDING_PROVIDER, BOOKING_STATES.CONFIRMED];

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const overlaps = (s1: string, e1: string, s2: string, e2: string) => toMin(s1) < toMin(e2) && toMin(e1) > toMin(s2);
/** Same naive local timestamps as booking_holds.start_at (availabilityService parseDateWithTime). */
function localTs(date: string, time: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

/**
 * Is the quote's time still free (call 5)? Other bookings of the business (or of the staff member for a staff
 * quote) and the extra days of other multi day quote bookings. Business hours and time off are not checked: the
 * vendor chose the time. Active holds are refused atomically when the quote's own hold is inserted.
 */
export async function quoteTimeConflict(q: ScheduledQuote): Promise<boolean> {
  const segs = jobDaySegments(q.jobDate, q.startTime, q.durationMinutes);
  for (const seg of segs) {
    const conds = [eq(appointments.businessId, q.businessId), eq(appointments.appointmentDate, seg.date), inArray(appointments.status, LIVE_STATES)];
    if (q.staffMemberId) conds.push(eq(appointments.staffMemberId, q.staffMemberId));
    const appts = await db.select({ t: appointments.appointmentTime, e: appointments.appointmentEndTime, d: appointments.durationMinutes, quoteId: appointments.quoteId })
      .from(appointments).where(and(...conds));
    for (const a of appts) {
      if (a.quoteId === q.id) continue; // its own earlier attempt (the pay route checks that separately)
      const end = a.e || (() => { const m = toMin(a.t) + (a.d || 60); return m >= 1440 ? "23:59" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; })();
      if (overlaps(seg.startTime, seg.endTime, a.t, end)) return true;
    }
  }
  // Extra days of other quote bookings (time off blocks tied to a booking).
  const startAt = localTs(segs[0].date, segs[0].startTime);
  const endAt = new Date(startAt.getTime() + q.durationMinutes * 60_000);
  const blockConds = [
    eq(providerBlocks.providerType, "business"), eq(providerBlocks.providerId, q.businessId), isNotNull(providerBlocks.appointmentId),
    lt(providerBlocks.startAt, endAt), sql`${providerBlocks.endAt} > ${startAt}`,
  ];
  if (q.staffMemberId) blockConds.push(eq(providerBlocks.staffMemberId, q.staffMemberId));
  const blocks = await db.select({ id: providerBlocks.id }).from(providerBlocks).where(and(...blockConds)).limit(1);
  return blocks.length > 0;
}

/** The time hold for a quote payment. Returns null when an overlapping active hold exists. */
export async function holdQuoteTime(q: ScheduledQuote, customerId: string): Promise<{ id: string } | null> {
  const segs = jobDaySegments(q.jobDate, q.startTime, q.durationMinutes);
  const startAt = localTs(q.jobDate, q.startTime);
  try {
    const [hold] = await db.insert(bookingHolds).values({
      providerType: "business",
      providerId: q.businessId,
      staffMemberId: q.staffMemberId ?? null,
      userId: customerId,
      serviceId: q.serviceId ?? q.id,
      serviceName: q.title,
      servicePriceCents: q.totalCents,
      durationMinutes: q.durationMinutes,
      holdDate: q.jobDate,
      startTime: q.startTime,
      endTime: segs[0].endTime,
      startAt,
      endAt: new Date(startAt.getTime() + q.durationMinutes * 60_000),
      expiresAt: new Date(Date.now() + PAY_LOCK_MINUTES * 60_000),
      quoteId: q.id,
    }).returning({ id: bookingHolds.id });
    return hold;
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    const constraint = err?.constraint ?? err?.cause?.constraint;
    if (code === "23P01" && (!constraint || constraint === "no_overlapping_active_holds")) return null;
    throw err;
  }
}

/** Locks the quote for one payment attempt (call 7). Same guard as every other change, plus no live lock. */
export async function lockQuoteForPayment(q: Quote, version: number, now = new Date()): Promise<Quote | null> {
  const [locked] = await db.update(quotes)
    .set({ payingUntil: new Date(now.getTime() + PAY_LOCK_MINUTES * 60_000), updatedAt: now })
    .where(and(
      eq(quotes.id, q.id), eq(quotes.status, "sent"), eq(quotes.version, version), sql`${quotes.expiresAt} > ${now}`,
      sql`(${quotes.payingUntil} IS NULL OR ${quotes.payingUntil} <= ${now})`,
    ))
    .returning();
  return locked ?? null;
}

export async function unlockQuote(quoteId: string): Promise<void> {
  await db.update(quotes).set({ payingUntil: null }).where(and(eq(quotes.id, quoteId), eq(quotes.status, "sent")));
}

/** The live (unpaid or paid) appointment of a quote, if any. */
export async function liveQuoteAppointment(quoteId: string): Promise<Appointment | undefined> {
  const [a] = await db.select().from(appointments)
    .where(and(eq(appointments.quoteId, quoteId), inArray(appointments.status, [BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.PENDING_PROVIDER, BOOKING_STATES.CONFIRMED, BOOKING_STATES.COMPLETED, BOOKING_STATES.NO_SHOW])));
  return a;
}

/**
 * Called by the Stripe webhook just before a quote booking is confirmed. Marks the quote paid when it is still
 * sent at the version that was paid. fresh = this call marked it (the first time).
 */
export async function claimQuotePaid(appt: Appointment, paidVersion: number | null): Promise<{ ok: true; fresh: boolean; quote: Quote } | { ok: false; quote: Quote | null }> {
  if (!appt.quoteId) return { ok: false, quote: null };
  const now = new Date();
  const conds = [eq(quotes.id, appt.quoteId), eq(quotes.status, "sent")];
  if (paidVersion !== null) conds.push(eq(quotes.version, paidVersion));
  const [claimed] = await db.update(quotes)
    .set({ status: "paid", paidAt: now, appointmentId: appt.id, payingUntil: null, updatedAt: now })
    .where(and(...conds)).returning();
  if (claimed) return { ok: true, fresh: true, quote: claimed };
  const [cur] = await db.select().from(quotes).where(eq(quotes.id, appt.quoteId));
  if (cur && cur.status === "paid" && cur.appointmentId === appt.id) return { ok: true, fresh: false, quote: cur };
  return { ok: false, quote: cur ?? null };
}

/** The quote changed or closed before Stripe confirmed: everything goes back and the booking is canceled. */
export async function refundUnpayableQuote(appt: Appointment, paymentIntentId: string): Promise<void> {
  let refund: { id: string; amount: number } | null = null;
  try {
    const r: any = await stripeService.createBookingRefund({
      paymentIntentId,
      reason: "requested_by_customer",
      metadata: { appointmentId: appt.id, quoteId: appt.quoteId ?? "", reason: "Quote changed or closed before payment finished" },
      idempotencyKey: `quote_closed_refund_${appt.id}`,
    });
    refund = { id: r.id, amount: Number(r.amount ?? 0) };
  } catch (err) {
    console.error(`[quotes] REFUND FAILED for unpayable quote booking ${appt.id} pi=${paymentIntentId}:`, err);
    return; // left pending: the backstop tries again (same refund key)
  }
  await db.update(appointments).set({ stripePaymentIntentId: paymentIntentId, stripeRefundId: refund.id, refundAmount: refund.amount, refundedAt: new Date(), cancellationReason: "Quote changed before payment finished" })
    .where(eq(appointments.id, appt.id)).catch((err) => console.error(`[quotes] could not record the refund on ${appt.id}:`, err));
  const { transitionAppointmentState } = await import("../bookingStateMachine");
  await transitionAppointmentState(appt.id, BOOKING_STATES.CANCELED, {
    triggeredBy: "system", triggerSource: "webhook", metadata: { action: "quote_closed_refund", stripePaymentIntentId: paymentIntentId },
  }).catch((err) => console.error(`[quotes] cancel after refund failed for ${appt.id}:`, err));
  // Everything came back, so the points code does too (as for any full refund).
  try {
    const { restorePromoForReference } = await import("../loyaltyLedger");
    await restorePromoForReference({ type: "appointment", id: appt.id });
  } catch (err) {
    console.error(`[quotes] could not give back the points code of ${appt.id}:`, err);
  }
  if (appt.holdId) await db.update(bookingHolds).set({ status: "released", updatedAt: new Date() }).where(eq(bookingHolds.id, appt.holdId)).catch(() => undefined);
  // The quote's lock is left to run out: a new attempt may already hold it.
  console.error(`[quotes] quote ${appt.quoteId} could not be paid (changed or closed); booking ${appt.id} refunded and canceled`);
}

/**
 * After a paid quote's booking is confirmed: the paid card (posted once, paid_notice_at), the request booked and
 * the extra days blocked (call 6). Safe to run more than once; every confirming path runs it. Best effort.
 */
export async function afterQuotePaid(q: Quote, appt: Appointment): Promise<void> {
  try {
    const [first] = await db.update(quotes).set({ paidNoticeAt: new Date() })
      .where(and(eq(quotes.id, q.id), sql`${quotes.paidNoticeAt} IS NULL`)).returning({ id: quotes.id });
    if (first && !(await storage.isUserBlockedEitherWay(q.senderId, q.customerId))) {
      const a = quoteAmounts(q.totalCents, q.depositCents ?? null, q.restPaid ?? "outsyde");
      await postCardMessage({
        conversationId: q.conversationId,
        senderId: q.customerId,
        recipientId: q.senderId,
        kind: "quote",
        card: {
          type: "quote", event: "paid", quoteId: q.id, version: q.version, businessId: q.businessId, appointmentId: appt.id,
          title: q.title, totalCents: q.totalCents, paymentMode: q.paymentMode, depositOrTotalCents: a.depositOrTotalCents,
          payNowCents: a.payNowCents, balanceCents: a.balanceCents, restPaid: a.restPaid, paidDirectlyCents: a.paidDirectlyCents,
          jobDate: q.jobDate, startTime: q.startTime,
          durationMinutes: q.durationMinutes, timeZone: q.timeZone,
        },
        content: quoteMessageText("paid", q.title, q.totalCents, q.paymentMode),
      });
      // Step 6a call 6: the business's Activity row (the paid card above already pushed them).
      const { noticeBusiness } = await import("./quoteNotices");
      await noticeBusiness(q, "paid", q.id);
    }
  } catch (err) {
    console.error(`[quotes] paid card failed for ${q.id}:`, err);
  }
  // Step 4a: the job record (balance schedule, auto complete), and the hold right away when the job is near.
  try {
    const { ensureQuoteJob } = await import("./quoteBalance");
    await ensureQuoteJob(q, appt);
  } catch (err) {
    console.error(`[quotes] job record failed for booking ${appt.id}:`, err);
  }
  if (q.requestId) {
    await db.update(estimateRequests).set({ status: "booked", updatedAt: new Date() })
      .where(and(eq(estimateRequests.id, q.requestId), sql`${estimateRequests.status} IN ('new', 'called', 'quoted')`))
      .catch((err) => console.error(`[quotes] request booked failed for ${q.requestId}:`, err));
  }
  const segs = isScheduled(q) ? jobDaySegments(q.jobDate, q.startTime, q.durationMinutes) : [];
  if (isScheduled(q) && segs.length > 1) {
    try {
      const existing = await db.select({ id: providerBlocks.id }).from(providerBlocks).where(eq(providerBlocks.appointmentId, appt.id)).limit(1);
      if (!existing.length) {
        const last = segs[segs.length - 1];
        const end = last.endTime === "23:59" ? new Date(localTs(last.date, "00:00").getTime() + 24 * 3600_000) : localTs(last.date, last.endTime);
        await db.insert(providerBlocks).values({
          providerType: "business", providerId: q.businessId, staffMemberId: q.staffMemberId ?? null,
          startAt: localTs(segs[1].date, "00:00"), endAt: end, blockType: "multi_day",
          title: q.title, reason: "Booked quote", appointmentId: appt.id,
        });
      }
    } catch (err) {
      console.error(`[quotes] extra day block failed for booking ${appt.id}:`, err);
    }
  }
}

/**
 * The paid steps for a confirmed quote booking, from any path that confirms it (webhook, a repeat or concurrent
 * webhook, the backstop). Does nothing for bookings without a quote or quotes not paid by this booking.
 */
export async function runQuotePaidSteps(appointmentId: string): Promise<void> {
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!appt?.quoteId || appt.status !== BOOKING_STATES.CONFIRMED) return;
  const [q] = await db.select().from(quotes).where(eq(quotes.id, appt.quoteId));
  if (!q || q.status !== "paid" || q.appointmentId !== appt.id) return;
  await afterQuotePaid(q, appt);
}

/** A quote booking ended (canceled, declined or expired): its extra day blocks are removed. */
export async function releaseQuoteBlocks(appointmentId: string): Promise<void> {
  await db.delete(providerBlocks).where(eq(providerBlocks.appointmentId, appointmentId));
}

/**
 * Call 3: the vendor keeps a quote's cancellation fee, paid like a booking share (their 2% applies). Sent from the
 * fee's own charge; a failure waits in booking_payout_issues and the hourly payout retry sends it.
 */
export async function payQuoteCancelFeeShare(appt: Appointment, feeCents: number, feeChargeId: string | null): Promise<void> {
  if (!appt.quoteId || feeCents <= 0) return;
  const { openPayoutIssue } = await import("../payouts");
  let recipient: "business" | "staff" = "business";
  let account: string | null = null;
  if (appt.staffMemberId) {
    const [s] = await db.select().from(staffMembers).where(eq(staffMembers.id, appt.staffMemberId));
    if (s?.stripeAccountId) { recipient = "staff"; account = s.stripeAccountId; }
  }
  if (!account) {
    const b = await storage.getBusiness(appt.businessId);
    account = b?.stripeAccountId ?? null;
    recipient = "business";
  }
  const share = calculateBookingFees(feeCents).vendorNetCents;
  const recipientKey = `${recipient}_cancel_fee`;
  if (!account || share <= 0) return;
  try {
    await stripeService.createBookingTransfer({
      kind: "appointment", bookingId: appt.id, recipientKey, connectedAccountId: account, amountInCents: share,
      ...(feeChargeId ? { sourceTransaction: feeChargeId } : {}),
      idempotencyKey: `transfer_appointment_${appt.id}_${recipientKey}`,
    });
  } catch (err: any) {
    await openPayoutIssue({ kind: "appointment", bookingId: appt.id, recipientKey, isBase: false, connectedAccountId: account, amountCents: share, error: err?.message || String(err) })
      .catch((e) => console.error("[quotes] could not record fee payout issue:", e));
  }
}

/** Backstop (call 10, R41 for quotes): a paid quote booking whose Stripe confirmation never arrived. */
export async function confirmMissedQuotePayments(now = new Date()): Promise<number> {
  const stale = await db.select().from(appointments).where(and(
    isNotNull(appointments.quoteId), eq(appointments.status, BOOKING_STATES.PENDING_PAYMENT), isNotNull(appointments.stripePaymentIntentId),
    lt(appointments.createdAt, new Date(now.getTime() - 2 * 60_000)),
    sql`${appointments.createdAt} > ${new Date(now.getTime() - 3 * 24 * 3600_000)}`,
  )).limit(50);
  let done = 0;
  for (const a of stale) {
    try {
      const pi: any = await stripeService.getPaymentIntent(a.stripePaymentIntentId!);
      if (pi?.status !== "succeeded") continue;
      const { WebhookHandlers } = await import("../stripe/webhookHandlers");
      await WebhookHandlers.handlePaymentIntentSucceeded(pi);
      done++;
    } catch (err) {
      console.error(`[quotes] backstop check failed for booking ${a.id}:`, err);
    }
  }
  return done;
}

