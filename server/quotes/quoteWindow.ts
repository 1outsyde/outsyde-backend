/**
 * Quotes step 4b-1 (migration 100): the 6 hour Confirm or Report window after Job complete, Outsyde's review of
 * reports, the vendor's balance payout and points that follow the money. Rules: ./quoteWindowRules.ts.
 *
 * Legend 2026-11-05 (calls B5 to B14):
 *   - Confirm pays the vendor's balance share at once; Report pauses it; no answer pays it when the 6 hours end.
 *   - Reports are reviewed on the admin Refunds page (their refund_requests row). Outcomes: pay in full, partial
 *     refund, full refund (every dollar paid, fees included), from the balance first then the deposit. Final.
 *   - The balance share is its own transfer (group appointment_balance_<id>, recipient business_balance or
 *     staff_balance), to the staff member's account for a staff booking exactly like the deposit. Money rules as in
 *     quoteBalance.ts: claimed, Stripe looked up first, one key per try, bounded, retried by the quote job, Outsyde
 *     emailed while unpaid. An open card dispute on the balance pauses it until it closes (B10).
 *   - Points follow the money (B8): the deposit and balance points stay pending until the money is final (Confirm,
 *     the end of the window, the decision, or the booking ending), land on what stays paid, and come down again after
 *     any later refund. A customer cancel that keeps the deposit keeps its points; any other end earns none.
 */
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { quotes, type Appointment, type Quote, type QuoteJob } from "@shared/schema";
import { getUncachableStripeClient } from "../stripe/stripeClient";
import { postCardMessage } from "../messaging/postCard";
import { formatCents } from "./quoteRules";
import { balanceTransferGroup, quoteJobFor, refundQuoteBooking } from "./quoteBalance";
import {
  balancePayoutCents, checkReport, confirmBlocker, pointsTarget, pointsToReverse, reportBlocker, resolveOutcome,
  windowState, REPORT_REMINDER_HOURS, type MoneyLeft, type ReportOutcome, type WindowJob,
} from "./quoteWindowRules";

const BOUND = { timeout: 30_000, maxNetworkRetries: 1 } as const;
const CLAIM_MINUTES = 10;
const RETRY_MINUTES = 5;
const ENDED_SETTLE_MINUTES = 2;
const ALERT_EVERY_HOURS = 24;

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result: any = await db.execute(query);
  return (result?.rows ?? result ?? []) as T[];
}
const errMsg = (err: any) => (err?.message || String(err)).slice(0, 500);
const asDate = (v: unknown): Date | null => (v ? new Date(v as any) : null);

// ─── Outsyde alerts (Legend's inbox) ────────────────────────────────────────

let alertForTest: ((subject: string, text: string) => Promise<void>) | null = null;
/** Tests: capture the emails to Outsyde instead of sending them. */
export function setQuoteAdminAlertForTest(fn: ((subject: string, text: string) => Promise<void>) | null): void {
  alertForTest = fn;
}
async function adminAlert(subject: string, text: string): Promise<boolean> {
  try {
    if (alertForTest) { await alertForTest(subject, text); return true; }
    const { sendAdminEmail, ADMIN_NOTIFICATION_EMAIL } = await import("../emailService");
    const safe = text.replace(/[<>&]/g, "");
    return await sendAdminEmail({ to: ADMIN_NOTIFICATION_EMAIL, subject: `[Quotes] ${subject}`, html: `<p>${safe.replace(/\n/g, "<br>")}</p>`, text });
  } catch (err) {
    console.error("[quote window] admin alert failed:", err);
    return false;
  }
}

// ─── Cards ──────────────────────────────────────────────────────────────────

export type WindowCardEvent = "job_complete" | "job_confirmed" | "problem_reported" | "report_decided";

/** Card text reads on its own (older app builds show only this). No dashes, never the fee rate. */
export function windowCardText(event: WindowCardEvent, o: { businessName: string; title: string; outcome?: ReportOutcome; refundCents?: number }): string {
  const name = o.businessName || "The business";
  switch (event) {
    case "job_complete": return `The job is marked complete and the balance was charged. If something went wrong, report a problem within 6 hours. Otherwise ${name} is paid.`;
    case "job_confirmed": return "The customer confirmed the job. Your payout is on its way to your Stripe balance.";
    case "problem_reported": return "The customer reported a problem. Your payout for this job is paused while Outsyde reviews it.";
    case "report_decided":
      if (o.outcome === "full_refund") return `Outsyde reviewed the report on ${o.title.trim()}. The customer gets a full refund.`;
      if (o.outcome === "partial_refund") return `Outsyde reviewed the report on ${o.title.trim()}. The customer gets ${formatCents(o.refundCents ?? 0)} back and the rest is paid to ${name}.`;
      return `Outsyde reviewed the report on ${o.title.trim()}. ${name} is paid in full.`;
  }
}

