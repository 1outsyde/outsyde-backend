/**
 * Quotes step 4b-2b (extras). Pure rules: no database, no network.
 *
 * Legend 2026-11-05 (B1 to B4, E2 to E7):
 *   - The owner or the staff member who sent the quote sends extras, from payment until Job complete. Each $1 to
 *     $10,000, up to 10 per booking, all together up to the quote total. They can withdraw one before it's answered.
 *   - Only the customer's Approve adds one. It is held on the card right then, on session, so a bad card fails there.
 *     A new approval replaces the hold with one for the new total: one charge at Job complete.
 *   - A card hold lasts about 7 days. More than 6 days before the end: the card is checked without reserving money,
 *     and the hold is placed with the balance, 24 hours before (retried 12 hours before, then Update your card; Job
 *     complete waits until it is held).
 *   - Each extra carries its own service fee and 2% (fees.ts quoteExtraSplit). Unanswered extras lapse at Job
 *     complete. An approved extra is final. Never paid (the rare backup): a reminder after 24 hours, and the vendor
 *     sees Extras unpaid; Outsyde does not pay the vendor for them.
 */
import { quoteExtraSplit } from "../fees";
import { formatCents } from "./quoteRules";
import { balanceHoldTimes } from "./quoteBalanceRules";

export const EXTRA_MIN_CENTS = 100;
export const EXTRA_MAX_CENTS = 1_000_000;
export const MAX_EXTRAS = 10;
export const HOLD_NOW_DAYS = 6;
export const UNPAID_REMINDER_HOURS = 24;
const MIN_DESC = 3;
const MAX_DESC = 200;

/** Statuses that count toward the 10 and the quote total. */
export const LIVE_EXTRA_STATUSES = ["proposed", "approving", "approved"] as const;

export type ExtraInput = { description: string; amountCents: number };
export function checkExtraInput(raw: unknown): { ok: true; value: ExtraInput } | { ok: false; field: string; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "body", message: "The extra is not valid" };
  const b = raw as Record<string, unknown>;
  const description = typeof b.description === "string" ? b.description.trim().replace(/\s+/g, " ") : "";
  if (description.length < MIN_DESC) return { ok: false, field: "description", message: "Say what the extra is" };
  if (description.length > MAX_DESC) return { ok: false, field: "description", message: `Keep it to ${MAX_DESC} characters` };
  const a = b.amountCents;
  if (typeof a !== "number" || !Number.isInteger(a) || a < EXTRA_MIN_CENTS) return { ok: false, field: "amountCents", message: "An extra must be at least $1.00" };
  if (a > EXTRA_MAX_CENTS) return { ok: false, field: "amountCents", message: "An extra can be up to $10,000.00" };
  return { ok: true, value: { description, amountCents: a } };
}

/** Why a new extra can't be sent (null: it can). */
export function extrasLimitBlocker(existing: { status: string; amountCents: number }[], newAmountCents: number, quoteTotalCents: number): null | "TOO_MANY" | "OVER_TOTAL" {
  const live = existing.filter((e) => (LIVE_EXTRA_STATUSES as readonly string[]).includes(e.status));
  if (live.length >= MAX_EXTRAS) return "TOO_MANY";
  const sum = live.reduce((n, e) => n + e.amountCents, 0);
  if (sum + newAmountCents > quoteTotalCents) return "OVER_TOTAL";
  return null;
}

export type ExtrasTotals = { approvedCents: number; feeCents: number; platformFeeCents: number; vendorNetCents: number; holdCents: number };
/** The approved extras together: each with its own fee and 2%, one hold for the total. */
export function extrasTotals(amounts: number[]): ExtrasTotals {
  const t = { approvedCents: 0, feeCents: 0, platformFeeCents: 0, vendorNetCents: 0, holdCents: 0 };
  for (const a of amounts) {
    const s = quoteExtraSplit(a);
    t.approvedCents += s.balanceCents;
    t.feeCents += s.serviceFeeCents;
    t.platformFeeCents += s.platformFeeCents;
    t.vendorNetCents += s.vendorNetCents;
    t.holdCents += s.holdCents;
  }
  return t;
}

/** Held at Approve when the hold still stands at the latest Job complete (the auto complete time). */
export function holdAtApprove(autoCompleteAt: Date, now: Date): boolean {
  return autoCompleteAt.getTime() - now.getTime() <= HOLD_NOW_DAYS * 24 * 3600_000;
}

/** A far out extras hold: placed with the balance, 24 hours before (or now when sooner), retried 12 hours before. */
export function extrasHoldTimes(startsAt: Date, now: Date): { holdAt: Date; retryAt: Date | null } {
  return balanceHoldTimes(startsAt, now);
}

export const EXTRAS_CLAIM_MINUTES = 10;
/** Why Job complete must wait for the extras (null: it needn't). E3: a far out hold not held yet blocks it. */
export function extrasCompleteBlocker(p: { status: string; approvedCents: number; approveClaimedAt: Date | null } | null | undefined, now: Date): null | "EXTRAS_NOT_HELD" | "EXTRAS_BUSY" {
  if (!p) return null;
  if (p.approveClaimedAt && now.getTime() - p.approveClaimedAt.getTime() < EXTRAS_CLAIM_MINUTES * 60_000) return "EXTRAS_BUSY";
  if (p.status === "holding" || p.status === "releasing") return "EXTRAS_BUSY";
  if (p.approvedCents > 0 && (p.status === "scheduled" || p.status === "hold_failed")) return "EXTRAS_NOT_HELD";
  return null;
}

export type ExtraCardEvent = "extra_proposed" | "extra_approved" | "extra_declined" | "extra_withdrawn" | "extras_failed" | "extras_hold_failed" | "extras_reminder";
/** Card text reads on its own (older app builds show only this). No dashes, never the fee rate. */
export function extraCardText(event: ExtraCardEvent, o: { businessName: string; description: string; amountCents: number }): string {
  const name = o.businessName || "The business";
  const d = o.description.trim();
  switch (event) {
    case "extra_proposed": return `${name} added ${d}, ${formatCents(o.amountCents)} plus a service fee. Nothing is charged unless you approve.`;
    case "extra_approved": return `Approved: ${d}, ${formatCents(o.amountCents)}. It is held on the card and charged when the job is complete.`;
    case "extra_declined": return `Declined: ${d}. Nothing was added.`;
    case "extra_withdrawn": return `${name} took back ${d}. Nothing was added.`;
    case "extras_failed": return `We couldn't charge your card for the extras, ${formatCents(o.amountCents)}. Pay for extras to finish your booking.`;
    case "extras_hold_failed": return `We couldn't hold the extras, ${formatCents(o.amountCents)}, on your card. Update your card so the job can be marked complete.`;
    case "extras_reminder": return `Reminder: the extras, ${formatCents(o.amountCents)}, are still unpaid. Pay for extras to finish your booking.`;
  }
}
