# Event Host Payouts (PR 5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every host type can set up payouts; each host is paid once per event 3 days after it ends; refunds after a payout are recovered from the host; paid publishing opens only behind `PAID_EVENTS_ENABLED` (off).

**Architecture:** New module `server/events/hostPayouts.ts` (payout accounts, readiness, routes) and `server/events/eventPayouts.ts` (payout + recovery job steps), new tables in migration 061, additive branches in connect-return/refresh and `account.updated`. Booking payouts (`server/payouts.ts`, `booking_payout_issues`) are not touched.

**Tech Stack:** TypeScript, Express, drizzle `sql` over neon-http (no transactions), Stripe Node, local Postgres 16 + HTTP Stripe stub for tests.

**Spec:** `docs/superpowers/specs/2026-10-19-event-host-payouts-design.md`

## Global Constraints
- Every multi-row change is ONE SQL statement; data-modifying CTEs end with a runtime-value guard `('GUARD_X:' || count)::int`.
- Return id lists as `string_agg(id, ',')`, never arrays (local proxy drops arrays).
- Every money step: claim UPDATE first, fixed idempotency key, safe to run twice. No job lock exists.
- Ticket/payout Stripe metadata never contains `orderId` or `bookingId`.
- No change to `server/payouts.ts`, `booking_payout_issues`, `bookingSettlement.ts`, existing connect-return/refresh types, existing `account.updated` branches, fees.ts, ticketRefunds.ts.
- `PAID_EVENTS_ENABLED` unset or anything but `"true"` = today's behaviour exactly.
- Customer copy: real punctuation, no dashes, never a fee percentage.
- Migration 061 idempotent (`IF NOT EXISTS`), run in Neon `muddy-violet-59386933` by Claude before merge, verified read-only. Never `npm run db:migrate` / `drizzle-kit push` on production.
- Tests on localhost only. Baseline to keep: ticketRefunds.http 79/0, ticketCheckout.http 41/0, tickets.http 55/0, events.http 61/0, eventRules 32/0, ticketFees 12/0, `tsc` 59 errors (same as main).

## Review Focus
1. A refund requested in the same second the payout is created: the ticket must be either excluded from the amount or stamped and later recovered, never both and never neither. (Task 6 test `race: refund vs payout create`.)
2. The job runs twice at once (deploy overlap): one transfer only. (Task 6 test `two runs send one transfer`.)
3. A transfer that went through but wasn't saved (crash after Stripe): next run records it, doesn't resend. (Task 6 test `sent but unsaved transfer is recorded`.)
4. Host's account loses payouts_enabled between publish and payout day: payout `held`, admin emailed once, resumes when ready. (Task 6 test `held then resumes`.)
5. Owed recovery larger than the next event payout: payout never goes to 0 or negative; remainder stays owed. (Task 7 test `owed bigger than payout`.)

---

### Task 0: Regression check (read-only, before any code)

Follow vault `Operations/Regression Check Protocol.md`. Output a report to Legend; no build until he has it.

- [ ] **Step 1:** For each file this plan modifies (`server/routes.ts` connect-return/refresh, `server/stripe/webhookHandlers.ts` handleConnectAccountUpdated, `server/stripe/stripeService.ts`, `server/events/eventsRouter.ts` publish + PATCH, `server/events/ticketsRouter.ts` create/patch type, `server/bookingStateMachine.ts` cleanup job, `server/index.ts` router mount, `shared/` none): list every caller and consumer (grep), with file:line.
- [ ] **Step 2:** Grep all 9 client repos (backend audit list + Dia Lux, Lana both branches) for `connect-return`, `connect-refresh`, `stripe-return`, `PAID_TICKETS_NOT_AVAILABLE`, `/api/events`, `ends_at`/`endsAt`. Expected: only backend hits for the event paths; connect-return types used by clients unchanged.
- [ ] **Step 3:** Neon read-only: confirm no `user_payout_accounts`, `event_payouts`, `event_payout_recoveries` tables and no `tickets.payout_id`; events/tickets/ticket_orders row counts.
- [ ] **Step 4:** Send Legend the report (consumers, verdict per consumer).

### Task 1: Migration 061

**Files:**
- Create: `migrations/061_event_host_payouts.sql`