/** Posts a window card. fromCustomer: sent by the customer to the quote's sender (the vendor side). Best effort. */
async function postWindowCard(q: Quote, job: QuoteJob, event: WindowCardEvent, fromCustomer: boolean, extra: { outcome?: ReportOutcome; refundCents?: number } = {}): Promise<void> {
  try {
    if (await storage.isUserBlockedEitherWay(q.senderId, q.customerId)) return;
    const business = await storage.getBusiness(q.businessId);
    await postCardMessage({
      conversationId: q.conversationId,
      senderId: fromCustomer ? q.customerId : q.senderId,
      recipientId: fromCustomer ? q.senderId : q.customerId,
      kind: "quote",
      card: {
        type: "quote", event, quoteId: q.id, version: q.version, businessId: q.businessId, appointmentId: job.appointmentId, title: q.title,
        windowEndsAt: job.windowEndsAt, ...(extra.outcome ? { outcome: extra.outcome, refundCents: extra.refundCents ?? 0 } : {}),
      },
      content: windowCardText(event, { businessName: business?.name ?? "", title: q.title, ...extra }),
    });
  } catch (err) {
    console.error(`[quote window] ${event} card failed for job ${job.id}:`, err);
  }
}

/** Job complete (quoteBalance.completeQuoteJob): the customer's "confirm or report" card, once. */
export async function afterJobComplete(appointmentId: string): Promise<void> {
  const [first] = await rows<{ id: string }>(sql`
    UPDATE quote_jobs SET complete_notice_at = now() WHERE appointment_id = ${appointmentId} AND complete_notice_at IS NULL RETURNING id`);
  if (!first) return;
  const job = await quoteJobFor(appointmentId);
  const [q] = job ? await db.select().from(quotes).where(eq(quotes.id, job.quoteId)) : [];
  if (job && q) await postWindowCard(q, job, "job_complete", false);
}

// ─── Money still paid ───────────────────────────────────────────────────────

/** What the customer still has paid on each payment (money, fees included), for a report's refund. */
export async function moneyLeft(appt: Appointment, job: QuoteJob | undefined | null): Promise<MoneyLeft> {
  const balanceLeft = job && job.balanceStatus === "captured" ? Math.max(0, (job.capturedCents ?? 0) - job.refundedCents) : 0;
  const d = appt.stripePaymentIntentId ? await depositMoney(appt.stripePaymentIntentId) : { received: 0, refunded: 0 };
  return { balanceLeft, depositLeft: Math.max(0, d.received - d.refunded) };
}

/** What the deposit (or full) payment took and what Stripe gave back on it. Bounded (review M6). */
async function depositMoney(paymentIntentId: string): Promise<{ received: number; refunded: number }> {
  const stripe: any = await getUncachableStripeClient();
  const pi: any = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] }, BOUND);
  const charge = pi?.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  return { received: Number(pi?.amount_received ?? 0), refunded: Number(charge?.amount_refunded ?? 0) };
}

// ─── The vendor's balance payout ────────────────────────────────────────────

/** SQL: the held balance share may be paid now (B5, B10, B13). */
const PAYABLE = sql.raw(`
  j.payout_status = 'held' AND j.balance_status = 'captured' AND j.completed_at IS NOT NULL
  AND (j.confirmed_at IS NOT NULL
       OR (j.reported_at IS NULL AND j.window_ends_at <= now())
       OR EXISTS (SELECT 1 FROM quote_reports r WHERE r.appointment_id = j.appointment_id AND r.status = 'decided' AND r.outcome IN ('pay_full', 'partial_refund')))
  AND NOT EXISTS (SELECT 1 FROM stripe_disputes d WHERE d.payment_intent_id = j.stripe_payment_intent_id AND d.outcome IS NULL)
  AND NOT EXISTS (SELECT 1 FROM booking_refund_recoveries rr WHERE rr.payment_intent_id = j.stripe_payment_intent_id AND rr.status = 'pending')`);
// Review C1: the payout is the share less the vendor's part of any refund already made. A refund still waiting in
// refund recovery would take that part again from the new transfer, so the payout waits until recovery has closed
// it (nothing sent, about 15 minutes); a refund after the payout is taken back by recovery alone.

export type PayoutOutcome = "paid" | "nothing" | "not_due" | "busy" | "failed";

