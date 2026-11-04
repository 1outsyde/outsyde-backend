/**
 * Quotes (Quotes in Messages, step 2). Pure rules: no database, no network.
 *
 * Legend 2026-11-04 (all recommended):
 *   1. A quote expires 7 days after it is sent, or the day before the job if that comes sooner (step 3, call 12;
 *      a job less than 24 hours away keeps the job start), so it can never be paid after the job has started.
 *   2. Editing is allowed until it is paid; each edit is a new version and resets the 7 days.
 *   3. Staff with a login send from their own chat; the quote records the staff member (paid in step 3).
 *   4. Title, date, start time, length, total and deposit or full are required; service and extras note are not.
 *   5. The quote email is built but off until the goutsyde.com quote page exists (step 5).
 *   6. Several open quotes are allowed.
 *   7. A quote does not block the calendar; the time is taken when it is paid (step 3).
 * Money: same as bookings. Deposit or full price is paid now plus the service fee (fees.ts quoteDeposit, the
 * function the booking PaymentIntent uses); the balance is held later (step 4). Copy never shows the fee rate.
 */
import { quoteBalanceSplit, quoteDeposit } from "../fees";
import { wallClockToUtc, zoneOffsetMs } from "../zonedTime";

export const QUOTE_VALID_DAYS = 7;
export const QUOTE_MIN_CENTS = 700;
export const QUOTE_MAX_CENTS = 10_000_000;
const MAX_TITLE = 120;
const MAX_DETAILS = 2000;
const MAX_EXTRAS = 300;
const MIN_MINUTES = 15;
const MAX_MINUTES = 3 * 24 * 60;

export type QuotePaymentMode = "deposit" | "full";
/** Step 3 (Legend 2026-11-04): a service gets a date and time and becomes a booking; a product or deliverable
 *  (a cake, a dress) has an optional due date and becomes an order. */
export type QuoteKind = "service" | "product";
export type QuoteStatus = "sent" | "withdrawn" | "declined" | "expired" | "paid";
export type QuoteEvent = "sent" | "updated" | "withdrawn" | "declined" | "expired" | "paid";

export interface QuoteInput {
  kind: QuoteKind;
  dueDate: string | null;      // product quotes only, optional
  title: string;
  details: string | null;
  extrasNote: string | null;
  jobDate: string | null;      // service quotes: required; product quotes: none
  startTime: string | null;
  durationMinutes: number | null;
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

  // Step 3 (Legend 2026-11-04): the vendor picks service or product. Older clients send no kind: service.
  const kind = b.kind === undefined || b.kind === null || b.kind === "" ? "service" : b.kind;
  if (kind !== "service" && kind !== "product") return { ok: false, field: "kind", message: "Choose a service or a product" };
  const jobDate = text(b.jobDate);
  const startTime = text(b.startTime);
  const rawLen = b.durationMinutes;
  const lenGiven = rawLen !== undefined && rawLen !== null && rawLen !== "";
  const dueDate = text(b.dueDate);
  let durationMinutes: number | null = null;
  if (kind === "service") {
    if (dueDate) return { ok: false, field: "dueDate", message: "A service has a date and start time instead of a due date" };
    if (!isRealDate(jobDate)) return { ok: false, field: "jobDate", message: "Choose the date of the job" };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) return { ok: false, field: "startTime", message: "Choose a start time" };
    if (!lenGiven || !isWholeCents(rawLen) || rawLen < MIN_MINUTES || rawLen > MAX_MINUTES) {
      return { ok: false, field: "durationMinutes", message: "The job length must be between 15 minutes and 3 days" };
    }
    durationMinutes = rawLen;
  } else {
    if (jobDate || startTime || lenGiven) return { ok: false, field: jobDate ? "jobDate" : startTime ? "startTime" : "durationMinutes", message: "A product has no job time. Add a due date instead if there is one." };
    if (dueDate && !isRealDate(dueDate)) return { ok: false, field: "dueDate", message: "Choose a real due date" };
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
    value: {
      kind, dueDate: kind === "product" && dueDate ? dueDate : null,
      title, details: details || null, extrasNote: extrasNote || null,
      jobDate: kind === "service" ? jobDate : null, startTime: kind === "service" ? startTime : null, durationMinutes,
      totalCents, paymentMode, depositCents,
    },
  };
}

