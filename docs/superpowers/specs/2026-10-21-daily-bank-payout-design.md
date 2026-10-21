# Daily Outsyde-to-bank payout (Events & Ticketing Phase 2, PR 5b): design

Status: approved by Legend in chat 2026-10-21 ("sounds right").
Audit basis: backend main `ffa6054`; vault note `Handoffs/2026-10-19 Events & Ticketing — Next Chat (Payouts) Start Here` (sections "PR 5b audit + decisions").

## Why
Ticket money (and some booking and order money) sits on Outsyde's Stripe platform balance until it is paid to a host or vendor or refunded. Today Stripe pays everything above $100 to Outsyde's bank every Monday and Friday, so money that isn't Outsyde's can leave Stripe early and host payouts or refunds would then fail or pull from the bank. Before paid tickets go on, Stripe switches to manual payouts and this job pays the bank only Outsyde's own money.

## Goals
1. Once a day at 6:00 AM New York, at most one Stripe payout from the platform balance to Outsyde's bank.
2. Amount = available USD balance − money held for others − refund cover − $100 buffer. Skip when that is under $25.
3. Never pay the same day twice; a lost Stripe response never causes a second payout.
4. Off by default; never runs while Stripe is still on automatic payouts.

## Non-goals
- Booking refunds pulling money back from the vendor (P1 #5): separate booking PR right after 5b (Legend 2026-10-21).
- Disputes / Stripe dashboard refund sync (later).
- The influencer commission bug and money with no DB record (XO deposits, single-shop orders without Connect, failed multi-shop transfers): logged in the vault; a one-time Stripe check before the first real payout.
- Any change to booking, product, ticket or event payout code; any app/web change.

## Anti-goals
- Paying out money owed to a host, vendor, influencer or buyer.
- Two bank payouts on one day.
- Fighting the booking top-up (pulling money in and paying it straight back out).

## Decided (Legend)
- Buffer $100 (2026-10-19). Run 6:00 AM New York. Minimum bank payout $25; below it, skip that day. (2026-10-21)
- Until the booking refund fix ships, hold back 30 days of confirmed booking payments as refund cover. (2026-10-21)
- Legend flips Stripe to manual payouts himself after this is live. Paid tickets turn on after that.

## Design ("call" = Claude's call)
### A. Switches and safety gates
- `DAILY_BANK_PAYOUT_ENABLED === "true"` (default off), read at call time.
- Live check each run: the platform account's payout schedule is `manual` (`GET /v1/account` → `settings.payouts.schedule.interval`). Otherwise skip with reason `stripe_not_manual` (call: no email, it's the expected state until Legend flips it).
- Skip with a reason (call) when: a booking top-up was requested in the last 7 days; any open `booking_payout_issues` row; any event payout waiting because of low platform balance. Those need the money in Stripe.

### B. Held amount (all computed from the DB in one read, each part saved on the day's row for audit)
1. Open booking seller payouts (`booking_payout_issues` open).
2. Settled bookings with no transfer and no issue row; confirmed bookings not yet settled.
3. Product orders `transfer_failed` (vendor share); pending `refund_requests`.
4. Event tickets: host net of valid tickets on completed orders not yet in a payout; `event_payouts` pending/held/review; ticket orders `refunding`; refund exposure (unstarted events: everything not yet refunded, fees included; started published events: ticket price not yet refunded).
5. Influencer earnings owed (pending / ready for payout).
6. Booking refund cover: what customers paid on confirmed/completed/no-show bookings paid in the last 30 days, minus refunds (call: overstating is the safe direction).
- Owed event recoveries are money owed TO Outsyde and are never counted as cash.

### C. The job
- New table `bank_payouts` (migration 063, call): one row per New York date (`payout_date` unique), `status` (`skipped`, `pending`, `paid`, `failed`, `review`), `skip_reason`, `available_cents`, `held_cents`, `held_breakdown` (jsonb), `buffer_cents`, `amount_cents`, `stripe_payout_id`, `attempts`, `next_attempt_at`, `last_error`, `alerted_at`, timestamps.
- Runs inside the existing every-minute job (call), but does nothing until New York time is past 6:00 and today's row doesn't exist. Creating today's row is the claim (unique date): two servers can't both run the day.
- Stripe calls bounded (30 s, 1 retry). Payout: `amount`, `currency: usd`, `method: standard`, `statement_descriptor: "OUTSYDE"`, metadata `{ type: "outsyde_bank_payout", payoutDate, rowId }`, idempotency key per try. Before every create, list today's payouts (created window) and record a matching one instead of sending. 10-minute lock per try, re-taken right before sending (same rules as 5a).
- Errors: retry with backoff; after 5 tries `review` + one admin email. Insufficient balance (balance moved since the read) → skip the day, no email.
- Next day's run checks yesterday's payout status in Stripe; `failed`/`canceled` → status `failed` + one admin email (the money returns to the balance and is picked up by the next run).
- Admin email only on review or failed (Resend quota).

## Constraints
Same as PR 5a: one SQL statement per multi-row change with runtime guards; claim before every money step; per-try idempotency keys + lookup before create; tests on localhost with the Stripe stub; migration idempotent and run in Neon by Claude before merge.

## Left to the builder
File layout (`server/bankPayout.ts` or `server/payouts/bankPayout.ts`), exact SQL for each held part (from the audit file), column types, stub endpoints, test structure.
