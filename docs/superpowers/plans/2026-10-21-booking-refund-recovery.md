# Booking Refund Recovery (P1 #5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Legend chose task by task with a reviewer). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any refund of a booking whose seller was already paid, take the seller's share back from their Stripe balance; if short, alert them and take it back as soon as Outsyde pays them again.

**Architecture:** `createBookingRefund` records each Stripe refund (id + PaymentIntent) in a new table `booking_refund_recoveries` (migration 065), best effort. A new module `server/bookingRecoveries.ts` (a step in the every-minute job) resolves the booking from the PaymentIntent, computes the share from what Stripe actually sent, reverses it with the event-recovery claim/lock/lookup rules, marks it `owed` when the seller's balance is short, alerts the seller once, and retries owed rows when a new transfer to the same Connect account is seen in the DB (booking settled, payout issue paid, event payout paid) and hourly. Event recoveries get the same seller alert. No payout or refund amount changes; no route or response changes.

**Tech Stack:** TypeScript, Express backend, drizzle `sql` + neon-http (`rows` helper, server/events/eventsRouter.ts:38), Stripe SDK ^20, local Postgres 16 for tests.

**Spec:** `docs/superpowers/specs/2026-10-21-booking-refund-recovery-design.md` (section G = builder check answers + Legend's staff decision). Audit: scratch `booking-refund-recovery-audit.md` (sections A to H).

## Global Constraints
- Never change a refund amount, a refund route's behaviour or response, a payout amount, or a payout idempotency key. The refund hook never throws and never awaits longer than one DB insert.
- Share = intended payout × min(1, refund ÷ min(base, amount_received)); base = `deposit_amount_cents ?? total_price`; intended payout = `calculateBookingFees(base).vendorNetCents` for appointments, `vendor_net` for shoot bookings; rounded to the cent; capped at (sum over the booking's transfers of `amount − amount_reversed`) minus what earlier recoveries of that booking already reversed or own. Never negative.
- Recipient: appointment with `staff_member_id` → that staff member's account (the staff member pays, even if the business started the refund); else the business; shoot → the photographer. The Connect account used is the destination of the booking's transfers in Stripe, not a DB guess.
- Only refunds with Stripe `created >= 1792540800` (2026-10-21 00:00 UTC) are recovered (`RECOVERY_START_UNIX`); event recoveries owed before the deploy get no seller alert (`created_at` before the migration time is skipped by the alert query: `owed_at`/`created_at >= RECOVERY_START`).
- Every Stripe call bounded `{ timeoutMs: 30000, maxNetworkRetries: 1 }`; claim with 10 minute lock + ownership tag (copy `OWNER_TAG`, `retake` from server/events/eventPayouts.ts); look up reversals with `metadata.refundId` on each transfer before every reverse; idempotency key per try `booking_recovery_<refundId>_<transferId>_<claim micros>`; backoff 10, 20, 40, 60 minutes; `owed` only after a definite insufficient-funds error plus one more lookup; after 5 failed tries the next claim is lookup only, then `owed` if nothing landed.
- One SQL statement per multi-row change; `updated_at = now()` on every UPDATE; scalars or string_agg only (local proxy).
- Seller copy: real punctuation, no dashes as separators, never the fee percentage, amounts as $X.XX. Admin emails prefix `[Payouts]`.
- Owed booking recoveries are money owed TO Outsyde: never added to `computeHeld`.
- Tests on localhost only. Migration 065 hand-run in Neon by Claude before merge; never drizzle-kit push / npm run db:migrate on production.

## Review Focus
1. The same refund recorded twice (hook + backstop, or two servers): one recovery, one reversal. → Task 3 test `same refund twice records one row` and Task 4 `two runs at once reverse once`.
2. Reversal times out but landed: next try finds it by `metadata.refundId`, never reverses twice. → Task 4 `lost reversal response is recorded`.
3. Partial refund then full refund on one booking: total taken back never exceeds what was sent. → Task 3 `two refunds never exceed sent`.
4. Booking with an unpaid `_rewards` part: share capped at what was actually sent. → Task 3 `unsent part never charged`.
5. Seller with no transfer at all (expired accept, unpaid issue): `nothing_sent`, no Stripe reversal, no alert. → Task 3.

---

### Task 0: Regression re-check (read-only)
- [ ] main still `c84dd25` (else rebase and re-check `ls migrations | tail -2` and Neon: `booking_refund_recoveries` absent, `event_payout_recoveries` has no `seller_notified_at`).
- [ ] Grep all client repos for `booking_refund_recoveries`, `bookingRecoveries`, `refund_recovery` (expect none).

### Task 1: Migration 065 + refund hook + Stripe helpers
**Files:** Create `migrations/065_booking_refund_recoveries.sql`; Modify `server/stripe/stripeService.ts` (createBookingRefund ≈:929 hook + new helpers); Test `server/bookingRecoveries.stripe.http.test.ts`.

**Interfaces — Produces:**
- Table `booking_refund_recoveries`: `id varchar(36) pk default gen_random_uuid()`, `refund_id text NOT NULL UNIQUE`, `payment_intent_id text NOT NULL`, `refund_cents integer NOT NULL`, `refund_created_at timestamptz`, `reference_type text CHECK IN ('appointment','shoot_booking')`, `reference_id varchar(36)`, `recipient text` (business/staff/photographer), `connected_account_id text`, `amount_cents integer NOT NULL DEFAULT 0 CHECK >= 0`, `reversed_cents integer NOT NULL DEFAULT 0`, `status text NOT NULL DEFAULT 'pending' CHECK IN ('pending','reversed','owed','recovered','nothing_sent','not_booking')`, `reversal_ids text`, `attempts int NOT NULL DEFAULT 0`, `next_attempt_at timestamptz`, `last_error text`, `owed_at timestamptz`, `seller_notified_at timestamptz`, `alerted_at timestamptz`, `recovered_at timestamptz`, `created_at/updated_at timestamptz NOT NULL DEFAULT now()`; indexes: `(status, next_attempt_at)` partial on pending/owed, `(connected_account_id) WHERE status='owed'`, `(reference_type, reference_id)`. Plus `ALTER TABLE event_payout_recoveries ADD COLUMN IF NOT EXISTS seller_notified_at timestamptz`.
- `stripeService.createBookingRefund`: after Stripe returns, `void recordBookingRefund({ refundId, paymentIntentId, refundCents, createdUnix })` via dynamic `import("../bookingRecoveries")`; errors logged only; return value unchanged.
- New bounded helpers (opts `{ timeoutMs?, maxNetworkRetries? }`, defaults 30000/1):
  - `listBookingTransfers(transferGroup, opts): Promise<Array<{ id; amount; amountReversed; destination }>>` (`transfers.list({ transfer_group, limit: 100 })`).
  - `listPaymentIntentRefunds(paymentIntentId, opts): Promise<Array<{ id; amount; created; status }>>` (`refunds.list({ payment_intent, limit: 100 })`).
  - `findRecoveryReversals(transferId, refundId, opts): Promise<Array<{ id; amount }>>` (pages `listReversals`, metadata.refundId match, ≤ 10 pages).
  - `reverseForRecovery({ transferId, amountCents, refundId, bookingType, bookingId, idempotencyKey, ...opts }): Promise<{ id }>` with metadata `{ type: 'booking_refund_recovery', refundId, bookingType, bookingId }`.
  - `getPaymentIntentAmountReceived(paymentIntentId, opts): Promise<number>`.
- [ ] Tests first (stub): helper params, metadata, Idempotency-Key, paging; `createBookingRefund returns the same object and inserts one pending row`; `insert failure never breaks the refund` (DB unavailable seam → refund still returned).
- [ ] Apply 065 locally twice; implement; tests pass; tsc ≤ 59. Commit `Refund recovery: migration 065, refund hook, Stripe helpers`.

### Task 2: Resolve and compute the share (`server/bookingRecoveries.ts`, part 1)
**Interfaces — Produces:**
- `recordBookingRefund(p: { refundId: string; paymentIntentId: string; refundCents: number; createdUnix: number }): Promise<void>` (INSERT … ON CONFLICT (refund_id) DO NOTHING; skips `createdUnix < RECOVERY_START_UNIX`).
- `resolveBooking(paymentIntentId): Promise<{ type: 'appointment'|'shoot_booking'; id: string; base: number; intendedPayout: number; recipient: 'business'|'staff'|'photographer' } | null>` (one SELECT across both tables by `stripe_payment_intent_id`).
- `computeShare(input: { intendedPayout: number; base: number; amountReceived: number; refundCents: number; sentNet: number; alreadyTaken: number }): number` (pure; Global Constraints formula).
- `backfillRefunds(limit = 50): Promise<number>` (bookings with `refunded_at >= now() - 30 days` or status `refunded`/`canceled` changed in the last 30 days AND a PaymentIntent: list Stripe refunds, `recordBookingRefund` each).
**Test** `server/bookingRecoveries.test.ts` (in-process, local DB, fake Stripe like bankPayout.test.ts).
- [ ] Tests first: `computeShare` full refund = all sent; partial 50% of a $100 no-deposit booking with $98 sent = $49; deposit booking ratio on the deposit; points code (`amount_received < base`) full refund = all; `unsent part never charged` (intended 98, sent 80, 50% → 49 capped at 80 → 49; 100% → 80); `two refunds never exceed sent` (60% then 60% → second capped at 40%); staff booking → recipient staff; shoot → photographer; unknown PI → null (`not_booking`); refund before start skipped; `same refund twice records one row`.
- [ ] Implement; pass. Commit `Refund recovery: resolve booking and compute the share`.

### Task 3: The recovery job + seller alerts + every-minute step (`server/bookingRecoveries.ts`, part 2)
**Interfaces:**
- `type RecoveryStripe = Pick<StripeServiceT, 'listBookingTransfers'|'listPaymentIntentRefunds'|'findRecoveryReversals'|'reverseForRecovery'|'getPaymentIntentAmountReceived'|'isInsufficientFundsError'>`.
- `processBookingRecovery(id: string, s?: RecoveryStripe): Promise<'reversed'|'owed'|'nothing_sent'|'not_booking'|'retry'|'not_due'>`: claim (pending or owed-and-due) → resolve → list transfers (`appointment_<id>` / `shoot_booking_<id>`) → sentNet → share (fixed on first compute, saved in `amount_cents`) → re-take lock → per transfer (largest remaining first): lookup reversals for this refund, record found, else reverse the rest with a per-try key → all done `reversed` (or `recovered` when it was `owed`) → insufficient: `owed` + `owed_at`, partial reversals kept in `reversed_cents`.
- `retryOwed(s?)`: owed rows become due now when the DB shows a newer transfer to the same account: an appointment/shoot `settled_at` with a `stripe_transfer_id` paid to that account (account by recipient mapping), a `booking_payout_issues` row `status='paid'` with that `connected_account_id`, or an `event_payouts` row paid to it, each after `owed_at` or the last attempt; otherwise due once an hour.
- `notifyOwedSellers()`: booking recoveries `owed` with `seller_notified_at IS NULL` and event recoveries `owed` (created after RECOVERY_START) with `seller_notified_at IS NULL` → claim by setting `seller_notified_at` (UPDATE … RETURNING), then one email + one push per row. Recipients: business owner (`businesses.owner_id`, `contact_email`); staff member (`staff_members.email`, push if `user_id`) and the business owner; photographer (`photographers.user_id`); event host user. New exported email sender in `server/emailService.ts` using `sendBrandedEmail` with a `booking`/`shoot`/`staff`/`ticket` log tag (label without personal data). Copy: subject "Money owed for a refund"; body "A customer was refunded $X for your booking on {date}. Your Stripe balance didn't cover your share of $Y, so it will be taken from your next payout." (event: "for your event {title}").
- `alertOldOwed()`: owed > 30 days → one admin email (`alerted_at`).
- `runBookingRecoveryJob(s?)`: backfillRefunds → process due rows (≤ 20) → retryOwed → notifyOwedSellers → alertOldOwed; each in its own try/catch. Added as the last step of `startBookingCleanupJob` in server/bookingStateMachine.ts (after the bank payout step), own try/catch, dynamic import.
- [ ] Tests first (fake Stripe with transfers, reversals, `insufficientFor`, `landsButThrows`): full reverse; partial; two transfers (base + rewards) largest first; `two runs at once reverse once`; `lost reversal response is recorded`; insufficient → owed, `reversed_cents` kept; owed → retried after a newer settled booking to the same account → recovered; staff debt not retried by a business payout; 5 failures → lookup only → owed; seller notified once (email + push recorded via test hooks), staff case notifies staff and owner; event owed recovery notified once, old one (before start) never; admin email after 30 days once; copy has no dash separators and no "8%".
- [ ] Implement; pass; existing suites unchanged (bankPayout.test, payouts.test, eventPayouts.http 215/0, revenueRefunds.http, pointsRedeem.http); tsc ≤ 59. Mutation checks: drop the lookup, drop the cap, drop the start date → a test fails each. Commit `Refund recovery: job, seller alerts, every-minute step`.

### Task 4: Final
- [ ] Whole-branch review (fresh reviewer, spec + plan + diff); one fix wave + scoped re-review if needed.
- [ ] Full diff with + and − to Legend.
- [ ] Run 065 in Neon `muddy-violet-59386933`, verify read-only (columns, unique refund_id, checks, indexes, 0 rows; event column added).
- [ ] PR via `gh api -X POST repos/1outsyde/outsyde-backend/pulls` from `feat/booking-refund-recovery`; after merge: Render live check, board, vault (P1 #5, Stripe reference, Regression Protocol hotspot, Legal note pointer for step 3).