/** Pays the vendor's balance share once. Never throws. */
export async function payBalanceShare(jobId: string): Promise<PayoutOutcome> {
  const tag = randomUUID();
  const [j] = await rows<any>(sql`
    UPDATE quote_jobs j SET payout_claim_tag = ${tag}, payout_claimed_at = now(), payout_attempts = j.payout_attempts + 1, updated_at = now()
     WHERE j.id = ${jobId} AND ${PAYABLE}
       AND (j.payout_claimed_at IS NULL OR j.payout_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
       AND (j.payout_next_at IS NULL OR j.payout_next_at <= now())
     RETURNING j.*`);
  if (!j) {
    const [cur] = await rows<any>(sql`SELECT payout_status, payout_claimed_at FROM quote_jobs WHERE id = ${jobId}`);
    return cur?.payout_claimed_at && new Date(cur.payout_claimed_at).getTime() > Date.now() - CLAIM_MINUTES * 60_000 ? "busy" : "not_due";
  }
  const amount = balancePayoutCents({ vendorNetCents: j.vendor_net_cents, balanceCents: j.balance_cents, capturedCents: j.captured_cents ?? 0, refundedCents: j.refunded_cents });
  if (amount <= 0) {
    await rows(sql`UPDATE quote_jobs SET payout_status = 'canceled', payout_claimed_at = NULL, updated_at = now() WHERE id = ${jobId} AND payout_claim_tag = ${tag}`);
    return "nothing";
  }
  const fail = async (msg: string, keepClaim: boolean) => {
    const [row] = await rows<any>(sql`
      UPDATE quote_jobs SET payout_error = ${msg.slice(0, 500)}, payout_next_at = now() + make_interval(mins => ${RETRY_MINUTES}),
             payout_claimed_at = CASE WHEN ${keepClaim} THEN payout_claimed_at ELSE NULL END, updated_at = now()
       WHERE id = ${jobId} AND payout_claim_tag = ${tag}
       RETURNING appointment_id, payout_alerted_at`);
    if (row && (!row.payout_alerted_at || new Date(row.payout_alerted_at).getTime() < Date.now() - ALERT_EVERY_HOURS * 3600_000)) {
      const sent = await adminAlert("Unpaid quote balance payout",
        `The vendor's balance share for quote booking ${row.appointment_id} (${formatCents(amount)}) could not be paid yet: ${msg}. It is tried again every ${RETRY_MINUTES} minutes.`);
      if (sent) await rows(sql`UPDATE quote_jobs SET payout_alerted_at = now() WHERE id = ${jobId}`);
    }
    return "failed" as const;
  };

  // Who is paid: exactly like the deposit (bookingSettlement.ts): the staff member for a staff booking, else the business.
  const appt = await storage.getAppointment(j.appointment_id);
  let recipient: "business" | "staff" = "business";
  let account: string | null = null;
  if (appt?.staffMemberId) {
    recipient = "staff";
    account = (await storage.getStaffMember(appt.staffMemberId))?.stripeAccountId ?? null;
  } else {
    account = (await storage.getBusiness(j.business_id))?.stripeAccountId ?? null;
  }
  if (!account) return fail(`no Stripe account for the ${recipient}`, false);
  const key = `${recipient}_balance`;
  const group = balanceTransferGroup(j.appointment_id);
  const record = async (t: any) => {
    await rows(sql`
      UPDATE quote_jobs SET payout_status = 'paid', payout_transfer_id = ${t.id}, payout_cents = ${Number(t.amount)}::int, payout_recipient = ${recipient},
             paid_out_at = now(), payout_error = NULL, payout_next_at = NULL, payout_claimed_at = NULL, updated_at = now()
       WHERE id = ${jobId} AND payout_claim_tag = ${tag}`);
    return "paid" as const;
  };
  const stripe: any = await getUncachableStripeClient();
  try {
    const list = await stripe.transfers.list({ transfer_group: group, limit: 100 }, BOUND);
    const prior = (list?.data ?? []).find((t: any) => t?.metadata?.recipient === key);
    if (prior) return record(prior);
  } catch (err) {
    return fail(`lookup: ${errMsg(err)}`, false);
  }
  const create = (source: string | null, suffix: string) => stripe.transfers.create({
    amount, currency: "usd", destination: account, transfer_group: group,
    metadata: { appointmentId: j.appointment_id, recipient: key, type: "quote_balance_payout" },
    ...(source ? { source_transaction: source } : {}),
  }, { idempotencyKey: `quote_balance_payout_${j.appointment_id}_${j.payout_attempts}${suffix}`, ...BOUND });
  try {
    return record(await create(null, ""));
  } catch (err: any) {
    const insufficient = err?.code === "balance_insufficient" || /insufficient (available )?funds/i.test(err?.message ?? "");
    if (insufficient && j.stripe_charge_id) {
      // Not enough available balance: send it from the customer's own balance charge (Stripe pays it once those funds are available).
      try { return record(await create(j.stripe_charge_id, "_src")); } catch (err2: any) { return fail(errMsg(err2), !err2?.statusCode); }
    }
    // No reply at all: it may have landed. Keep the claim until it runs out; the next try looks it up first.
    return fail(errMsg(err), !err?.statusCode);
  }
}

// ─── Points follow the money ────────────────────────────────────────────────

type PointsRecord = { type: "appointment" | "quote_balance"; ref: string; refundedCents: number };

