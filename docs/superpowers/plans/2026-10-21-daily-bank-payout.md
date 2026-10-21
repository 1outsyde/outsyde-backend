# Daily Bank Payout (PR 5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Legend chose task by task with a reviewer, 2026-10-19). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a day after 6:00 AM New York, send at most one Stripe payout from Outsyde's platform balance to Outsyde's bank, paying only money that isn't held for anyone else.

**Architecture:** New module `server/bankPayout.ts` (held-money query, day claim, send with lookup + lock, status follow-up), a new table `bank_payouts` (migration 064, one row per New York date), four additive bounded helpers in `stripeService`, and one new step at the end of the every-minute job in `bookingStateMachine.ts`. Off unless `DAILY_BANK_PAYOUT_ENABLED === "true"` and the live Stripe payout schedule is `manual`.

**Tech Stack:** TypeScript, Express backend, drizzle `sql` + neon-http (`rows` helper from `server/events/eventsRouter.ts`), Stripe SDK ^20, local Postgres 16 for tests.

**Spec:** `docs/superpowers/specs/2026-10-21-daily-bank-payout-design.md` (section D = builder check answers). Vault: `Handoffs/Bank Payout (PR 5b) — Audit`, `Outsyde Backend/Stripe — Complete Reference` §8.

## Global Constraints
- Switch: `process.env.DAILY_BANK_PAYOUT_ENABLED === "true"`, read at call time. Off = nothing read from Stripe, nothing written.
- Run time: New York date's first run at or after 06:00 `America/New_York` (via `Intl.DateTimeFormat`, as in `server/accountSetup/reminders.ts`).
- Buffer `100_00` cents; minimum payout `25_00` cents (below: skip, reason `below_minimum`).
- Amount = available USD (Stripe `balance.available`, `currency === 'usd'` only) − held − buffer. Never below 0.
- Payout params: `amount`, `currency: 'usd'`, `method: 'standard'`, `statement_descriptor: 'OUTSYDE'`, `description: 'Outsyde daily payout <YYYY-MM-DD>'`, `metadata: { type: 'outsyde_bank_payout', payoutDate, rowId }`.
- Every Stripe call bounded `{ timeoutMs: 30000, maxNetworkRetries: 1 }`; one idempotency key per try `bank_payout_<payoutDate>_<claim time in microseconds>`; lookup before every create; 10-minute lock re-taken before sending; every status write guarded by the claim's ownership tag (copy `OWNER_TAG` pattern from `server/events/eventPayouts.ts`).
- One SQL statement per multi-row change (neon-http has no transactions). Array results via `string_agg`, not arrays (local proxy).
- Admin emails only on `review`, `failed`, and a `sent` row older than 10 days; subject prefix `[Payouts]`; one email per outcome.
- No change to booking, product, ticket, event payout code or any route/response. No client change.
- Tests on localhost only. Never `npm run db:migrate` / `drizzle-kit push` on production; migration 064 hand-run in Neon by Claude before Legend merges.
- Copy (emails to admin): real punctuation, no dashes as separators, never the 8%.

## Review Focus
1. Two servers (deploy overlap) both past 6:00 on the same day: exactly one Stripe payout. → Task 4 test `two runs at once send one payout`.
2. Stripe create times out but the payout was made: next try records it, never sends a second. → Task 4 test `lost response is recorded, not resent`.
3. A payout Legend sent by hand earlier that New York day: skip with `other_payout_today`. → Task 4 test.
4. Balance drops between the read and the create (insufficient funds): skip the day, no email, no retry loop. → Task 4 test.
5. Clock edge: 05:59 New York does nothing; 06:00 runs; the UTC date differs from the New York date after 20:00 New York (EDT) / 19:00 (EST). → Task 4 test `nyDayAndHour`.

---

### Task 0: Regression check (read-only, already run 2026-10-21 for the plan; re-confirm at build start)
- [ ] `git log --oneline -1` on main and branch; confirm main is still `83ada3a` or rebase and re-check migrations folder (`ls migrations | tail -3`) and Neon (`bank_payouts` absent).
- [ ] Re-grep consumers listed in the PR description section "Regression" (below in Task 5); any new hit stops the build.

### Task 1: Migration 064 `bank_payouts`

**Files:** Create `migrations/064_bank_payouts.sql`.

