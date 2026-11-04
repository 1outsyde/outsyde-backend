/**
 * Quotes step 4a (balance hold, Job complete, cancels). Pure rules: no database, no network.
 *
 * Legend 2026-11-04 (final):
 *   - Hold: the balance + its service fee (fees.ts quoteBalanceSplit) is held on the saved card, manual capture,
 *     off session, 24 h before the job, or right after payment when the job is sooner. A failed hold is tried
 *     again 12 h before, then the customer gets an "Update your card" card and push. Still unpaid at the start:
 *     the vendor may cancel and keep the deposit.
 *   - Job complete: the owner or the staff member who sent the quote, or automatically 2 h after the scheduled end
 *     (multi day included). Services only. The booking moves to completed (no new booking status).
 *   - Cancel after the hold: the vendor's policy first, take only what is owed from the hold, release the rest.
 */

const HOUR = 3600_000;
export const HOLD_LEAD_HOURS = 24;
export const RETRY_LEAD_HOURS = 12;
export const AUTO_COMPLETE_AFTER_HOURS = 2;

/** When the balance is held, and when a failed hold is tried again (null: no time left for a retry). */
export function balanceHoldTimes(startsAt: Date, paidAt: Date): { holdAt: Date; retryAt: Date | null } {
  const start = startsAt.getTime();
  const holdAt = new Date(Math.max(paidAt.getTime(), start - HOLD_LEAD_HOURS * HOUR));
  // 12 h before; when the first try is already inside those 12 h, one retry an hour after it.
  const retry = Math.max(start - RETRY_LEAD_HOURS * HOUR, holdAt.getTime() + HOUR);
  return { holdAt, retryAt: retry < start ? new Date(retry) : null };
}

/** When Job complete runs on its own: 2 h after the scheduled end (start + length, multi day included). */
export function autoCompleteAt(startsAt: Date, durationMinutes: number): Date {
  return new Date(startsAt.getTime() + durationMinutes * 60_000 + AUTO_COMPLETE_AFTER_HOURS * HOUR);
}

/** A cancel after the hold: what is taken from the hold and what is released. */
export function splitHold(heldCents: number, owedCents: number): { captureCents: number; releaseCents: number } {
  const owed = Number.isFinite(owedCents) ? Math.max(0, Math.round(owedCents)) : 0;
  const captureCents = Math.min(heldCents, owed);
  return { captureCents, releaseCents: heldCents - captureCents };
}

export type JobCompleteBlock = "ALREADY_COMPLETE" | "NOT_CONFIRMED" | "PRODUCT_QUOTE" | "NOT_STARTED" | "BALANCE_NOT_HELD";

/**
 * Why a quote booking can't be marked complete right now (null: it can). balanceStatus is the balance charge's
 * status, null when the quote was paid in full (nothing left to charge).
 */
export function jobCompleteBlocker(
  b: { status: string; quoteKind: string | null; startsAt: Date | null; balanceStatus: string | null; completedAt: Date | null },
  now: Date,
): JobCompleteBlock | null {
  if (b.status === "completed" || b.completedAt) return "ALREADY_COMPLETE";
  if (b.status !== "confirmed") return "NOT_CONFIRMED";
  if (b.quoteKind === "product") return "PRODUCT_QUOTE";
  if (!b.startsAt || b.startsAt.getTime() > now.getTime()) return "NOT_STARTED";
  if (b.balanceStatus === "captured" || b.balanceStatus === "capturing") return "ALREADY_COMPLETE";
  if (b.balanceStatus !== null && b.balanceStatus !== "held") return "BALANCE_NOT_HELD";
  return null;
}