/** Lands one payment's points on what stays paid (final). Pending: released at the target or rejected. Released: taken down. */
async function settleRecord(userId: string, rec: PointsRecord, keep: boolean): Promise<void> {
  const { rejectPendingForReference, releasePendingForReference, reversePointsForReference, pointsValueCents } = await import("../loyaltyLedger");
  const [p] = await rows<any>(sql`SELECT * FROM pending_points_transactions WHERE reference_type = ${rec.type} AND reference_id = ${rec.ref} LIMIT 1`);
  if (p?.status === "pending") {
    const target = keep ? Math.min(Number(p.points_earned), pointsTarget(Number(p.dollar_amount_cents), rec.refundedCents)) : 0;
    if (target <= 0) { await rejectPendingForReference(rec.type, rec.ref, "Refunded or ended"); return; }
    // The kept amount too, so the referral check at release sees what stayed paid (review M1).
    const kept = Math.max(0, Number(p.dollar_amount_cents) - Math.max(0, rec.refundedCents));
    await rows(sql`UPDATE pending_points_transactions SET points_earned = ${target}::int, outsyde_revenue_cents = ${pointsValueCents(target)}::int,
                    dollar_amount_cents = ${kept}::int, updated_at = now()
                    WHERE id = ${p.id} AND status = 'pending'`);
    await releasePendingForReference(rec.type, rec.ref, "system");
    return;
  }
  const [e] = await rows<any>(sql`
    SELECT COALESCE(SUM(points), 0)::int AS earned, COALESCE(MAX(dollar_amount_cents), 0)::int AS gross FROM point_transactions
     WHERE user_id = ${userId} AND type = 'earn' AND reference_type = ${rec.type} AND reference_id = ${rec.ref}`);
  const earned = Number(e?.earned ?? 0);
  if (earned <= 0) return;
  const [r] = await rows<any>(sql`
    SELECT COALESCE(SUM(-points), 0)::int AS back FROM point_transactions
     WHERE user_id = ${userId} AND type = 'reversal' AND reference_type = 'refund_reversal' AND reference_id = ${rec.ref}`);
  const target = keep ? Math.min(earned, pointsTarget(Number(e.gross), rec.refundedCents)) : 0;
  const n = pointsToReverse({ earned, alreadyReversed: Number(r?.back ?? 0), target });
  if (n > 0) await reversePointsForReference(userId, rec.type, rec.ref, { refundFraction: n / earned, description: "Points adjusted to what stays paid" });
}

/**
 * Points for a quote booking whose money is final, or again after a later refund. keep: the booking still stands
 * (completed), or the customer canceled and kept paying the deposit. Otherwise nothing is earned.
 */
export async function settleQuotePoints(appointmentId: string): Promise<void> {
  const appt = await storage.getAppointment(appointmentId);
  const job = await quoteJobFor(appointmentId);
  if (!appt || !job) return;
  const keep = appt.status === "completed" || (appt.status === "canceled" && appt.canceledBy === appt.clientId);
  const balanceRefunded = job.refundedCents;
  // Read from Stripe (review M2): a lost dispute on the balance is on the job but not on the booking's refund total.
  const depositRefunded = appt.stripePaymentIntentId ? (await depositMoney(appt.stripePaymentIntentId)).refunded : 0;
  await settleRecord(appt.clientId, { type: "appointment", ref: appt.id, refundedCents: depositRefunded }, keep);
  await settleRecord(appt.clientId, { type: "quote_balance", ref: job.id, refundedCents: balanceRefunded }, keep);
}

const fingerprint = sql.raw(`(COALESCE(a.refund_amount, 0) + j.refunded_cents)`);

async function settlePointsAndStamp(jobId: string, appointmentId: string): Promise<void> {
  try {
    // Read the refund fingerprint first (review M8): a refund landing during the settle is seen by the next run.
    const [fp] = await rows<{ v: number }>(sql`SELECT ${fingerprint}::int AS v FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id WHERE j.id = ${jobId}`);
    await settleQuotePoints(appointmentId);
    await rows(sql`
      UPDATE quote_jobs SET points_settled_at = COALESCE(points_settled_at, now()), points_refund_seen_cents = ${Number(fp?.v ?? 0)}::int, updated_at = now()
       WHERE id = ${jobId}`);
  } catch (err) {
    console.error(`[quote window] points for ${appointmentId} failed:`, err);
  }
}

// ─── Confirm ────────────────────────────────────────────────────────────────

const toWindowJob = (j: QuoteJob): WindowJob => ({
  completedAt: asDate(j.completedAt), windowEndsAt: asDate(j.windowEndsAt), confirmedAt: asDate(j.confirmedAt), reportedAt: asDate(j.reportedAt), payoutStatus: j.payoutStatus,
});

const CONFIRM_TEXT: Record<string, string> = {
  NOT_COMPLETE: "The job isn't marked complete yet.",
  ALREADY_CONFIRMED: "You already confirmed this job.",
  REPORTED: "You reported a problem, so Outsyde is reviewing this job.",
  WINDOW_OVER: "The 6 hours to confirm or report are over.",
};

export type WindowResult = { ok: true; job: QuoteJob } | { ok: false; status: number; code: string; message: string };

