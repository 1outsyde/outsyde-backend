/**
 * Subscription lifecycle constants (step 1.0b, decided by Legend 2026-10-19).
 *
 * A failed payment marks the plan late at once. Listings and benefits keep working for GRACE_DAYS,
 * counted from vendor_subscriptions.past_due_since (when the run of failures began, never updated_at).
 * A reminder goes out on REMINDER_DAY; on day GRACE_DAYS the plan is treated as inactive and the
 * system pauses the business's live products and services. Stripe keeps retrying (Smart Retries,
 * up to 8 times in 2 weeks) and cancels the subscription when every retry fails.
 */
export const SUBSCRIPTION_GRACE_DAYS = 7;
export const SUBSCRIPTION_REMINDER_DAY = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the grace period ends for a run of failed payments that began at `pastDueSince`. */
export function graceEndsAt(pastDueSince: Date, graceDays: number = SUBSCRIPTION_GRACE_DAYS): Date {
  return new Date(pastDueSince.getTime() + graceDays * DAY_MS);
}

/** Whole days since the run of failed payments began (0 on the first day). */
export function daysPastDue(pastDueSince: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - pastDueSince.getTime()) / DAY_MS);
}

/** Read a timestamp column that may arrive as a Date or a string (neon-http returns text). */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value) {
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
