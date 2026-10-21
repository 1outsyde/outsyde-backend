# Booking refund recovery (P1 #5): design

Status: for Legend's approval (2026-10-21). Builder check done (section G).
Audit basis: backend main `c84dd25`, read-only audit 2026-10-21 (refund paths A1 to A8, payout records, event recovery code), Neon read-only, docs.stripe.com (account balances, account debits, pending transfer reversals).

## Why
A booking's seller (business, staff member or photographer) is paid by a Stripe transfer the moment the booking is confirmed. When the customer is refunded later, Outsyde pays the whole refund from its own balance and the seller keeps their transfer. Legend decided (2026-10-21) that the seller's share of every refund comes back from the seller, the way it already does for event hosts.

## Goals (Legend's steps 1, 2, 4, 5; step 3 later)
1. The customer is refunded first, from Outsyde's balance, exactly as today. Nothing waits on the seller.
2. After any booking refund, take the seller's share of that refund back by reversing their transfer.
4. If their Stripe balance is too low, alert the seller (email and push) of the amount owed.
5. Take what is still owed from the seller's next payout, oldest debt first.
- Applies to **every** refund of a booking whose seller was already paid, whoever started it: customer cancel, vendor bulk cancel, provider refund button (appointments and shoots), admin approved refund requests (Legend 2026-10-21, "All of them").
- Events get step 4 too: today an event host who owes money is never told.

## Non-goals
- Step 3 (debit the seller below zero with Stripe account debits): needs the agreement clause and each seller's consent first. See vault note `Operations/Legal Walkthrough — Agreements To Update`. Separate small PR after the legal walkthrough.
- Fixing the refund routes' own bugs (no idempotency key on A3/A6/A8, inconsistent `refund_amount`, bulk cancel refunding the fee on deposit bookings, R33 refund requests). Recovery is built so it stays correct whatever those routes do; the route fixes are their own PRs.
- Refunds made in the Stripe dashboard (no `charge.refunded` handler; board p5-stripe-sync).
- Legacy destination-charge bookings (`appointment_booking` PI with `transfer_data`, shoot Checkout): Neon 2026-10-21 has 0 of them; recovery finds no transfer for them and records nothing.
- Product orders (product cancel already reverses).
- Any change to how refunds are computed, how sellers are first paid, or any route response.

## Anti-goals
- Taking back more than the seller was actually sent for that booking.
- Taking back twice for one refund.
- A seller charged for a payout they never received (an unpaid `booking_payout_issues` part).
- Delaying or blocking the customer's refund.

## Decided (Legend)
- Steps 1, 2, 4, 5 now; step 3 after the legal walkthrough (2026-10-21).
- All booking refund paths recover (2026-10-21).
- Staff bookings: the staff member pays back, even when the business started the refund (2026-10-21).
- Agreements (Vendor Agreement update, new Event Host Agreement with scroll and checkbox) are drafted later; listed in the vault (2026-10-21).

