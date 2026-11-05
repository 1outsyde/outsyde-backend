/**
 * Quotes step 4b-1 (Confirm or Report, review outcomes, balance payout, points). Pure rules: no database, no network.
 *
 * Legend 2026-11-05 (calls B5 to B14):
 *   - After Job complete the customer has 6 hours: Confirm pays the vendor at once; Report a problem pauses the
 *     vendor's balance payout for Outsyde's review. No answer: the vendor is paid when the 6 hours end.
 *   - A report covers everything still held. Reason 10 to 1,000 characters, up to 5 photos (our uploads only),
 *     one report per booking.
 *   - Outcomes: pay in full, partial refund (an amount), full refund (everything the business was paid). The
 *     service fee is never refunded (Legend 2026-11-05). Refunds come from the extras first (4b-2b), then the
 *     balance, then the deposit.
 *     Today's admin Approve button means full refund and Reject means pay in full. Decided reports are final.
 *   - Points follow the money: points on the business's part that stays paid, released at Confirm, the end of the
 *     window or the decision.
 */

const HOUR = 3600_000;
export const WINDOW_HOURS = 6;
export const REPORT_REMINDER_HOURS = 48;
export const REPORT_REASON_MIN = 10;
export const REPORT_REASON_MAX = 1000;
export const REPORT_MAX_PHOTOS = 5;

export type WindowJob = { completedAt: Date | null; windowEndsAt: Date | null; confirmedAt: Date | null; reportedAt: Date | null; payoutStatus: string };
export type ReportOutcome = "pay_full" | "partial_refund" | "full_refund";
const OUTCOMES: readonly ReportOutcome[] = ["pay_full", "partial_refund", "full_refund"];

export function windowEndsAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + WINDOW_HOURS * HOUR);
}

export function windowState(j: WindowJob, now: Date): "not_complete" | "open" | "confirmed" | "reported" | "closed" {
  if (!j.completedAt || !j.windowEndsAt) return "not_complete";
  if (j.reportedAt) return "reported";
  if (j.confirmedAt) return "confirmed";
  return now.getTime() < j.windowEndsAt.getTime() ? "open" : "closed";
}

export function confirmBlocker(j: WindowJob, now: Date): null | "NOT_COMPLETE" | "ALREADY_CONFIRMED" | "REPORTED" | "WINDOW_OVER" {
  const st = windowState(j, now);
  if (st === "not_complete") return "NOT_COMPLETE";
  if (st === "confirmed") return "ALREADY_CONFIRMED";
  if (st === "reported") return "REPORTED";
  if (st === "closed") return "WINDOW_OVER";
  return null;
}

export function reportBlocker(j: WindowJob, now: Date): null | "NOT_COMPLETE" | "ALREADY_CONFIRMED" | "ALREADY_REPORTED" | "WINDOW_OVER" | "ALREADY_PAID" {
  const st = windowState(j, now);
  if (st === "not_complete") return "NOT_COMPLETE";
  if (st === "reported") return "ALREADY_REPORTED";
  if (st === "confirmed") return "ALREADY_CONFIRMED";
  if (st === "closed") return "WINDOW_OVER";
  if (j.payoutStatus === "paid") return "ALREADY_PAID";
  return null;
}

export type ReportCheck =
  | { ok: true; reason: string; photos: string[] }
  | { ok: false; code: "REASON_TOO_SHORT" | "REASON_TOO_LONG" | "TOO_MANY_PHOTOS" | "BAD_PHOTO"; message: string };

/** The customer's report: a reason and up to 5 photos uploaded to our storage (same rule as request photos). */
export function checkReport(reason: unknown, photos: unknown, r2Prefix: string | undefined): ReportCheck {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < REPORT_REASON_MIN) return { ok: false, code: "REASON_TOO_SHORT", message: `Tell us what went wrong in at least ${REPORT_REASON_MIN} characters.` };
  if (text.length > REPORT_REASON_MAX) return { ok: false, code: "REASON_TOO_LONG", message: `Keep it to ${REPORT_REASON_MAX.toLocaleString("en-US")} characters.` };
  const list = Array.isArray(photos) ? photos : photos == null ? [] : null;
  if (!list) return { ok: false, code: "BAD_PHOTO", message: "Photos must be a list." };
  const unique = Array.from(new Set(list));
  if (unique.length > REPORT_MAX_PHOTOS) return { ok: false, code: "TOO_MANY_PHOTOS", message: `Add up to ${REPORT_MAX_PHOTOS} photos.` };
  const prefix = r2Prefix ? (r2Prefix.endsWith("/") ? r2Prefix : `${r2Prefix}/`) : null;
  for (const p of unique) {
    if (typeof p !== "string" || !prefix || !p.startsWith(prefix) || p.length > 1000) return { ok: false, code: "BAD_PHOTO", message: "Upload the photos in the app or on the website first." };
  }
  return { ok: true, reason: text, photos: unique as string[] };
}