/** The customer confirms the job: the vendor's balance share is paid now and the points land. */
export async function confirmQuoteJob(q: Quote): Promise<WindowResult> {
  if (!q.appointmentId) return { ok: false, status: 409, code: "NOT_COMPLETE", message: CONFIRM_TEXT.NOT_COMPLETE };
  const [done] = await rows<{ id: string }>(sql`
    UPDATE quote_jobs SET confirmed_at = now(), updated_at = now()
     WHERE appointment_id = ${q.appointmentId} AND completed_at IS NOT NULL AND confirmed_at IS NULL AND reported_at IS NULL AND window_ends_at > now()
     RETURNING id`);
  const job = await quoteJobFor(q.appointmentId);
  if (!done || !job) {
    const code = job ? confirmBlocker(toWindowJob(job), new Date()) ?? "WINDOW_OVER" : "NOT_COMPLETE";
    return { ok: false, status: 409, code, message: CONFIRM_TEXT[code] };
  }
  await payBalanceShare(job.id);
  await settlePointsAndStamp(job.id, q.appointmentId);
  const [first] = await rows<{ id: string }>(sql`UPDATE quote_jobs SET confirmed_notice_at = now() WHERE id = ${job.id} AND confirmed_notice_at IS NULL RETURNING id`);
  const fresh = (await quoteJobFor(q.appointmentId))!;
  if (first) await postWindowCard(q, fresh, "job_confirmed", true);
  return { ok: true, job: fresh };
}

// ─── Report a problem ───────────────────────────────────────────────────────

const REPORT_TEXT: Record<string, string> = {
  NOT_COMPLETE: "You can report a problem once the job is marked complete.",
  ALREADY_CONFIRMED: "You confirmed this job, so it can't be reported now. Message the business or contact Outsyde.",
  ALREADY_REPORTED: "You already reported a problem with this job. Outsyde is reviewing it.",
  WINDOW_OVER: "The 6 hours to report a problem are over. Message the business or contact Outsyde.",
  ALREADY_PAID: "The business was already paid for this job. Message the business or contact Outsyde.",
};

export async function reportQuoteJob(q: Quote, body: { reason?: unknown; photos?: unknown }): Promise<WindowResult & { reportId?: string }> {
  const check = checkReport(body?.reason, body?.photos, process.env.R2_PUBLIC_URL);
  if (!check.ok) return { ok: false, status: 400, code: check.code, message: check.message };
  if (!q.appointmentId) return { ok: false, status: 409, code: "NOT_COMPLETE", message: REPORT_TEXT.NOT_COMPLETE };
  const job0 = await quoteJobFor(q.appointmentId);
  const appt = await storage.getAppointment(q.appointmentId);
  const block = job0 ? reportBlocker(toWindowJob(job0), new Date()) : "NOT_COMPLETE";
  if (block || !job0 || !appt) return { ok: false, status: 409, code: block ?? "NOT_COMPLETE", message: REPORT_TEXT[block ?? "NOT_COMPLETE"] };
  let left: MoneyLeft;
  try {
    left = await moneyLeft(appt, job0);
  } catch (err) {
    console.error(`[quote window] report: payment lookup failed for ${appt.id}:`, err);
    return { ok: false, status: 502, code: "TRY_AGAIN", message: "We couldn't send your report right now. Try again in a minute." };
  }
  const held = left.balanceLeft + left.depositLeft;
  const requestText = `Quote report: ${check.reason}${check.photos.length ? `\nPhotos: ${check.photos.join(" ")}` : ""}`;
  // One statement: the window claim, the admin Refunds request and the report land together or not at all.
  const [rep] = await rows<{ id: string; refund_request_id: string }>(sql`
    WITH j AS (
      UPDATE quote_jobs SET reported_at = now(), payout_status = CASE WHEN payout_status = 'held' THEN 'paused' ELSE payout_status END, updated_at = now()
       WHERE appointment_id = ${appt.id} AND completed_at IS NOT NULL AND confirmed_at IS NULL AND reported_at IS NULL
         AND window_ends_at > now() AND payout_status <> 'paid'
       RETURNING appointment_id, quote_id
    ), rr AS (
      INSERT INTO refund_requests (id, requester_id, requester_type, target_type, target_id, reason, amount, status, admin_notified_at, created_at, updated_at)
      SELECT gen_random_uuid(), ${q.customerId}, 'customer', 'appointment', j.appointment_id, ${requestText}, ${Math.max(1, held)}::int, 'pending', now(), now(), now() FROM j
      RETURNING id
    )
    INSERT INTO quote_reports (appointment_id, quote_id, refund_request_id, customer_id, reason, photos, held_cents)
    SELECT j.appointment_id, j.quote_id, rr.id, ${q.customerId}, ${check.reason}, ${JSON.stringify(check.photos)}::jsonb, ${held}::int FROM j, rr
    RETURNING id, refund_request_id`);
  if (!rep) {
    const now = await quoteJobFor(appt.id);
    const code = now ? reportBlocker(toWindowJob(now), new Date()) ?? "ALREADY_REPORTED" : "NOT_COMPLETE";
    return { ok: false, status: 409, code, message: REPORT_TEXT[code] };
  }
  const job = (await quoteJobFor(appt.id))!;
  const [first] = await rows<{ id: string }>(sql`UPDATE quote_reports SET vendor_notice_at = now() WHERE id = ${rep.id} AND vendor_notice_at IS NULL RETURNING id`);
  if (first) await postWindowCard(q, job, "problem_reported", true);
  const business = await storage.getBusiness(q.businessId);
  await adminAlert(`Problem reported on a quote: ${business?.name ?? q.businessId}`,
    `A customer reported a problem on quote booking ${appt.id} (${q.title}, ${business?.name ?? ""}). Held for review: ${formatCents(held)}.\n` +
    `Reason: ${check.reason}\n${check.photos.length ? `Photos: ${check.photos.join(" ")}\n` : ""}Decide it on the admin Refunds page (request ${rep.refund_request_id}).`);
  return { ok: true, job, reportId: rep.id };
}

