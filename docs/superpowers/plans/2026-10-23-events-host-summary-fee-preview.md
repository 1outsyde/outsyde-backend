# Events Step 2: Host Sales Summary + Fee Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Legend chose task by task with a reviewer). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give hosts a sales summary for their event, and let the public event page show each ticket's service fee and total before checkout.

**Architecture:** Two additive changes, no migration. The public slug route gains `event.visibility` and, per ticket type, a one-ticket fee preview from the same `calculateTicketFees` checkout uses. A new host-only `GET /api/events/:id/summary` counts sales with the same rule payouts use and reads the payout row.

**Tech Stack:** TypeScript, Express, drizzle `sql` + neon-http (`rows`), plain `npx tsx` tests on local Postgres.

**Spec:** Vault `Features/Events Phase 3 — Discover Design.md` (B3, B4). Audit and regression: vault `Handoffs/Events Step 2 (Host Summary + Fee Preview) — Audit / Regression (2026-10-23)`. Base: main `cf1f447`.

## Global Constraints
- Additive only: no existing field changes in the slug response; no change to `/:id/orders`, `/:id/manage`, checkout, refunds, payouts, fees or points.
- Fee preview per ticket type: `f = calculateTicketFees(priceCents, 1)`; `serviceFeeCents = f.unitServiceFeeCents + f.unitPerTicketFeeCents`; `buyerTotalCents = f.unitBuyerTotalCents`; both `null` when `priceCents = 0`. Must equal what checkout returns for quantity 1 (a $20 ticket gives 259 and 2259).
- No percentage, rate or buyer service fee amount in the summary. Cents and counts only.
- Summary auth: signed in (401 `NO_AUTH` otherwise); `loadActiveUser` (403 `ACCOUNT_INACTIVE` for an inactive host, same as PATCH and publish); `loadEventForHost` (404 `EVENT_NOT_FOUND` for anyone who isn't the host, including door team members).
- Sold rule (same as payouts, eventPayouts.ts:111-112): tickets with `t.status = 'valid'` on orders with `o.status = 'completed'`.
- Summary shape:
  - `ticketTypes: { ticketTypeId, name, priceCents, sold, grossCents }[]` (gross = sum of `t.price_cents`), every non-archived type including hidden, ordered by `sort_order`.
  - `totals: { sold, grossCents, hostEarningsCents (sum of t.host_net_cents, sold rule), refundedTickets, refundedCents (sum of t.price_cents for refunded tickets), refundPendingTickets (refunded tickets whose order is 'refunding') }`.
  - `payout: { expectedAt: string | null, status: "scheduled" | "paid" | "on_hold" | "payout_setup_needed" | "event_paused" | "none", amountCents: number | null, deductedCents: number | null, paidAt: string | null }`. `expectedAt = ends_at + 3 days` only when the event is published and has any paid ticket type, else null. With no payout row: "scheduled" if expectedAt is set, else "none". With a row: pending → "scheduled", paid → "paid", held with hold_reason 'event_paused' → "event_paused", held with 'no_account' or a readiness reason → "payout_setup_needed", review or any other held → "on_hold". Never send `hold_reason`, `last_error`, account or transfer ids.
- The 3-day delay: export `HOST_PAYOUT_DELAY_DAYS = 3` from a new tiny module `server/events/payoutTiming.ts`, used by the summary, with a test pinning it to 3 and a comment pointing at the SQL literal in eventPayouts.ts (the payout job SQL is not changed in this PR).
- Copy: real punctuation, no dashes, never a fee percentage. Tests on localhost only. No migration.

## Review Focus
1. Event cancelled after sales: refunds include fees, but `refundedCents` must be ticket price only. → Task 2 test `cancelled event refunds count ticket price only`.
2. A door team member opens the summary: 404, same as a stranger. → Task 2 test.
3. Free-only event: no payout date and status "none". → Task 2 test.
4. Preview equals checkout for the same type and quantity 1. → Task 1 test `preview matches checkout`.
5. Hidden ticket types: still never on the public page; still counted in the host summary. → Task 1 and Task 2 tests.

---

### Task 1: Fee preview and visibility on the public event page

**Files:** Modify `server/events/eventsRouter.ts` (slug handler ~341-405). Test: `server/events/events.http.test.ts`.

- [ ] **Step 1: Failing tests:** `visibility` is "public" or "unlisted" on the event; a $20 type has `serviceFeeCents` 259 and `buyerTotalCents` 2259; `preview matches checkout` (start a checkout for 1 ticket on a published paid event with the local Stripe stub, compare `serviceFeeCents` and `totalCents`; if publishing paid events needs PAID_EVENTS_ENABLED on the local server, set it as other paid suites do); free type has both null; hidden types still absent; draft and paused still 404 for strangers; no key contains "Rate" or "percent".
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** events.http, eventList.http, tickets.http, ticketCheckout.http → pass; tsc 59.
- [ ] **Step 5: Commit** `feat(events): fee preview and visibility on the event page`

### Task 2: Host sales summary

**Files:** Create `server/events/payoutTiming.ts`; modify `server/events/ticketRefunds.ts` (add the route next to `/:id/orders`); test: create `server/events/eventSummary.http.test.ts`.

- [ ] **Step 1: Failing tests:** 401 without auth; 403 inactive host; 404 stranger, door team member, unknown id; mixed orders (completed paid, completed free RSVP, refunded by buyer, refunding, pending checkout, cancelled free) give exact per-type and total numbers; `hostEarningsCents` equals the sum the payout job would pay; `cancelled event refunds count ticket price only`; payout states: no row with published paid event → scheduled with expectedAt = ends_at + 3 days; free-only → none, expectedAt null; draft → expectedAt null; rows for pending, paid (paidAt set), held event_paused, held no_account, review map as specified; response never contains `hold_reason`, `last_error`, `transfer`, `account`, `serviceFee`, "0.08" or "0.02"; `HOST_PAYOUT_DELAY_DAYS === 3`; `/mine`, `/slug/x`, `/door/mine` still resolve.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** eventSummary.http, ticketRefunds.http, eventPayouts-related suites that run locally, doorTeam.http → pass; tsc 59.
- [ ] **Step 5: Commit** `feat(events): host sales summary`

### Task 3: Verification and hand-off
- [ ] All event and door suites pass locally; tsc 59.
- [ ] Whole-branch review; one fix wave if needed; re-review.
- [ ] No migration. Push, open PR with +/− summary; Legend merges; check live.
