/**
 * Events & Ticketing: pure rules (no DB). Unit tests: server/events/eventRules.test.ts.
 * Plan and decisions: vault Handoffs/2026-10-18 Events & Ticketing — Audit & Design.
 */
import { randomBytes } from "crypto";
import { localDateInZone, wallClockToUtc } from "../zonedTime";

export type RefundPolicy = "no_refunds" | "until_cutoff";

/** Lowercase words joined by dashes, plus a random 6-character tail so links can't be guessed or collide. */
export function makeEventSlug(title: string, random: () => string = randomSlugTail): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return `${base || "event"}-${random()}`;
}

function randomSlugTail(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Once an event is published its refund policy can only become more flexible (Eventbrite rule):
 *   no_refunds            -> anything
 *   until_cutoff N hours  -> until_cutoff M hours with M <= N (refunds allowed closer to the event)
 */
export function isRefundPolicyChangeAllowed(
  current: { policy: RefundPolicy; cutoffHours: number | null },
  next: { policy: RefundPolicy; cutoffHours: number | null },
): boolean {
  if (current.policy === "no_refunds") return true;
  if (next.policy === "no_refunds") return false;
  if (current.cutoffHours == null || next.cutoffHours == null) return false;
  return next.cutoffHours <= current.cutoffHours;
}

export type SalesStatus = "on_sale" | "upcoming" | "ended" | "sold_out" | "locked";

export interface TicketTypeForSale {
  id: string;
  quantity: number;
  reservedCount: number;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  unlockAfterTicketTypeId: string | null;
}

/**
 * What a buyer sees for one ticket type. Event capacity applies on top: when the event is full,
 * every type shows sold out. "Locked" = opens when another type sells out ("first N free, then paid").
 */
export function ticketSalesStatus(
  t: TicketTypeForSale,
  all: TicketTypeForSale[],
  eventRemaining: number | null,
  now: Date,
): { status: SalesStatus; remaining: number } {
  const ownRemaining = Math.max(0, t.quantity - t.reservedCount);
  const remaining = eventRemaining == null ? ownRemaining : Math.min(ownRemaining, Math.max(0, eventRemaining));
  if (remaining <= 0) return { status: "sold_out", remaining: 0 };
  if (t.salesEndAt && now >= t.salesEndAt) return { status: "ended", remaining };
  if (t.unlockAfterTicketTypeId) {
    const before = all.find((x) => x.id === t.unlockAfterTicketTypeId);
    if (before && before.reservedCount < before.quantity) return { status: "locked", remaining };
  }
  if (t.salesStartAt && now < t.salesStartAt) return { status: "upcoming", remaining };
  return { status: "on_sale", remaining };
}

export interface AddressFields {
  venueName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export type AddressVisibility = "public" | "ticket_holders" | "ticket_holders_day_of";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * When ticket holders see the address on a day-of event: 9 AM on the event's local date, or 6 hours
 * before the start, whichever is earlier (so a 1 AM event still reveals the evening before).
 */
export function addressRevealAt(startsAt: Date, timeZone: string): Date {
  const nineAm = wallClockToUtc(localDateInZone(startsAt, timeZone), "09:00", timeZone);
  const sixBefore = new Date(startsAt.getTime() - SIX_HOURS_MS);
  return nineAm && nineAm.getTime() < sixBefore.getTime() ? nineAm : sixBefore;
}

/** Whether a ticket holder may see the address now. Only the day-of mode waits for the reveal time. */
export function holderCanSeeAddress(v: AddressVisibility, startsAt: Date, timeZone: string, now: Date): boolean {
  if (v !== "ticket_holders_day_of") return true;
  return now.getTime() >= addressRevealAt(startsAt, timeZone).getTime();
}

/**
 * Hidden address = only the general area (city, state) is shown. The venue name, street, postal
 * code and map pin are revealed to the host and to people holding a valid ticket (for day-of
 * events, once `holderRevealed` is true; it defaults to true).
 */
export function visibleAddress(
  a: AddressFields,
  opts: { addressVisibility: AddressVisibility; viewerIsHost: boolean; viewerHasTicket: boolean; holderRevealed?: boolean },
): AddressFields & { addressHidden: boolean } {
  const show = opts.addressVisibility === "public" || opts.viewerIsHost || (opts.viewerHasTicket && (opts.holderRevealed ?? true));
  if (show) return { ...a, addressHidden: false };
  return {
    venueName: null, addressLine1: null, addressLine2: null, postalCode: null, latitude: null, longitude: null,
    city: a.city, state: a.state, addressHidden: true,
  };
}

/** Ticket code for the QR: 16 characters from an alphabet without look-alikes (~80 bits). */
export function makeTicketCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * True when pointing `typeId` at `unlockAfterId` would make a loop
 * (A opens after B, B opens after A). `parentOf` maps each type to the one it opens after.
 */
export function wouldCreateUnlockLoop(typeId: string, unlockAfterId: string | null, parentOf: Map<string, string | null>): boolean {
  let cur: string | null = unlockAfterId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === typeId) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** Paid tickets switch. Read at call time so tests (and a restart-free env change in tests) see the current value. */
export function paidEventsEnabled(): boolean {
  return process.env.PAID_EVENTS_ENABLED === "true";
}

const MAX_EVENT_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_START_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * Event time rules. `savedEndsAt` and `started` are passed on edits: once an event has started its end time can
 * only move later, so a host can't pull the payout date earlier. Its start time can't change at all then: moving a
 * started event's start into the future would make it "not started" again, and a second edit could pull the end in.
 */
export function checkTimes(
  startsAt: Date, endsAt: Date, now: Date, startChanged: boolean, savedEndsAt?: Date, started?: boolean,
): string | null {
  if (started && startChanged) return "Once the event has started, its start time can't change.";
  if (startChanged && startsAt <= now) return "The event can't start in the past.";
  if (endsAt <= startsAt) return "The event has to end after it starts.";
  if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_LENGTH_MS) return "An event can last 30 days at most.";
  if (startsAt.getTime() - now.getTime() > MAX_START_AHEAD_MS) return "An event can start at most 2 years from now.";
  if (started && savedEndsAt && endsAt < savedEndsAt) return "Once the event has started, the end time can only move later.";
  return null;
}