**Interfaces:**
- Produces tables:
  - `user_payout_accounts(user_id VARCHAR(36) PK REFERENCES users(id), stripe_account_id TEXT NOT NULL UNIQUE, onboarding_complete BOOLEAN NOT NULL DEFAULT false, last_event_at TIMESTAMPTZ, created_at, updated_at)`
  - `event_payouts(id VARCHAR(36) PK DEFAULT gen_random_uuid(), event_id VARCHAR(36) NOT NULL UNIQUE REFERENCES events(id), destination_type TEXT CHECK IN ('user','business','photographer'), connected_account_id TEXT NULL, gross_cents INT NOT NULL CHECK > 0, deducted_cents INT NOT NULL DEFAULT 0 CHECK >= 0, amount_cents INT NOT NULL CHECK > 0, CHECK amount_cents = gross_cents - deducted_cents, status TEXT NOT NULL DEFAULT 'pending' CHECK IN ('pending','paid','held','review'), hold_reason TEXT, attempts INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, last_error TEXT, alerted_at TIMESTAMPTZ, transfer_id TEXT, paid_at TIMESTAMPTZ, created_at, updated_at)` + partial index on `(next_attempt_at) WHERE status IN ('pending','held')`
  - `event_payout_recoveries(id PK, ticket_id VARCHAR(36) NOT NULL UNIQUE REFERENCES tickets(id), payout_id VARCHAR(36) NOT NULL REFERENCES event_payouts(id), connected_account_id TEXT NOT NULL, amount_cents INT NOT NULL CHECK > 0, status TEXT NOT NULL DEFAULT 'pending' CHECK IN ('pending','reversed','owed','recovered'), reversal_id TEXT, recovered_from_payout_id VARCHAR(36) REFERENCES event_payouts(id), attempts INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, last_error TEXT, alerted_at TIMESTAMPTZ, created_at, updated_at)` + index `(connected_account_id) WHERE status = 'owed'`
  - `tickets.payout_id VARCHAR(36) NULL REFERENCES event_payouts(id)` + index
  - `connected_account_id` on `event_payouts` is set when sending (NULL while held for no account).

- [ ] **Step 1:** Write the migration (header comment: why, Legend decisions, "run in Neon by Claude").
- [ ] **Step 2:** Apply to local Postgres twice. Expected: second run no errors (idempotent).
- [ ] **Step 3:** Local negative checks with psql: amount ≠ gross − deducted refused; duplicate event payout refused; duplicate ticket recovery refused; status 'sent' refused. Expected: 4 errors.
- [ ] **Step 4:** Commit `Events payouts: migration 061`.

### Task 2: Stripe helpers (additive)

**Files:**
- Modify: `server/stripe/stripeService.ts` (append methods; nothing existing changes)