// ─── Outsyde's decision ─────────────────────────────────────────────────────

export type DecideResult = { ok: true; outcome: ReportOutcome; refundCents: number; refundIds: string[] } | { ok: false; status: number; code: string; message: string };

/**
 * Decides a report once (B13). Refunds come from the balance first, then the deposit, fees included (B6). Pay in
 * full and partial refund pay the vendor's balance share (less their part of the refund); full refund never does.
 */
export async function decideQuoteReport(reportId: string, outcome: ReportOutcome, amountCents: unknown, adminId: string, adminNotes?: string | null): Promise<DecideResult> {
  const tag = randomUUID();
  const [rep] = await rows<any>(sql`
    UPDATE quote_reports SET status = 'deciding', decide_tag = ${tag}, updated_at = now()
     WHERE id = ${reportId} AND (status = 'open' OR (status = 'deciding' AND updated_at < now() - make_interval(mins => ${CLAIM_MINUTES})))
     RETURNING *`);
  if (!rep) {
    const [cur] = await rows<any>(sql`SELECT status FROM quote_reports WHERE id = ${reportId}`);
    if (cur?.status === "decided") return { ok: false, status: 400, code: "ALREADY_DECIDED", message: "Refund request has already been processed" };
    return { ok: false, status: 409, code: "BUSY", message: "This report is being decided right now. Refresh in a minute." };
  }
  const reopen = async () => { await rows(sql`UPDATE quote_reports SET status = 'open', updated_at = now() WHERE id = ${reportId} AND decide_tag = ${tag}`); };
  const appt = await storage.getAppointment(rep.appointment_id);
  const job = await quoteJobFor(rep.appointment_id);
  if (!appt || !job) { await reopen(); return { ok: false, status: 404, code: "NOT_FOUND", message: "Booking not found" }; }
  const opKey = `quote_report_${reportId}`;
  const meta = { quoteReportId: reportId, refundRequestId: rep.refund_request_id, approvedBy: adminId };
  // Review I1: another refund on this booking that didn't finish (a vendor refund whose second part failed) would be
  // finished instead of this one. Finish it now, then ask for the decision again on the new amounts.
  const [other] = await rows<{ op_key: string }>(sql`
    SELECT op_key FROM quote_refunds WHERE appointment_id = ${appt.id} AND done_at IS NULL AND op_key <> ${opKey} LIMIT 1`);
  if (other) {
    try { await refundQuoteBooking(appt, 0, other.op_key, meta); } catch (err) { console.error(`[quote window] earlier refund ${other.op_key} still failing:`, err); }
    await reopen();
    return { ok: false, status: 409, code: "EARLIER_REFUND_FINISHED", message: "An earlier refund on this booking hadn't finished, so it was finished first. Refresh, check the amounts and decide again." };
  }
  let left: MoneyLeft;
  try { left = await moneyLeft(appt, job); } catch (err) {
    await reopen();
    return { ok: false, status: 502, code: "TRY_AGAIN", message: `Couldn't read the payments: ${errMsg(err)}` };
  }
  // Review I2: a decision already under way (saved before its refund) is finished exactly as chosen, whatever this
  // call asks for: its money may already have moved.
  let res: { outcome: ReportOutcome; refundCents: number };
  if (rep.pending_outcome) {
    res = { outcome: rep.pending_outcome, refundCents: Number(rep.pending_refund_cents ?? 0) };
  } else {
    const r = resolveOutcome(outcome, amountCents, left);
    if (!r.ok) { await reopen(); return { ok: false, status: 400, code: r.code, message: r.message }; }
    res = { outcome: r.outcome, refundCents: r.refundCents };
    const [saved] = await rows<{ id: string }>(sql`
      UPDATE quote_reports SET pending_outcome = ${res.outcome}, pending_refund_cents = ${res.refundCents}::int, updated_at = now()
       WHERE id = ${reportId} AND decide_tag = ${tag} AND pending_outcome IS NULL RETURNING id`);
    if (!saved) return { ok: false, status: 409, code: "BUSY", message: "This report is being decided right now. Refresh in a minute." };
  }
  let refundIds: string[] = [];
  if (res.refundCents > 0) {
    try {
      const done = await refundQuoteBooking(appt, res.refundCents, opKey, meta, { balanceCapCents: left.balanceLeft });
      if (done.resumed) {
        await reopen();
        return { ok: false, status: 409, code: "EARLIER_REFUND_FINISHED", message: "An earlier refund on this booking was finished first. Refresh and decide again." };
      }
      refundIds = done.refundIds;
    } catch (err) {
      // The saved plan and the saved decision finish on the next try (same key); nothing is refunded twice.
      await reopen();
      return { ok: false, status: 402, code: "REFUND_FAILED", message: `Stripe refund failed: ${errMsg(err)}. Try the same decision again; nothing is refunded twice.` };
    }
  }
  const [decided] = await rows<{ id: string }>(sql`
    UPDATE quote_reports SET status = 'decided', outcome = ${res.outcome}, refund_cents = ${res.refundCents}::int, decided_by = ${adminId}, decided_at = now(),
           admin_notes = ${adminNotes ?? null}, updated_at = now()
     WHERE id = ${reportId} AND decide_tag = ${tag} RETURNING id`);
  if (!decided) return { ok: false, status: 409, code: "BUSY", message: "This report was decided meanwhile. Refresh." };
  await rows(sql`
    UPDATE refund_requests SET status = ${res.outcome === "pay_full" ? "rejected" : "approved"}, admin_notes = ${adminNotes ?? null}, resolved_at = now(), resolved_by = ${adminId}, updated_at = now()
     WHERE id = ${rep.refund_request_id}`);
  // The paused payout: paid (less the vendor's part of the refund), or never for a full refund.
  await rows(sql`
    UPDATE quote_jobs SET payout_status = CASE WHEN ${res.outcome === "full_refund"} THEN 'canceled' ELSE 'held' END, payout_next_at = NULL, updated_at = now()
     WHERE id = ${job.id} AND payout_status = 'paused'`);
  if (res.outcome !== "full_refund") await payBalanceShare(job.id);
  await settlePointsAndStamp(job.id, appt.id);
  if (res.outcome === "full_refund") {
    await storage.revokeReviewsForRefund("appointment", appt.id).catch((err) => console.error("[quote window] review revoke failed:", err));
  }
  const [q] = await db.select().from(quotes).where(eq(quotes.id, rep.quote_id));
  const fresh = (await quoteJobFor(appt.id))!;
  if (q) {
    await postWindowCard(q, fresh, "report_decided", false, { outcome: res.outcome, refundCents: res.refundCents });
  }
  return { ok: true, outcome: res.outcome, refundCents: res.refundCents, refundIds };
}

