# Event host payouts (Events & Ticketing Phase 2, PR 5a): design

Status: approved in chat by Legend 2026-10-19 ("it seems good so far, we will handle disputes later").
Audit basis: backend main `0c0b300`; vault note `Handoffs/2026-10-19 Events & Ticketing — Next Chat (Payouts) Start Here` (audit + decisions section).

## Why
Paid tickets can't be published today (eventsRouter.ts:473, :489; ticketsRouter.ts:127, :177) because hosts have no way to get paid. Ticket money sits on Outsyde's Stripe platform balance (createPlatformPaymentIntent, no transfer). This PR lets every host type set up payouts, pays each host once per event 3 days after it ends, takes refunds made after a payout back from the host, and opens paid publishing behind a switch that stays off.

## Goals
1. A plain customer (users row, no business or photographer profile) can set up a Stripe payout account.
2. Business and photographer hosts use the account they already have.
3. One transfer per event, due `ends_at + 3 days`, never twice, never more than the host's share of valid tickets.
4. A refund after the host was paid is recovered from the host (Legend 2026-10-19).
5. Paid publishing opens only when the switch is on AND the host's account can take money.

## Non-goals (this PR)
- Disputes / chargebacks and Stripe dashboard refund sync (later, board item p5-stripe-sync; Legend 2026-10-19: "we will handle disputes later").
- Daily Outsyde-to-bank payout job (PR 5b). Stripe stays on automatic Mon + Fri payouts with a $100 minimum until Legend flips it after 5b.
- App and web screens (Phase 3 web, Phase 4 app). No client calls the new routes yet.
- Admin events money view (Phase 3).
- Any change to booking or product payouts.

## Anti-goals (failure even if it "works")
- Any change in behaviour for bookings, products, payouts.ts, booking_payout_issues, existing connect-return types or existing account.updated branches.
- Paying a host twice, paying for refunded tickets without recovering it, or paying before the event ended + 3 days.
- Turning paid tickets on in production by default.
- Adding columns to `users` (full-row selects and serializers read it everywhere).

## Decided (Legend)
- Fee rules unchanged: host gets ticket price minus 2%, saved per ticket at sale (`tickets.host_net_cents`).
- One payout per event, 3 days after it ends.
- Refund after payout: reverse it from the host's Stripe account; if that fails, take it from their next payout.
- Chargebacks: same rule, but built later with dispute webhooks.
- Two PRs, paid stays off: 5a (this) and 5b (daily bank job). $100 buffer for 5b.
- Before paid launch, Stripe goes to manual payouts (Legend flips it himself).
- Owed recoveries come back only from the host's next EVENT payout (booking payouts untouched). Still owed after 30 days: one admin email, Legend collects or writes it off by hand (Legend 2026-10-19, after builder check).
- Once an event has started, its end time can only move later, never earlier (Legend 2026-10-19, after builder check). Before start, edits work as today.

## Design (Claude's calls marked "call")

### A. Payout accounts for customers
- New table `user_payout_accounts` (call): `user_id` PK FK users, `stripe_account_id` unique not null, `onboarding_complete` bool default false, `last_event_at` timestamptz, `created_at`, `updated_at`.
- Account: Stripe Express, `business_type: individual`, capabilities `card_payments` + `transfers` (transfers-only is refused in live mode, stripeService.ts:279-283), MCC 7929 or similar for events (call; final value in plan), metadata `{ role: "host", userId }`.
- Routes under `/api/events/payouts` (auth required, mounted with the events routers, no catch-all proxy covers `/api/events`):
  - `POST /setup-link` body `{ web?: boolean }`: creates the account if missing (replacing an unreachable one once, like the staff route routes.ts:16074), returns an onboarding link.
  - `GET /status`: `{ hostType, hasAccount, ready, needsSetup }` for the signed-in user's chosen host profile (query `hostType`, `businessId`/`photographerId` optional). For businesses and photographers it reports their existing account.
- Return/refresh via the existing `/api/stripe/connect-return|refresh` with two NEW types only (call): `host` → `outsyde://stripe-return?status=complete&type=host` (app handles it in Phase 4); `host-web` → `${FRONTEND_URL}/events/payouts?stripe=done|refresh` (page built in Phase 3). Marks `user_payout_accounts.onboarding_complete = true` only when `details_submitted && charges_enabled` (same as the webhook). Existing types untouched; the new branch sits before the existing ones like `vendor-site` does.
- `account.updated`: new branch for `metadata.role === "host"` (plus fallback lookup by account id in `user_payout_accounts` AFTER the existing business, photographer, staff lookups), with a stale-event guard on `last_event_at` and the true-never-goes-false guard. Existing branches untouched.

### B. "Can this host be paid" (one helper)
`hostPayoutAccount(event)` resolves the destination by `host_type`: user → `user_payout_accounts`, business → `businesses.stripe_account_id`, photographer → `photographers.stripe_account_id`. `ready` = local flag true AND account id present AND (at publish and before each transfer) a live Stripe check `charges_enabled && payouts_enabled` (call: stricter than the webhook because this is the moment money moves).

