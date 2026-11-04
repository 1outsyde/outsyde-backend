/**
 * Quotes (Quotes in Messages, step 2). Pure rules: no database, no network.
 *
 * Legend 2026-11-04 (all recommended):
 *   1. A quote expires 7 days after it is sent, or when the job starts if that comes sooner, so it can never be
 *      paid after the job has started.
 *   2. Editing is allowed until it is paid; each edit is a new version and resets the 7 days.
 *   3. Staff with a login send from their own chat; the quote records the staff member (paid in step 3).
 *   4. Title, date, start time, length, total and deposit or full are required; service and extras note are not.
 *   5. The quote email is built but off until the goutsyde.com quote page exists (step 5).
 *   6. Several open quotes are allowed.
 *   7. A quote does not block the calendar; the time is taken when it is paid (step 3).
 * Money: same as bookings. Deposit or full price is paid now plus the service fee (fees.ts quoteDeposit, the
 * function the booking PaymentIntent uses); the balance is held later (step 4). Copy never shows the fee rate.
 */
import { quoteDeposit } from "../fees";
import { wallClockToUtc } from "../zonedTime";

export const QUOTE_VALID_DAYS = 7;
export const QUOTE_MIN_CENTS = 700;
export const QUOTE_MAX_CENTS = 10_000_000;
const MAX_TITLE = 120;
const MAX_DETAILS = 2000;
const MAX_EXTRAS = 300;
const MIN_MINUTES = 15;
const MAX_MINUTES = 3 * 24 * 60;

export type QuotePaymentMode = "deposit" | "full";
export type QuoteStatus = "sent" | "withdrawn" | "declined" | "expired" | "paid";
export type QuoteEvent = "sent" | "updated" | "withdrawn" | "declined" | "expired";

export interface QuoteInput {
  title: string;
  details: string | null;
  extrasNote: string | null;
  jobDate: string;
  startTime: string;
  durationMinutes: number;
  totalCents: number;
  paymentMode: QuotePaymentMode;
  depositCents: number | null;
}

type Fail = { ok: false; field: string; message: string };

function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const isWholeCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Checks and cleans what a business sends for a quote. */
export function checkQuoteInput(raw: unknown): { ok: true; value: QuoteInput } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "body", message: "The quote is not valid" };
  const b = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const title = text(b.title).replace(/\s+/g, " ");
  if (!title) return { ok: false, field: "title", message: "Give the quote a title" };
  if (title.length > MAX_TITLE) return { ok: false, field: "title", message: `The title can be up to ${MAX_TITLE} characters` };
  if (b.details !== undefined && b.details !== null && typeof b.details !== "string") return { ok: false, field: "details", message: "Details must be text" };
  const details = text(b.details);
  if (details.length > MAX_DETAILS) return { ok: false, field: "details", message: `Details can be up to ${MAX_DETAILS} characters` };
  if (b.extrasNote !== undefined && b.extrasNote !== null && typeof b.extrasNote !== "string") return { ok: false, field: "extrasNote", message: "The extras note must be text" };
  const extrasNote = text(b.extrasNote);
  if (extrasNote.length > MAX_EXTRAS) return { ok: false, field: "extrasNote", message: `The extras note can be up to ${MAX_EXTRAS} characters` };

  const jobDate = text(b.jobDate);
  if (!isRealDate(jobDate)) return { ok: false, field: "jobDate", message: "Choose the date of the job" };
  const startTime = text(b.startTime);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) return { ok: false, field: "startTime", message: "Choose a start time" };
  const durationMinutes = b.durationMinutes;
  if (!isWholeCents(durationMinutes) || durationMinutes < MIN_MINUTES || durationMinutes > MAX_MINUTES) {
    return { ok: false, field: "durationMinutes", message: "The job length must be between 15 minutes and 3 days" };
  }

  const totalCents = b.totalCents;
  if (!isWholeCents(totalCents) || totalCents < QUOTE_MIN_CENTS) return { ok: false, field: "totalCents", message: "The total must be at least $7.00" };
  if (totalCents > QUOTE_MAX_CENTS) return { ok: false, field: "totalCents", message: "The total can be up to $100,000.00" };

  const paymentMode = b.paymentMode;
  if (paymentMode !== "deposit" && paymentMode !== "full") return { ok: false, field: "paymentMode", message: "Choose a deposit or full payment" };
  let depositCents: number | null = null;
  if (paymentMode === "deposit") {
    const d = b.depositCents;
    if (!isWholeCents(d)) return { ok: false, field: "depositCents", message: "Enter the deposit" };
    if (d < QUOTE_MIN_CENTS) return { ok: false, field: "depositCents", message: "The deposit must be at least $7.00" };
    if (d >= totalCents) return { ok: false, field: "depositCents", message: "The deposit must be less than the total. Choose full payment instead." };
    depositCents = d;
  } else if (b.depositCents !== undefined && b.depositCents !== null) {
    return { ok: false, field: "depositCents", message: "A full payment quote has no deposit" };
  }

  return {
    ok: true,
    value: { title, details: details || null, extrasNote: extrasNote || null, jobDate, startTime, durationMinutes, totalCents, paymentMode, depositCents },
  };
}

/** When the job starts and when the quote expires (decision 1). The start must be in the future. */
export function quoteTiming(
  input: { jobDate: string; startTime: string },
  timeZone: string,
  now: Date,
): { ok: true; startsAt: Date; expiresAt: Date } | Fail {
  const startsAt = wallClockToUtc(input.jobDate, input.startTime, timeZone);
  if (!startsAt) return { ok: false, field: "jobDate", message: "Choose the date and start time of the job" };
  if (startsAt.getTime() <= now.getTime()) return { ok: false, field: "startTime", message: "The job must start in the future" };
  const sevenDays = new Date(now.getTime() + QUOTE_VALID_DAYS * 24 * 60 * 60 * 1000);
  return { ok: true, startsAt, expiresAt: startsAt < sevenDays ? startsAt : sevenDays };
}

/** What the customer pays now and later. Same fee function as the booking PaymentIntent. */
export function quoteAmounts(totalCents: number, depositCents: number | null): {
  totalCents: number; dueNowCents: number; serviceFeeCents: number; chargeNowCents: number; balanceCents: number;
} {
  const q = quoteDeposit(totalCents, depositCents);
  return {
    totalCents,
    dueNowCents: q.chargeAmountCents,
    serviceFeeCents: q.feeBreakdown.consumerServiceFeeCents,
    chargeNowCents: q.dueNowCents,
    balanceCents: q.dueAtAppointmentCents,
  };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The text of a quote card. Older app builds show only this text, so it reads on its own. */
export function quoteMessageText(event: QuoteEvent, title: string, totalCents: number): string {
  const t = title.trim();
  switch (event) {
    case "sent": return `Sent a quote for ${t}, ${formatCents(totalCents)} total.`;
    case "updated": return `Updated the quote for ${t}, ${formatCents(totalCents)} total.`;
    case "withdrawn": return `Withdrew the quote for ${t}.`;
    case "declined": return `Declined the quote for ${t}.`;
    case "expired": return `The quote for ${t} expired.`;
  }
}

/** A sent quote past its expiry reads as expired even before the expiry job has marked it. */
export function effectiveStatus(q: { status: string; expiresAt: Date | string }, now: Date): QuoteStatus {
  if (q.status === "sent" && new Date(q.expiresAt).getTime() <= now.getTime()) return "expired";
  return q.status as QuoteStatus;
}