**Interfaces:**
- Produces on `stripeService`:
  - `createHostConnectAccount(email: string, userId: string): Promise<Stripe.Account>`: express, individual, card_payments + transfers, `business_profile.mcc: "7922"`, metadata `{ role: "host", userId }`.
  - `getPayoutReadiness(accountId: string): Promise<{ ready: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }>`; `ready = chargesEnabled && payoutsEnabled`.
  - `findEventPayoutTransfer(eventId: string, payoutId: string): Promise<{ id: string; amount: number } | null>`: lists transfers with `transfer_group: event_<eventId>`, returns one whose `metadata.payoutId === payoutId`.
  - `createEventPayoutTransfer(p: { eventId; payoutId; destination; amountCents }): Promise<{ id: string }>`: key `event_payout_<payoutId>`, group `event_<eventId>`, metadata `{ type: "event_payout", eventId, payoutId }`.
  - `reverseEventPayoutTransfer(p: { transferId; ticketId; amountCents }): Promise<{ id: string }>`: `transfers.createReversal`, key `event_recovery_<ticketId>`, metadata `{ type: "event_payout_recovery", ticketId }`.
  - `isInsufficientFundsError(err: unknown): boolean`: same match as payouts.ts:44-45 (copy, don't import).

- [ ] **Step 1:** Add the methods. **Step 2:** `npx tsc --noEmit | grep -c error` → 59. **Step 3:** Commit.

(Behaviour is tested through Tasks 3, 6, 7 with the stub.)

### Task 3: Payout accounts, readiness, routes

**Files:**
- Create: `server/events/hostPayouts.ts`
- Modify: `server/index.ts` (mount `hostPayoutsRouter` on `/api/events` BEFORE `eventsRouter`, so `/payouts/*` isn't caught by `/:id`)
- Test: `server/events/eventPayouts.http.test.ts` (new; same scaffold as ticketRefunds.http.test.ts, stub gains `/v1/accounts`, `/v1/account_links`, `/v1/transfers`, `/v1/transfers/:id/reversals`, with switches `failTransfer`, `insufficient`, `accountState`)

**Interfaces:**
- Produces:
  - `type PayoutDestination = { destinationType: "user" | "business" | "photographer"; accountId: string | null; localReady: boolean }`
  - `hostPayoutDestination(event: { host_type; host_user_id; host_business_id; host_photographer_id }): Promise<PayoutDestination>` (user → `user_payout_accounts.onboarding_complete`; business/photographer → `stripe_onboarding_complete` and `stripe_account_id`)
  - `isHostReady(event, s?: Pick<StripeLike, "getPayoutReadiness">): Promise<{ ready: boolean; reason: "no_account" | "not_complete" | "stripe_not_ready" | null }>`: local first, then live Stripe.
  - Routes: `POST /api/events/payouts/setup-link` body `{ web?: boolean }` → `{ success, url }`; `GET /api/events/payouts/status?hostType=user|business|photographer` → `{ success, hostType, hasAccount, ready, needsSetup }` (ownership: business = caller's approved business, photographer = caller's profile, same rule as event create).
  - Return URLs: `${BACKEND}/api/stripe/connect-return?account=<id>&type=host` (or `host-web`); refresh likewise.

- [ ] **Step 1: Failing tests** in eventPayouts.http.test.ts:
  - `setup-link creates one host account`: two calls → stub saw 1 `POST /v1/accounts` with `metadata[role]=host`, `capabilities[card_payments][requested]=true`, `capabilities[transfers][requested]=true`; 1 row in `user_payout_accounts`.
  - `setup-link replaces an unreachable account once`: stub returns `account_invalid` on links for the saved id → new account saved.
  - `status for a user host`: before → `{hasAccount:false, ready:false, needsSetup:true}`; after flag true + stub ready → `ready:true`.
  - `status for a business host uses the business account`: no new account created.
  - `no auth → 401 NO_AUTH`; `hostType=business without a business → 403`.
- [ ] **Step 2:** Run → fail (404s).
- [ ] **Step 3:** Implement; reuse `isUnreachableConnectAccountError` (stripeService.ts:1457).
- [ ] **Step 4:** Run → pass. Existing events/tickets/ticketCheckout/ticketRefunds suites unchanged.
- [ ] **Step 5:** Commit.

### Task 4: Connect return + webhook branch for hosts

**Files:**
- Modify: `server/routes.ts` connect-return (≈:11069) and connect-refresh (≈:11147): new `if (req.query.type === 'host' || req.query.type === 'host-web')` block placed right after the `vendor-site` block, returning before existing code.
- Modify: `server/stripe/webhookHandlers.ts` `handleConnectAccountUpdated` (:2367): at the top, `if (metadata.role === 'host') return handleHostAccountUpdated(account, eventCreatedAt)`; before the final "No business, photographer, or staff member found" log, try `user_payout_accounts` by account id.

**Interfaces:**
- Produces: `handleHostAccountUpdated(account, eventCreatedAt): Promise<void>` exported from `hostPayouts.ts`: stale guard on `last_event_at`, sets `onboarding_complete = true` only when `charges_enabled && details_submitted`, never writes false, always writes `last_event_at`. One SQL statement.
- Redirects: `host` → `outsyde://stripe-return?status=complete&type=host` (refresh: `status=refresh`); `host-web` → `${FRONTEND_URL}/events/payouts?stripe=done` (refresh: `stripe=refresh`). Return marks complete with the same rule (details_submitted && charges_enabled), never false.

- [ ] **Step 1: Failing tests:** `return host marks complete` (stub account charges+details true → flag true, 302 to deep link); `return host incomplete leaves false`; `return host-web redirects to /events/payouts?stripe=done`; `webhook host true then stale false keeps true`; `webhook older event ignored`; `vendor return unchanged` (302 to `outsyde://stripe-return?status=complete&type=vendor`).
- [ ] **Step 2:** Run → fail. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit.

### Task 5: Paid publish rule + end time rule

**Files:**
- Modify: `server/events/eventsRouter.ts` publish (:460-495), `checkTimes` (:121) and its PATCH caller (:394)
- Modify: `server/events/ticketsRouter.ts` create (:127) and patch (:177)
- Modify: `server/events/eventRules.ts`: add `paidEventsEnabled(): boolean` (`process.env.PAID_EVENTS_ENABLED === "true"`)
- Test: `server/events/eventRules.test.ts`, `server/events/eventPayouts.http.test.ts`

**Interfaces:**
- `checkTimes(startsAt, endsAt, now, startChanged, savedEndsAt?: Date, started?: boolean)`: when `started && endsAt < savedEndsAt` → `"Once the event has started, the end time can only move later."`
- Publish SQL: the `NOT EXISTS paid` condition becomes `(NOT EXISTS paid OR ${paidAllowed})` where `paidAllowed` = switch on AND `isHostReady` returned ready (checked before the UPDATE). Failure codes: switch off → existing `PAID_TICKETS_NOT_AVAILABLE`; switch on, host not ready → `409 PAYOUTS_NOT_SET_UP` "Set up payouts before selling paid tickets."
- Ticket type create/patch on published events: same two codes, same order.

- [ ] **Step 1: Failing tests:** eventRules: `end earlier after start refused`, `end later after start ok`, `end earlier before start ok`. HTTP (server started WITHOUT the switch): `publish paid → PAID_TICKETS_NOT_AVAILABLE` (unchanged). HTTP with a second server process started with `PAID_EVENTS_ENABLED=true` on another port (test env `EV_TEST_BASE_URL_PAID`): `publish paid, host not set up → PAYOUTS_NOT_SET_UP`; `publish paid, host ready → 200`; `add paid type to published event, ready → 201`.
- [ ] **Step 2–4:** fail, implement, pass. Existing events.http 61/0 and tickets.http 55/0 still pass on the switch-off server.
- [ ] **Step 5:** Commit.

### Task 6: Event payout job

**Files:**
- Create: `server/events/eventPayouts.ts`
- Modify: `server/bookingStateMachine.ts`: new step after the ticket refund step, own try/catch, `runEventPayoutJob()`
- Modify: `server/events/ticketNotices.ts`: `notifyPayoutSent(payoutId: string): Promise<void>` (push to host user: title "Payout sent", body "Your payout for <event title> is on its way to your bank.")
- Test: `server/events/eventPayouts.http.test.ts`

**Interfaces:**
- Produces:
  - `type PayoutStripe = Pick<stripeService, "getPayoutReadiness" | "findEventPayoutTransfer" | "createEventPayoutTransfer">`
  - `createDuePayouts(limit = 20): Promise<string>` (comma list of new payout ids): ONE statement per event. Due = `status = 'published' AND ends_at + interval '3 days' <= now()`, no `event_payouts` row, no order with `status IN ('pending','refunding') AND needs_review_at IS NULL`. Stamps `tickets.payout_id` for `valid` tickets on `completed` orders with `payout_id IS NULL`; `gross` = sum of their `host_net_cents`; skip insert when gross = 0 (no stamps either). Deduction (owed recoveries for the same destination account) is added in Task 7.
  - `sendPayout(payoutId: string, s?: PayoutStripe): Promise<"paid" | "held" | "retry" | "insufficient" | "review" | "not_due">`: claim (`attempts + 1`, `next_attempt_at` = now + backoff, `WHERE status IN ('pending','held') AND (next_attempt_at IS NULL OR next_attempt_at <= now())`); resolve destination + live readiness → not ready: `held` + `hold_reason`, `next_attempt_at = now() + 1 hour`, admin email once (`alerted_at`); existing transfer found → record `paid`; else create transfer; success → `paid`, `transfer_id`, `paid_at`, `notifyPayoutSent`. Insufficient funds → `pending`, `attempts` NOT counted (decrement back), `next_attempt_at = now() + 1 hour`, admin email when `alerted_at` null or > 24h. Other error → backoff `min(60, 2^(attempts-1))` minutes; attempts ≥ 5 → `review` + admin email.
  - `runEventPayoutJob(s?): Promise<{ created: number; paid: number; held: number; review: number }>`: `createDuePayouts` then `sendPayout` for up to 20 due rows, least recently tried first.
- Paused events: not due (status ≠ published); a payout row already created keeps going (call: created before the pause).

- [ ] **Step 1: Failing tests** (events created with ends_at in the past via direct SQL on local PG):
  - `not due before ends_at + 3 days`; `due creates one payout = sum of valid host_net` (e.g. 2 tickets $20 → 1960×2 = 3920).
  - `refunded and cancelled tickets excluded`; `pending order blocks`; `refunding order blocks`; `flagged order doesn't block and isn't paid`.
  - `free event → no payout row, no Stripe call`; `cancelled event → no payout`.
  - `two runs send one transfer` (run job twice concurrently with Promise.all → stub saw 1 transfer).
  - `sent but unsaved transfer is recorded` (stub already holds transfer with metadata.payoutId → no new POST, row `paid`).
  - `held then resumes` (stub not ready → `held`, 1 admin email; flip ready, advance `next_attempt_at` → `paid`).
  - `insufficient keeps pending, emails once per 24h, attempts unchanged`.
  - `other error 5 times → review, one admin email`.
  - `race: refund vs payout create` (Promise.all of host refund request and createDuePayouts on a 2-ticket order; then assert: either ticket not stamped and gross excludes it, or stamped and status refunded → Task 7 recovery covers it).
  - `host push on paid` (recording sendPush).
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** Commit.

### Task 7: Recoveries (refunds after payout) + deduction

**Files:**
- Modify: `server/events/eventPayouts.ts`
- Test: `server/events/eventPayouts.http.test.ts`

**Interfaces:**
- Produces:
  - `openRecoveries(limit = 50): Promise<number>`: one INSERT … SELECT: tickets `status = 'refunded'` whose `payout_id` points to a `paid` payout, no recovery row → `pending` with `amount_cents = host_net_cents`, `connected_account_id` from the payout. `ON CONFLICT (ticket_id) DO NOTHING`.
  - `processRecovery(id, s?): Promise<"reversed" | "owed" | "retry" | "not_due">`: claim like sendPayout; `reverseEventPayoutTransfer`; success → `reversed`; insufficient funds → `owed` at once; other errors → backoff, after 5 → `owed`.
  - `alertOldOwed()`: owed rows older than 30 days with `alerted_at` null → one admin email listing them, set `alerted_at`.
  - `createDuePayouts` (from Task 6) now also, in the same statement: picks `owed` recoveries for the same `connected_account_id` (oldest first) whose running sum stays `< gross` (payout stays > 0), sets them `recovered` + `recovered_from_payout_id`, and `deducted_cents` = their sum. The destination account is resolved inside the statement by host_type joins (user_payout_accounts / businesses / photographers); if NULL, no deduction.
  - `runEventPayoutJob` calls `openRecoveries`, then `processRecovery` (up to 20 due), then `alertOldOwed`.
- Owed stays owed for a host with no later event (Legend: collect or write off by hand).

- [ ] **Step 1: Failing tests:** `refund after payout opens one recovery`; `reversal success → reversed (stub saw reversal with key event_recovery_<ticketId>)`; `insufficient → owed`; `owed deducted from next event payout` (gross 3920, owed 1960 → amount 1960, deducted 1960, recovery `recovered`); `owed bigger than payout` (owed 5000 + 1000, gross 3920 → only 1000 deducted, 5000 stays owed, amount 2920); `owed older than 30 days → one admin email`; `refund before payout → no recovery`.
- [ ] **Step 2–4:** fail, implement, pass. **Step 5:** Commit.

### Task 8: Full verification, review, Neon, PR

- [ ] **Step 1:** Run every suite: eventPayouts.http (all pass), ticketRefunds 79/0, ticketCheckout 41/0, tickets 55/0, events 61/0, eventRules (32 + new)/0, ticketFees 12/0, payouts.test (booking, with `PAYOUT_LOCAL_PG`) same as main; `tsc` 59.
- [ ] **Step 2:** Mutation checks (temporarily break: claim WHERE, idempotency key, deduction cap, switch check) → a test fails each time; revert.
- [ ] **Step 3:** Independent reviewer agent (superpowers:requesting-code-review) on the branch diff vs main; check every finding against code (superpowers:receiving-code-review); fix.
- [ ] **Step 4:** Run migration 061 in Neon as one transaction; verify read-only (tables, columns, checks, indexes, 0 rows).
- [ ] **Step 5:** Open PR with `gh api -X POST repos/1outsyde/outsyde-backend/pulls`; show Legend the diff (+/-) summary; Legend merges. After merge: check Render live in the built-in browser (`GET /api/events/payouts/status` without auth → `NO_AUTH`), update board + vault, including a SQL runbook note for moving a payout out of `review` (`UPDATE event_payouts SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = ... AND status = 'review'`).