**Interfaces — Produces:** table `bank_payouts`:
`id varchar(36) pk default gen_random_uuid()`, `payout_date date NOT NULL UNIQUE`, `status text NOT NULL CHECK (status IN ('pending','sent','paid','failed','review','skipped'))`, `skip_reason text`, `available_cents integer`, `held_cents integer`, `held_breakdown jsonb`, `buffer_cents integer NOT NULL DEFAULT 10000`, `amount_cents integer`, `stripe_payout_id text`, `stripe_status text`, `attempts integer NOT NULL DEFAULT 0`, `next_attempt_at timestamptz`, `last_error text`, `alerted_at timestamptz`, `sent_at timestamptz`, `paid_at timestamptz`, `failed_at timestamptz`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`; index `(status) WHERE status IN ('pending','sent')`.

- [ ] Write the file in the 063 header style (run manually in Neon before deploy, idempotent `IF NOT EXISTS`, additive only).
- [ ] Apply to local Postgres twice (`psql -f` ×2); second run must print no errors. `\d bank_payouts` matches the list above.
- [ ] Commit `Bank payout: migration 064 bank_payouts`.

### Task 2: Stripe helpers (additive, `server/stripe/stripeService.ts`)

**Interfaces — Produces** (all take `opts: { timeoutMs?: number; maxNetworkRetries?: number }` and pass it through `eventPayoutRequestOptions`):
- `getPlatformPayoutInterval(opts): Promise<string | null>` → `GET /v1/account` (the platform account, no id) `settings.payouts.schedule.interval`.
- `getAvailableUsdBalance(opts): Promise<{ usdCents: number; otherCurrencies: string[] }>` → `balance.retrieve`, sums `available` where `currency==='usd'`, lists other currencies with amount ≠ 0.
- `listPlatformPayoutsCreatedSince(sinceUnix: number, opts): Promise<Array<{ id: string; amount: number; status: string; created: number; metadata: Record<string,string> }>>` → `payouts.list({ created: { gte }, limit: 100 })`, follows `has_more` up to 5 pages.
- `createPlatformPayout(p: { amountCents: number; payoutDate: string; rowId: string; idempotencyKey: string } & opts): Promise<{ id: string; status: string }>` with the params in Global Constraints.
- `retrievePlatformPayout(id: string, opts): Promise<{ id: string; status: string; failureCode: string | null }>`.
- Existing `getAvailableBalanceCents` unchanged.

**Test:** `server/bankPayout.stripe.http.test.ts` (stub on `EV_TEST_STRIPE_PORT`, copy the stub server + `stripe-stub-preload` pattern from `eventPayouts.http.test.ts`; in-process calls only, no backend server needed).
- [ ] Tests (fail first): `create sends the exact params` (form body has `amount`, `currency=usd`, `method=standard`, `statement_descriptor=OUTSYDE`, `metadata[type]=outsyde_bank_payout`, `metadata[payoutDate]`, `metadata[rowId]`; `Idempotency-Key` header equals the key passed); `interval read from /v1/account`; `usd only, other currencies listed` (stub balance `[{usd 5000},{cad 300}]` → `{5000, ['cad']}`); `list pages until has_more false` (2 pages); `retrieve maps failure_code`.
- [ ] Implement; tests pass; `npx tsc --noEmit` count ≤ 59.
- [ ] Commit `Bank payout: bounded Stripe payout helpers`.

### Task 3: Held money (`server/bankPayout.ts`, part 1)

**Interfaces — Produces:**
- `type HeldBreakdown = { openBookingPayouts; settledNoTransfer; unsettledConfirmed; ordersTransferFailed; pendingRefundRequests; ticketHostNetUnpaid; eventPayoutsOpen; ticketRefundsSending; ticketExposureUnstarted; ticketExposureStarted30d; influencerOwed; bookingRefundCover: number }` (cents).
- `type Gates = { recentTopups: number; openIssueRows: number; eventPayoutsWaitingBalance: number }`.
- `computeHeld(): Promise<{ breakdown: HeldBreakdown; total: number; gates: Gates }>` — ONE read-only statement: the query verified read-only in Neon on 2026-10-21 (all parts, saved in the PR description), each part `::bigint`, booking cover = paid in last 30 days by `created_at` OR (`status='confirmed'` and service date ≥ today New York) on both `appointments` and `shoot_bookings`; started ticket exposure only while `ends_at > now() - interval '30 days'`. Owed event recoveries never appear.

**Test:** `server/bankPayout.test.ts` (in-process, `DATABASE_URL` local + neon preload; seeds rows with raw `pg`, cleans its own rows by id prefix `bp-test-`).
- [ ] Tests (fail first), one per part, each seeds exactly one obligation and asserts that part equals the seeded cents and `total` equals the sum: open issue 1000; settled appointment no transfer 2000 (and one with an `is_base` issue row is NOT counted); shoot `checkout_session` NOT counted; unsettled confirmed hold booking 1500; order `transfer_failed` 700; refund request pending 400; valid ticket on completed order with no payout_id; event_payouts `held` 900; ticket order `refunding` 300; unstarted event exposure = total − refunded; started event ending 10 days ago counted, 40 days ago NOT; influencer ledger `ready_for_payout` 250 (negative rows ignored); booking cover: created 5 days ago counted, created 45 days ago with future date counted, created 45 days ago past date NOT; event recovery `owed` changes nothing; gates count a top-up 2 days ago and not 8 days ago.
- [ ] Implement; pass. Commit `Bank payout: held money query`.

### Task 4: The job (`server/bankPayout.ts`, part 2) + every-minute step

**Interfaces:**
- `type BankStripe = Pick<StripeServiceT, 'getPlatformPayoutInterval'|'getAvailableUsdBalance'|'listPlatformPayoutsCreatedSince'|'createPlatformPayout'|'retrievePlatformPayout'|'isInsufficientFundsError'>`.
- `nyDayAndHour(now: Date): { date: string; hour: number; dayStartUnix: number }` (date `YYYY-MM-DD` in New York; `dayStartUnix` = New York midnight as Unix seconds).
- `runBankPayoutJob(now = new Date(), s?: BankStripe): Promise<{ action: 'off'|'not_yet'|'done_today'|'skipped'|'sent'|'retry'|'review'; reason?: string }>`.
- `checkSentPayouts(s?: BankStripe): Promise<number>`.
- `setBankAlertForTest(fn | null)`; `alertPayouts(subject, detail)` (copy of `alertAdmin` with `[Payouts]` prefix, never throws).
- Constants: `BANK_BUFFER_CENTS = 10000`, `BANK_MIN_CENTS = 2500`, `BANK_MAX_ATTEMPTS = 5`, `BANK_LOCK_MINUTES = 10`, `SENT_ALERT_DAYS = 10`.

**Flow** (each numbered item is a test):
1. Switch off → `off`, no Stripe call, no row.
2. `checkSentPayouts` runs first every time the switch is on (bounded retrieve per `sent` row, ≤ 20 rows): `paid` → `paid`+`paid_at`; `failed`/`canceled` → `failed` + one email; still in transit after 10 days → one email (`alerted_at`).
3. Before 06:00 New York → `not_yet`. Row for today with status `paid|sent|skipped|failed|review` → `done_today`.
4. Interval ≠ `manual` → `skipped`/`stripe_not_manual`, **no row written** (so the day still runs once Legend flips it), no email.
5. Claim: `INSERT ... ON CONFLICT (payout_date) DO NOTHING RETURNING` a `pending` row with `attempts=1`, `next_attempt_at=now()+10 min`; or re-claim an existing `pending` row whose `next_attempt_at <= now()` (attempts + 1). No row returned → `done_today`.
6. Gates (recent top-up, open issues, event payout waiting balance) → row `skipped` with reason; other currency in balance → still pays USD, one email.
7. Today's Stripe payouts (`listPlatformPayoutsCreatedSince(dayStartUnix)`): one with `metadata.type='outsyde_bank_payout'` and `metadata.payoutDate=today` → record it (`sent`, its id), never create; any other payout → `skipped`/`other_payout_today`.
8. Amount < 2500 → `skipped`/`below_minimum` with available, held, breakdown saved.
9. Re-take lock (ownership tag), create with per-try key → `sent`, `sent_at`, id, amount, breakdown saved.
10. Insufficient funds error → `skipped`/`insufficient_funds`, no email. Other error → backoff `LEAST(60, 10·2^(attempts−1))` minutes; after 5 tries `review` + one email; a try never concludes "not sent" from its own failed call (the next try's lookup in step 7 decides).

**Test:** extend `server/bankPayout.test.ts` with a fake `BankStripe` (records calls; scripted results incl. `throwOnce`, `landsButThrows` = records the payout then throws timeout).
- [ ] Tests (fail first): items 1–10 above; `two runs at once send one payout` (`Promise.all` of two runs with a delayed fake create → 1 create); `lost response is recorded, not resent` (landsButThrows, then a run 11 minutes later → 0 new creates, row `sent` with that id); `nyDayAndHour` at `2026-10-21T09:59:00Z` → hour 5, `2026-10-21T10:00:00Z` → 6, `2026-10-22T01:30:00Z` → date `2026-10-21`, and an EST date `2026-12-01T11:00:00Z` → hour 6; mutation check: change `>= 6` to `>= 5`, buffer to 0, or drop the lookup → at least one test fails (revert after).
- [ ] Implement in `server/bankPayout.ts`.
- [ ] Add the last step in `startBookingCleanupJob` (`server/bookingStateMachine.ts`, after the event payout step), own try/catch, dynamic `import("./bankPayout")`, comment in the same style.
- [ ] All new tests pass; baseline suites unchanged (eventPayouts.http 215/0, events 61/0, tickets 55/0, ticketCheckout 41/0, ticketRefunds 79/0, eventRules 46/0, ticketFees 12/0); tsc ≤ 59.
- [ ] Commit `Bank payout: daily job and every-minute step`.

### Task 5: Final checks, Neon migration, PR
- [ ] Independent whole-branch review (fresh reviewer, spec + plan + diff).
- [ ] Show Legend the full diff with + and −.
- [ ] Run migration 064 in Neon `muddy-violet-59386933` (main branch), then read-only verify: columns, unique index, 0 rows.
- [ ] Re-run the held query read-only in Neon and put the numbers in the PR.
- [ ] Push the work to a new branch `feat/events-phase2-bank-payout-build` (the original branch name needs a force push after the rebase) and open the PR with `gh api -X POST repos/1outsyde/outsyde-backend/pulls`. PR body: what, env (`DAILY_BANK_PAYOUT_ENABLED` not set = off), regression table, held numbers, launch order (switch on → Legend flips Stripe to manual → first payout next 6 AM).
- [ ] After Legend merges: Render live check, board `p2-bank`, vault update.
