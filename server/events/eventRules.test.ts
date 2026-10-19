/**
 * Events & Ticketing pure rules. Run: npx tsx server/events/eventRules.test.ts
 * Mutation checks:
 *  - change `<=` to `<` in isRefundPolicyChangeAllowed → "same cutoff stays allowed" fails.
 *  - drop the eventRemaining min in ticketSalesStatus → "event capacity caps every type" fails.
 *  - drop the locked check → "paid tier locked while free remains" fails.
 *  - return `show = true` in visibleAddress → "street hidden from strangers" fails.
 */
import {
  isRefundPolicyChangeAllowed, isValidTimeZone, makeEventSlug, ticketSalesStatus, visibleAddress,
  type TicketTypeForSale,
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