/** When the job starts and when the quote expires (decision 1). The start must be in the future. */
export function quoteTiming(
  input: { jobDate: string | null; startTime: string | null; dueDate?: string | null },
  timeZone: string,
  now: Date,
): { ok: true; startsAt: Date | null; expiresAt: Date } | Fail {
  const sevenDaysFromNow = new Date(now.getTime() + QUOTE_VALID_DAYS * 24 * 60 * 60 * 1000);
  if (!input.jobDate || !input.startTime) {
    // A product quote: the due date (when there is one) must not have passed in the business's time zone.
    if (input.dueDate) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      if (input.dueDate < today) return { ok: false, field: "dueDate", message: "The due date has already passed" };
    }
    return { ok: true, startsAt: null, expiresAt: sevenDaysFromNow };
  }
  const startsAt = wallClockToUtc(input.jobDate, input.startTime, timeZone);
  if (!startsAt) return { ok: false, field: "jobDate", message: "Choose the date and start time of the job" };
  // On the day clocks go forward an hour is skipped (2:30 AM never happens in New York). Read the instant back as
  // a wall clock: if it differs, the time chosen does not exist. The repeated hour when clocks go back is fine.
  const [y, mo, d] = input.jobDate.split("-").map(Number);
  const [h, mi] = input.startTime.split(":").map(Number);
  if (startsAt.getTime() + zoneOffsetMs(startsAt.getTime(), timeZone) !== Date.UTC(y, mo - 1, d, h, mi)) {
    return { ok: false, field: "startTime", message: "That time doesn't exist on that day because the clocks change. Choose another time." };
  }
  if (startsAt.getTime() <= now.getTime()) return { ok: false, field: "startTime", message: "The job must start in the future" };
  const sevenDays = new Date(now.getTime() + QUOTE_VALID_DAYS * 24 * 60 * 60 * 1000);
  // Step 3 (Legend 2026-11-04, call 12): the day before the job (24 hours before it starts), so every paid quote
  // has its full balance hold window. A job less than 24 hours away when sent keeps the job start, or a same day
  // job could never be paid.
  const dayBefore = new Date(startsAt.getTime() - 24 * 60 * 60 * 1000);
  const jobLimit = dayBefore.getTime() > now.getTime() ? dayBefore : startsAt;
  return { ok: true, startsAt, expiresAt: jobLimit < sevenDays ? jobLimit : sevenDays };
}

/**
 * What the customer pays now and later. Same fee function as the booking PaymentIntent.
 * depositOrTotalCents is the business's part (no fee); payNowCents is what the card is charged now and always
 * includes the service fee. Step 3 charges payNowCents.
 */
export function quoteAmounts(totalCents: number, depositCents: number | null): {
  totalCents: number; depositOrTotalCents: number; serviceFeeCents: number; payNowCents: number; balanceCents: number;
  balanceServiceFeeCents: number; balanceTotalCents: number;
} {
  const q = quoteDeposit(totalCents, depositCents);
  // Step 4a (split rule, additive): the balance carries its own service fee, held 24 h before and charged at Job complete.
  const b = quoteBalanceSplit(totalCents, depositCents);
  return {
    totalCents,
    depositOrTotalCents: q.chargeAmountCents,
    serviceFeeCents: q.feeBreakdown.consumerServiceFeeCents,
    payNowCents: q.dueNowCents,
    balanceCents: q.dueAtAppointmentCents,
    balanceServiceFeeCents: b.serviceFeeCents,
    balanceTotalCents: b.holdCents,
  };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The text of a quote card. Older app builds show only this text, so it reads on its own. */
export function quoteMessageText(event: QuoteEvent, title: string, totalCents: number, paymentMode: QuotePaymentMode = "deposit"): string {
  const t = title.trim();
  switch (event) {
    case "sent": return `Sent a quote for ${t}, ${formatCents(totalCents)} total.`;
    case "updated": return `Updated the quote for ${t}, ${formatCents(totalCents)} total.`;
    case "withdrawn": return `Withdrew the quote for ${t}.`;
    case "declined": return `Declined the quote for ${t}.`;
    case "expired": return `The quote for ${t} expired.`;
    case "paid": return paymentMode === "full" ? `Paid in full for ${t}, ${formatCents(totalCents)}.` : `Paid the deposit for ${t}.`;
  }
}

/** A sent quote past its expiry reads as expired even before the expiry job has marked it. */
export function effectiveStatus(q: { status: string; expiresAt: Date | string; payingUntil?: Date | string | null }, now: Date): QuoteStatus {
  // Step 3: a payment that started before the expiry may still finish, so the quote reads open until its lock ends.
  const paying = !!q.payingUntil && new Date(q.payingUntil).getTime() > now.getTime();
  if (q.status === "sent" && !paying && new Date(q.expiresAt).getTime() <= now.getTime()) return "expired";
  return q.status as QuoteStatus;
}
