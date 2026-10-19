/**
 * Events & Ticketing pure rules. Run: npx tsx server/events/eventRules.test.ts
 * Mutation checks:
 *  - change `<=` to `<` in isRefundPolicyChangeAllowed → "same cutoff stays allowed" fails.
 *  - drop the eventRemaining min in ticketSalesStatus → "event capacity caps every type" fails.
 *  - drop the locked check → "paid tier locked while free remains" fails.
 *  - return `show = true` in visibleAddress → "street hidden from strangers" fails.
 *  - drop `if (cur === typeId) return true` in wouldCreateUnlockLoop → the loop checks fail.
 */
import {
  checkTimes, isRefundPolicyChangeAllowed, isValidTimeZone, paidEventsEnabled, makeEventSlug, makeTicketCode, ticketSalesStatus, visibleAddress,
  wouldCreateUnlockLoop, type TicketTypeForSale,
} from "./eventRules";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

// Slugs
const fixed = () => "abc234";
assert(makeEventSlug("Halloween Party 2026!", fixed) === "halloween-party-2026-abc234", "slug from title", makeEventSlug("Halloween Party 2026!", fixed));
assert(makeEventSlug("Café Noël", fixed) === "cafe-noel-abc234", "accents removed");
assert(makeEventSlug("!!!", fixed) === "event-abc234", "empty title falls back to 'event'");
assert(makeEventSlug("a".repeat(80), fixed).length === 50 + 7, "base capped at 50 characters");
assert(/^[a-z0-9-]+-[a-z2-9]{6}$/.test(makeEventSlug("Brunch")), "random tail is 6 safe characters", makeEventSlug("Brunch"));
assert(makeEventSlug("Brunch") !== makeEventSlug("Brunch"), "two slugs for the same title differ");

// Time zones
assert(isValidTimeZone("America/New_York"), "valid time zone");
assert(!isValidTimeZone("Mars/Base"), "unknown time zone refused");
assert(!isValidTimeZone(""), "empty time zone refused");

// Refund policy only becomes more flexible once published
assert(isRefundPolicyChangeAllowed({ policy: "no_refunds", cutoffHours: null }, { policy: "until_cutoff", cutoffHours: 24 }), "no refunds -> refunds allowed");
assert(!isRefundPolicyChangeAllowed({ policy: "until_cutoff", cutoffHours: 24 }, { policy: "no_refunds", cutoffHours: null }), "refunds -> no refunds refused");
assert(isRefundPolicyChangeAllowed({ policy: "until_cutoff", cutoffHours: 72 }, { policy: "until_cutoff", cutoffHours: 24 }), "72h -> 24h allowed (more flexible)");
assert(!isRefundPolicyChangeAllowed({ policy: "until_cutoff", cutoffHours: 24 }, { policy: "until_cutoff", cutoffHours: 72 }), "24h -> 72h refused (stricter)");
assert(isRefundPolicyChangeAllowed({ policy: "until_cutoff", cutoffHours: 24 }, { policy: "until_cutoff", cutoffHours: 24 }), "same cutoff stays allowed");

// Ticket sales status
const now = new Date("2026-11-01T12:00:00Z");
const free: TicketTypeForSale = { id: "free", quantity: 10, reservedCount: 4, salesStartAt: null, salesEndAt: null, unlockAfterTicketTypeId: null };
const paid: TicketTypeForSale = { id: "paid", quantity: 50, reservedCount: 0, salesStartAt: null, salesEndAt: null, unlockAfterTicketTypeId: "free" };
let s = ticketSalesStatus(free, [free, paid], null, now);
assert(s.status === "on_sale" && s.remaining === 6, "free tier on sale with 6 left", s);
s = ticketSalesStatus(paid, [free, paid], null, now);
assert(s.status === "locked", "paid tier locked while free remains", s);
const freeGone = { ...free, reservedCount: 10 };
s = ticketSalesStatus(freeGone, [freeGone, paid], null, now);
assert(s.status === "sold_out" && s.remaining === 0, "free tier sold out", s);
s = ticketSalesStatus(paid, [freeGone, paid], null, now);
assert(s.status === "on_sale", "paid tier opens when free sells out", s);
s = ticketSalesStatus(paid, [freeGone, paid], 3, now);
assert(s.status === "on_sale" && s.remaining === 3, "event capacity caps every type", s);
s = ticketSalesStatus(paid, [freeGone, paid], 0, now);
assert(s.status === "sold_out", "full event = sold out", s);
s = ticketSalesStatus({ ...free, salesStartAt: new Date("2026-11-02T00:00:00Z") }, [free], null, now);
assert(s.status === "upcoming", "sales not started yet", s);
s = ticketSalesStatus({ ...free, salesEndAt: new Date("2026-11-01T11:00:00Z") }, [free], null, now);
assert(s.status === "ended", "sales ended", s);