### C. Paid publish rule
`PAID_EVENTS_ENABLED` env (default off). Paid ticket types can be added to a draft as today. Publishing with an active paid type, or adding/repricing a paid type on a published event, needs switch on AND host ready; otherwise the existing `PAID_TICKETS_NOT_AVAILABLE` (switch off) or a new `PAYOUTS_NOT_SET_UP` (switch on, host not ready). With the switch off, behaviour is exactly today's.

### D. Event payout job
- New table `event_payouts` (call): one row per event (`event_id` unique), `destination_type`, `connected_account_id`, `amount_cents` (> 0), `deducted_cents` (owed recoveries taken from it), `status` (`pending`, `sending`, `paid`, `held`, `review`), `hold_reason`, `attempts`, `next_attempt_at`, `last_error`, `transfer_id`, `paid_at`, timestamps.
- `tickets.payout_id` (nullable, new column) marks which tickets a payout covered (call).
- Runs as a new step in the every-minute job (bookingStateMachine.ts), own try/catch, small LIMIT, least recently tried first.
- Due: event `status = 'published'` (call: `paused` holds, `cancelled` never pays) and `ends_at + 3 days <= now()`.
- Waits (no row change) while any order on the event is `pending` or `refunding` and NOT flagged. Flagged orders (`needs_review_at`) don't block (call, builder check): their tickets are never `valid` on a `completed` order, so they are never stamped, and the admin was already emailed about them.
- Creating the payout is ONE SQL statement: insert the `event_payouts` row, stamp `payout_id` on every `valid` ticket of `completed` orders that has none, amount = sum of their `host_net_cents` minus owed recoveries for that destination (D below, capped so amount stays > 0; remainder stays owed). Guard pattern as in ticketsRouter (runtime-value guard). An event whose stamped total is 0 gets no row (call: free events never touch Stripe).
- Sending: claim row (`attempts + 1`, `next_attempt_at` pushed out) like processTicketRefund; live readiness check; transfer from available balance with fixed key `event_payout_<payoutId>`, `transfer_group: event_<eventId>`, metadata `{ type: "event_payout", eventId, payoutId }`; before sending, look up an existing transfer in the group (same as createBookingTransfer) so a sent-but-unsaved transfer is recorded, not resent.
- Host not ready: `held` with reason; admin email once; rechecked hourly (call); goes back to `pending` when ready.
- Insufficient platform balance (call, builder check): not an error count. Status stays `pending`, retried hourly, admin email at most once every 24 hours with what's owed and the available balance (same idea as booking payouts). No source_transaction fallback (one event spans many charges).
- Other Stripe errors: backoff 1, 2, 4, 8 minutes up to 60; after 5 tries `review` + one admin email. Leaving `review` is manual for now: a documented SQL runbook in the vault (set back to `pending`, `attempts = 0`) until the Phase 3 admin view.
- Host gets an app push when paid (new NotificationType; no email, Resend quota).

### E. Refunds after a payout (recoveries)
- New table `event_payout_recoveries` (call): `ticket_id` unique, `payout_id`, `connected_account_id`, `amount_cents` (the ticket's `host_net_cents`), `status` (`pending`, `reversed`, `owed`, `recovered`), `reversal_id`, `recovered_from_payout_id`, `attempts`, `last_error`, timestamps.
- A job step finds `refunded` tickets whose `payout_id` points to a `paid` payout and that have no recovery row, inserts one (ON CONFLICT DO NOTHING). No change to ticketRefunds.ts (call: keeps the refund path untouched).
- Recovery: `transfers.createReversal(transfer_id, amount)` with key `event_recovery_<ticketId>`. Success → `reversed`. Insufficient host balance (Stripe errors by default; pending reversals are a private preview) or other repeated failure → `owed`; the next payout to the same connected account deducts it (`recovered`, `recovered_from_payout_id`). Still owed after 30 days → admin email once (call).
- A refund on a ticket stamped on a payout that is NOT yet paid: the payout pays the stamped amount, then recovery runs as above (call: keeps the amount fixed for the transfer's idempotency key).

## Constraints
- neon-http: no transactions; every multi-row change is one SQL statement with runtime-value guards.
- Every webhook step is safe to run twice; the job is the backstop. No job lock exists, so claim UPDATEs + fixed idempotency keys are mandatory.
- Ticket PaymentIntent metadata never carries `orderId`/`bookingId`.
- Migration 061 is idempotent, run in Neon by Claude before merge, verified read-only. Never db:migrate/drizzle push on production.
- Tests on localhost Postgres with the Stripe stub (extend `.dev/stripe-stub-preload.mjs` for accounts, transfers, reversals).
- Customer-facing copy: real punctuation, no dashes, no fee percentage.

### F. End time after start
Event update (eventsRouter PATCH): once `starts_at <= now()`, a new `ends_at` earlier than the saved one is refused (new error code, plain copy). Everything else about edits is unchanged.

### G. Hosting as yourself while owning a business or photographer profile (call)
`host_type = 'user'` always uses `user_payout_accounts`, even if the person also has a business, photographer, staff or influencer account. They can host as their business or photographer profile to use that account instead.

## Left to the builder
File layout inside `server/events/`, exact column types and index names, stub extensions, test structure, notification text wording (within the copy rules), MCC value.