/** The report behind an admin Refunds request, if any. */
export async function reportForRefundRequest(refundRequestId: string): Promise<any | null> {
  const [r] = await rows<any>(sql`SELECT * FROM quote_reports WHERE refund_request_id = ${refundRequestId}`);
  return r ?? null;
}

/** Extra fields for the admin Refunds list (additive). */
export async function adminReportFields(refundRequestIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!refundRequestIds.length) return out;
  const list = await rows<any>(sql`SELECT * FROM quote_reports WHERE refund_request_id IN (${sql.join(refundRequestIds.map((x) => sql`${x}`), sql`, `)})`);
  for (const r of list) {
    out.set(r.refund_request_id, {
      reportId: r.id, quoteId: r.quote_id, appointmentId: r.appointment_id, status: r.status, photos: r.photos ?? [],
      maxRefundCents: r.held_cents, outcomes: ["pay_full", "partial_refund", "full_refund"],
    });
  }
  return out;
}

/** B12: the old refund request route sends quote bookings to Report a problem. */
export async function refundRequestBlocker(targetType: string, targetId: string): Promise<{ code: "USE_REPORT"; message: string } | null> {
  if (targetType !== "appointment") return null;
  const appt = await storage.getAppointment(targetId).catch(() => undefined);
  if (!appt?.quoteId) return null;
  return { code: "USE_REPORT", message: "Use Report a problem on the quote instead." };
}

// ─── The quote's JSON (additive) ────────────────────────────────────────────