// Address
const addr = { venueName: "The Loft", addressLine1: "1 Main St", addressLine2: null, city: "Freeport", state: "NY", postalCode: "11520", latitude: 40.6, longitude: -73.5 };
let a = visibleAddress(addr, { addressVisibility: "ticket_holders", viewerIsHost: false, viewerHasTicket: false });
assert(a.addressHidden && a.addressLine1 === null && a.venueName === null && a.latitude === null && a.city === "Freeport", "street hidden from strangers, city shown", a);
a = visibleAddress(addr, { addressVisibility: "ticket_holders", viewerIsHost: false, viewerHasTicket: true });
assert(!a.addressHidden && a.addressLine1 === "1 Main St", "ticket holder sees the street");
a = visibleAddress(addr, { addressVisibility: "ticket_holders", viewerIsHost: true, viewerHasTicket: false });
assert(!a.addressHidden && a.postalCode === "11520", "host sees the street");
a = visibleAddress(addr, { addressVisibility: "public", viewerIsHost: false, viewerHasTicket: false });
assert(!a.addressHidden && a.venueName === "The Loft", "public address shown to everyone");

// Ticket codes
const codes = new Set(Array.from({ length: 2000 }, () => makeTicketCode()));
assert(codes.size === 2000, "2000 ticket codes all different");
assert([...codes].every((c) => /^[A-HJ-NP-Z2-9]{16}$/.test(c)), "codes are 16 characters with no look-alikes (no 0, O, 1, I)");

// Unlock loops
const parents = new Map<string, string | null>([["a", null], ["b", "a"], ["c", "b"]]);
assert(!wouldCreateUnlockLoop("d", "c", parents), "new type after the last one is fine");
assert(wouldCreateUnlockLoop("a", "c", parents), "a after c (c after b after a) is a loop");
assert(wouldCreateUnlockLoop("b", "b", parents), "a type can't open after itself");
assert(!wouldCreateUnlockLoop("c", null, parents), "clearing the unlock is fine");

// End time after the event has started
{
  const now = new Date("2026-11-01T12:00:00Z");
  const starts = new Date("2026-11-01T10:00:00Z");
  const saved = new Date("2026-11-01T14:00:00Z");
  const MSG = "Once the event has started, the end time can only move later.";
  assert(checkTimes(starts, new Date("2026-11-01T13:00:00Z"), now, false, saved, true) === MSG, "end earlier after start refused");
  assert(checkTimes(starts, new Date("2026-11-01T15:00:00Z"), now, false, saved, true) === null, "end later after start ok");
  assert(checkTimes(starts, saved, now, false, saved, true) === null, "end unchanged after start ok");
  const future = new Date("2026-11-02T10:00:00Z");
  assert(checkTimes(future, new Date("2026-11-02T11:00:00Z"), now, false, new Date("2026-11-02T14:00:00Z"), false) === null, "end earlier before start ok");
  assert(checkTimes(starts, new Date("2026-11-01T13:00:00Z"), now, false) === null, "no saved end given: rule not applied");
  // Final review fix: once started, the start time can't move (else a later edit could pull the end, and the payout, in).
  const START_MSG = "Once the event has started, its start time can't change.";
  assert(checkTimes(new Date("2026-11-01T12:05:00Z"), saved, now, true, saved, true) === START_MSG, "start moved into the future after start refused");
  assert(checkTimes(new Date("2026-11-01T09:00:00Z"), saved, now, true, saved, true) === START_MSG, "start moved earlier after start refused with the same copy");
  assert(checkTimes(new Date("2026-11-01T12:05:00Z"), new Date("2026-11-01T13:00:00Z"), now, true, saved, true) === START_MSG, "start and earlier end together after start refused");
  assert(checkTimes(starts, saved, now, false, saved, true) === null, "start sent unchanged after start ok");
  assert(checkTimes(new Date("2026-11-02T11:00:00Z"), new Date("2026-11-02T14:00:00Z"), now, true, new Date("2026-11-02T14:00:00Z"), false) === null, "start moved before start ok");
  assert(!/[-\u2013\u2014]/.test(START_MSG), "start copy has no dashes");
}

// Paid events switch
{
  const prev = process.env.PAID_EVENTS_ENABLED;
  delete process.env.PAID_EVENTS_ENABLED;
  assert(paidEventsEnabled() === false, "switch unset: off");
  process.env.PAID_EVENTS_ENABLED = "true";
  assert(paidEventsEnabled() === true, "switch 'true': on (read at call time)");
  process.env.PAID_EVENTS_ENABLED = "1";
  assert(paidEventsEnabled() === false, "anything but 'true': off");
  if (prev === undefined) delete process.env.PAID_EVENTS_ENABLED; else process.env.PAID_EVENTS_ENABLED = prev;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