## Design ("call" = Claude's call)
### A. When a refund happens
- `stripeService.createBookingRefund` is the single place every booking refund goes through (A1 to A8). After Stripe returns the refund, it records a recovery row for it (best effort, never throws, never changes the refund or the route's response). Call.
- Backstop job: bookings refunded in the last 30 days (`refunded_at` set, or status `refunded`) are checked against Stripe's refund list for their PaymentIntent; any refund without a recovery row gets one. Covers a lost insert and the shoot admin path that writes no refund columns. Call.
- One row per Stripe refund id (`refund_id` unique), so a repeated or concurrent refund never recovers twice.

### B. How much comes back
- Sent = sum of the booking's transfers in Stripe (`transfer_group` `appointment_<id>` or `shoot_booking_<id>`), each `amount − amount_reversed`. Never `vendor_net` or `staff_payout`.
- Share = intended payout × min(1, refund ÷ min(base, amount received)), base = deposit or total price, intended payout = base minus 2% (as settlement computes it), rounded to the cent, capped at Sent minus earlier recoveries for that booking. A full refund takes back everything left. Call (the audit's option 2 with the builder check's cap; matches "the 8% fee is never refunded" and the cap at what Stripe holds).
- Nothing sent yet (expired accepts A1/A2, unpaid issue rows, legacy charges): the row closes as `nothing_sent`, amount 0, no Stripe call. The hourly payout retry already drops unpaid parts once a refund exists.
- Several transfers on one booking (base, `_src`, `_rewards`): reversed in order, largest remaining first, until the share is covered. Call.

### C. Taking it back (same machine as event recoveries)
- New table `booking_refund_recoveries` (migration 065, call): `refund_id` unique, `reference_type` (`appointment` / `shoot_booking`), `reference_id`, `connected_account_id`, `refund_cents`, `amount_cents` (the share, fixed when computed), `reversed_cents`, `status` (`pending`, `reversed`, `owed`, `recovered`, `nothing_sent`), `attempts`, `next_attempt_at`, `last_error`, `reversal_ids`, `owed_at`, `seller_notified_at`, `alerted_at`, `recovered_at`, timestamps. There is no `recovered_from` column: `recovered_at` plus `reversal_ids` are the record of how a debt was taken back.
- Every minute (last step of the booking cleanup job): claim with a 10 minute lock and ownership tag, re-take before Stripe calls, look up reversals already made for this refund (transfer reversals with `metadata.refundId`) before every reverse, one idempotency key per try, every Stripe call 30 s / 1 retry, backoff 10, 20, 40, 60 minutes. Copied from `eventPayouts.ts` processRecovery.
- Reversal metadata `{ type: 'booking_refund_recovery', refundId, bookingType, bookingId }`.
- Insufficient balance (definite Stripe error, then one more lookup): status `owed`, `owed_at` set. Any reversed part stays recorded; only the rest is owed. Other errors after 5 tries: lookup only, then owed if nothing landed (same rule as events).

### D. Telling the seller (step 4)
- When a booking or event recovery becomes `owed`: one email and one push to the seller. Business: owner's email and push; staff: the staff member's email (push if linked to a user); photographer: the photographer's user. Event host: the host user.
- Copy (real punctuation, no dashes, no fee percentage): "A customer was refunded $X for your booking on {date}. Your balance didn't cover your share, so $Y will be taken from your next payout." Exact wording reviewed in the PR.
- Admin email once if still owed after 30 days (as events today).

### E. Next payout (step 5)
- Booking debts: whenever a newer transfer to the same Connect account is seen (a booking settlement, a booking payout retry, or an event payout), the owed row is tried again right away; otherwise owed rows retry every hour. No amount cap is needed: Stripe refuses a reversal above the seller's balance, and the row stays owed. A success marks it `recovered` with `recovered_at` set and the reversal ids in `reversal_ids`. This leaves booking payout amounts and their fixed idempotency keys untouched. The seller sees the new payout and then the recovery on their Stripe statement. Call.
- Event debts keep today's rule (taken from the host's next event payout) and gain the alert in D.
- Staff debts can only come back from that staff member's later booking payouts (staff can't host events).

### F. Bank payout
- Owed booking recoveries are money owed TO Outsyde: never counted as cash in `computeHeld` (same as event recoveries). Nothing else in the bank payout changes.

### G. Builder check answers (2026-10-21)
- **Stripe when the seller's balance is too low:** our sellers are Express accounts with Outsyde responsible for negative balances, and we are not in Stripe's private preview for pending reversals, so Stripe's docs say the reversal is refused with an error ("Reversals that don't meet these criteria return an error if the connected account has insufficient balance", docs.stripe.com/connect/pending-transfer-reversals). A plain reversal never takes the seller below zero (that needs an account debit, step 3). So section C's `owed` path is right. The exact error code is checked in Stripe test mode during the build; until then the code treats any error it doesn't recognise as insufficient by retrying, then lookup only after 5 tries, then `owed` (same safety net as events). Call.
- **Start date:** only refunds created at or after the deploy recorded in the migration (a `recovery_start_at` setting, default the migration time) are recovered; event recoveries already `owed` before deploy get no seller alert. Neon 2026-10-21 has 0 booking refunds, 0 booking transfers and 0 event recoveries, so nothing old exists either way. Call.
- **Staff bookings (Legend 2026-10-21):** the staff member pays back, even when the business owner started the refund (refund button or bulk cancel). Their payout, their debt: taken back from their Stripe balance, and if short, from their next booking payout. The staff member and the business owner both get the alert.
- **Backfill and the unverified error code (final review, 2026-10-21):** the backstop backfill runs every 15 minutes (minutes 0, 15, 30, 45 UTC) over the whole 30 day window, oldest first, and skips bookings that were only canceled. Stripe's exact insufficient-balance error code for transfer reversals is unverified (no test-mode key in the build session); the fallback is retry, then lookup only after 5 tries, then `owed` with the seller alert.
- **Part of the payout never sent (`_rewards` part dropped by the retry):** share = intended payout (deposit or total minus 2%) × refund ratio, capped at what was actually sent and not yet reversed. The seller never gives back more than their fair share of what they should have received. Call.

## Constraints
Same as PR 5a and 5b: one SQL statement per multi-row change, claim before every money step, per-try keys plus lookup before every reversal, bounded calls, tests on localhost with the Stripe stub, migration hand-run in Neon by Claude before merge, backend only, every response unchanged.

## Left to the builder
File layout (`server/bookingRecoveries.ts`), exact SQL, stub endpoints (transfers list by group, reversals with metadata, insufficient error), email and push helper names, test structure.
