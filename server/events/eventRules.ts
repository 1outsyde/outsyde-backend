/**
 * Events & Ticketing: pure rules (no DB). Unit tests: server/events/eventRules.test.ts.
 * Plan and decisions: vault Handoffs/2026-10-18 Events & Ticketing — Audit & Design.
 */
import { randomBytes } from "crypto";

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

/**
 * Hidden address = only the general area (city, state) is shown. The venue name, street, postal
 * code and map pin are revealed to the host and to people holding a valid ticket.
 */
export function visibleAddress(
  a: AddressFields,
  opts: { addressVisibility: "public" | "ticket_holders"; viewerIsHost: boolean; viewerHasTicket: boolean },
): AddressFields & { addressHidden: boolean } {
  const show = opts.addressVisibility === "public" || opts.viewerIsHost || opts.viewerHasTicket;
  if (show) return { ...a, addressHidden: false };
  return {
    venueName: null, addressLine1: null, addressLine2: null, postalCode: null, latitude: null, longitude: null,
    city: a.city, state: a.state, addressHidden: true,
  };
}