type BalanceMoney = { vendorNetCents: number; balanceCents: number; capturedCents: number; refundedCents: number };

/** The vendor's part of what was refunded on the balance payment. Same rule as refund recovery (computeShare). */
export function vendorPartOfRefund(j: BalanceMoney): number {
  if (!(j.refundedCents > 0) || !(j.vendorNetCents > 0)) return 0;
  const denom = Math.min(j.balanceCents, j.capturedCents);
  const ratio = denom > 0 ? Math.min(1, j.refundedCents / denom) : 1;
  return Math.min(j.vendorNetCents, Math.round(j.vendorNetCents * ratio));
}

/** What the vendor is paid for the balance: their share less their part of any refund. Never negative. */
export function balancePayoutCents(j: BalanceMoney): number {
  if (!(j.capturedCents > 0)) return 0;
  return Math.max(0, j.vendorNetCents - vendorPartOfRefund(j));
}

/** Whether the held balance share may be paid now. */
export function payoutEligible(j: WindowJob, report: { outcome: ReportOutcome | null } | null, now: Date): boolean {
  if (j.payoutStatus !== "held" || !j.completedAt || !j.windowEndsAt) return false;
  if (j.reportedAt) return report?.outcome === "pay_full" || report?.outcome === "partial_refund";
  if (j.confirmedAt) return true;
  return now.getTime() >= j.windowEndsAt.getTime();
}

/** The business's part still paid on each payment. extrasLeft: step 4b-2b (none before). */
export type MoneyLeft = { extrasLeft?: number; balanceLeft: number; depositLeft: number };
const leftTotal = (l: MoneyLeft) => Math.max(0, l.extrasLeft ?? 0) + Math.max(0, l.balanceLeft) + Math.max(0, l.depositLeft);

/** A refund for a report: the extras first, then the balance, then the deposit. The business's part (no fee). */
export function splitReportRefund(amountCents: number, left: MoneyLeft): { ok: true; fromExtras: number; fromBalance: number; fromDeposit: number } | { ok: false; message: string } {
  const total = leftTotal(left);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, message: "The refund must be more than $0." };
  if (amountCents > total) return { ok: false, message: "The refund can't be more than the customer paid." };
  const fromExtras = Math.min(amountCents, Math.max(0, left.extrasLeft ?? 0));
  const fromBalance = Math.min(amountCents - fromExtras, Math.max(0, left.balanceLeft));
  return { ok: true, fromExtras, fromBalance, fromDeposit: amountCents - fromExtras - fromBalance };
}

export type OutcomeResult =
  | { ok: true; outcome: ReportOutcome; refundCents: number }
  | { ok: false; code: "OUTCOME_INVALID" | "AMOUNT_REQUIRED" | "AMOUNT_INVALID" | "USE_FULL_REFUND" | "NOTHING_TO_REFUND"; message: string };

/** Your decision on a report, checked against what is still paid. */
export function resolveOutcome(outcome: unknown, amountCents: unknown, left: MoneyLeft): OutcomeResult {
  if (!OUTCOMES.includes(outcome as ReportOutcome)) return { ok: false, code: "OUTCOME_INVALID", message: "Choose pay in full, partial refund or full refund." };
  const total = leftTotal(left);
  if (outcome === "pay_full") return { ok: true, outcome, refundCents: 0 };
  if (total <= 0) return { ok: false, code: "NOTHING_TO_REFUND", message: "Nothing is left to refund on this booking." };
  if (outcome === "full_refund") return { ok: true, outcome, refundCents: total };
  if (amountCents === undefined || amountCents === null) return { ok: false, code: "AMOUNT_REQUIRED", message: "Enter the amount to refund." };
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, code: "AMOUNT_INVALID", message: "Enter the amount in whole cents, more than $0." };
  if (amountCents >= total) return { ok: false, code: "USE_FULL_REFUND", message: "That is everything the customer paid. Choose full refund instead." };
  return { ok: true, outcome: "partial_refund", refundCents: amountCents };
}

/** The admin page's Approve and Reject (B7): Approve with no outcome is a full refund, Reject pays in full. */
export function legacyDecision(status: string, outcome: ReportOutcome | undefined): ReportOutcome | null {
  if (outcome) return outcome;
  if (status === "approved") return "full_refund";
  if (status === "rejected") return "pay_full";
  return null;
}

/** Points on one payment: its full points in proportion to the business's part still paid (fees are never refunded). */
export function pointsTarget(fullPoints: number, baseCents: number, refundedCents: number): number {
  if (!(baseCents > 0) || !(fullPoints > 0)) return 0;
  const kept = Math.max(0, baseCents - Math.max(0, refundedCents));
  return Math.round((fullPoints * kept) / baseCents);
}

/** Points to take back so an earned payment lands on its target. Never adds back what was already taken. */
export function pointsToReverse(p: { earned: number; alreadyReversed: number; target: number }): number {
  return Math.max(0, p.earned - p.alreadyReversed - p.target);
}