export async function windowJson(q: Quote, job: QuoteJob | undefined | null, viewerId: string, canManage: boolean, now = new Date()) {
  if (!job) return { window: null, report: null, payout: null };
  const w = toWindowJob(job);
  const isCustomer = viewerId === q.customerId;
  const [r] = await rows<any>(sql`SELECT status, outcome, refund_cents, created_at, decided_at FROM quote_reports WHERE appointment_id = ${job.appointmentId}`);
  return {
    window: w.completedAt ? {
      state: windowState(w, now), endsAt: job.windowEndsAt, confirmedAt: job.confirmedAt, reportedAt: job.reportedAt,
      canConfirm: isCustomer && confirmBlocker(w, now) === null, canReport: isCustomer && reportBlocker(w, now) === null,
    } : null,
    report: r ? { status: r.status === "decided" ? "decided" : "open", outcome: r.outcome ?? null, refundCents: r.refund_cents ?? null, reportedAt: r.created_at, decidedAt: r.decided_at } : null,
    payout: canManage ? { status: job.payoutStatus, cents: job.payoutCents ?? null, paidAt: job.paidOutAt ?? null } : null,
  };
}

// ─── The job (every 5 minutes, with the quote expiry job) ───────────────────

export async function runQuoteWindowJob(now = new Date()): Promise<{ paid: number; points: number; reminders: number }> {
  let paid = 0, points = 0, reminders = 0;
  // Review I4: a booking that moved to completed while the Job complete steps never ran (a crash in between).
  const unfinished = await rows<{ appointment_id: string }>(sql`
    SELECT j.appointment_id FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id
     WHERE a.status = 'completed' AND j.completed_at IS NULL AND COALESCE(a.updated_at, a.created_at) < ${now}::timestamptz - make_interval(mins => ${ENDED_SETTLE_MINUTES}) LIMIT 25`);
  for (const u of unfinished) {
    try {
      const { finishJobComplete } = await import("./quoteBalance");
      const appt = await storage.getAppointment(u.appointment_id);
      const job = await quoteJobFor(u.appointment_id);
      if (appt && job) await finishJobComplete(appt, job, job.balanceStatus === "captured" ? job.capturedCents ?? 0 : 0, { userId: "system", via: "auto" }, now);
    } catch (err) { console.error(`[quote window] repair of ${u.appointment_id} failed:`, err); }
  }
  // Balance payouts due: confirmed, window over with no report, or a report decided pay in full or partial.
  const due = await rows<{ id: string }>(sql`
    SELECT j.id FROM quote_jobs j WHERE ${PAYABLE}
       AND (j.payout_claimed_at IS NULL OR j.payout_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
       AND (j.payout_next_at IS NULL OR j.payout_next_at <= now())
     ORDER BY j.window_ends_at LIMIT 25`);
  for (const d of due) {
    try { if ((await payBalanceShare(d.id)) === "paid") paid++; } catch (err) { console.error(`[quote window] payout ${d.id} failed:`, err); }
  }
  // Points whose money is final: the window decided (Confirm, no report by the end, a decided report), or the
  // booking ended before Job complete (a short wait so the refund of a cancel is recorded first).
  const final = await rows<{ id: string; appointment_id: string }>(sql`
    SELECT j.id, j.appointment_id FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id
     WHERE j.points_settled_at IS NULL AND (
       (a.status = 'completed' AND j.completed_at IS NOT NULL AND (j.confirmed_at IS NOT NULL OR (j.reported_at IS NULL AND j.window_ends_at <= ${now}::timestamptz)
          OR EXISTS (SELECT 1 FROM quote_reports r WHERE r.appointment_id = j.appointment_id AND r.status = 'decided')))
       OR (a.status NOT IN ('confirmed', 'completed', 'pending_payment', 'pending_provider', 'draft')
           AND COALESCE(a.updated_at, a.created_at) < ${now}::timestamptz - make_interval(mins => ${ENDED_SETTLE_MINUTES})))
     LIMIT 50`);
  // A refund after the points were settled: take them down again.
  const again = await rows<{ id: string; appointment_id: string }>(sql`
    SELECT j.id, j.appointment_id FROM quote_jobs j JOIN appointments a ON a.id = j.appointment_id
     WHERE j.points_settled_at IS NOT NULL AND j.points_refund_seen_cents IS DISTINCT FROM ${fingerprint} LIMIT 50`);
  for (const x of [...final, ...again]) { await settlePointsAndStamp(x.id, x.appointment_id); points++; }
  // Open reports: one reminder to Outsyde after 48 hours.
  const late = await rows<any>(sql`
    UPDATE quote_reports SET reminder_sent_at = now()
     WHERE status <> 'decided' AND reminder_sent_at IS NULL AND created_at < ${now}::timestamptz - make_interval(hours => ${REPORT_REMINDER_HOURS})
     RETURNING id, appointment_id, refund_request_id, held_cents`);
  for (const r of late) {
    const sent = await adminAlert("Reminder: quote report still open",
      `The report on quote booking ${r.appointment_id} has been open for ${REPORT_REMINDER_HOURS} hours. The vendor's payout stays paused until you decide it on the admin Refunds page (request ${r.refund_request_id}, ${formatCents(r.held_cents)} held).`);
    if (sent) reminders++;
    else await rows(sql`UPDATE quote_reports SET reminder_sent_at = NULL WHERE id = ${r.id}`);
  }
  return { paid, points, reminders };
}
