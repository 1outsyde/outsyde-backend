/**
 * Event ticket fee tests. Run: npx tsx server/ticketFees.test.ts
 * Mutation checks: drop the `free ?` guards → "free ticket has no fees" fails; use 0.08 for the
 * platform fee → "$20 ticket: host gets $19.60" fails.
 */
import { calculateTicketFees, TICKET_PER_TICKET_FEE_CENTS, TICKET_FEE_MODEL_VERSION } from './fees';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string, d?: unknown) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.error(`  ❌ ${n}`, d ?? ''); } };

let f = calculateTicketFees(2000, 1);
assert(f.unitServiceFeeCents === 160 && f.unitPerTicketFeeCents === 99 && f.totalCents === 2259, "$20 ticket: buyer pays $22.59", f);
assert(f.unitPlatformFeeCents === 40 && f.hostNetCents === 1960, "$20 ticket: host gets $19.60", f);
assert(f.outsydeGrossRevenueCents === 160 + 99 + 40, "$20 ticket: Outsyde keeps $2.99 before Stripe", f);
f = calculateTicketFees(100, 1);
assert(f.totalCents === 100 + 8 + 99 && f.hostNetCents === 98, "$1 ticket: buyer $2.07, host $0.98", f);
f = calculateTicketFees(999, 3);
assert(f.unitServiceFeeCents === 80 && f.unitPlatformFeeCents === 20, "$9.99: per-ticket fees rounded once per ticket", f);
assert(f.totalCents === (999 + 80 + 99) * 3 && f.subtotalCents === 2997 && f.hostNetCents === 979 * 3, "3 tickets = 3 times one ticket", f);
assert(f.totalCents === f.subtotalCents + f.serviceFeeCents + f.perTicketFeeCents, "order total adds up (same rule as the database)", f);
assert(f.hostNetCents === f.subtotalCents - f.platformFeeCents, "host net adds up (same rule as the database)", f);
f = calculateTicketFees(0, 2);
assert(f.totalCents === 0 && f.serviceFeeCents === 0 && f.perTicketFeeCents === 0 && f.platformFeeCents === 0, "free ticket has no fees", f);
assert(TICKET_PER_TICKET_FEE_CENTS === 99 && TICKET_FEE_MODEL_VERSION === 'tickets-v1', "constants");
let threw = false; try { calculateTicketFees(10.5, 1); } catch { threw = true; }
assert(threw, "fractional cents refused");
threw = false; try { calculateTicketFees(1000, 0); } catch { threw = true; }
assert(threw, "zero quantity refused");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
