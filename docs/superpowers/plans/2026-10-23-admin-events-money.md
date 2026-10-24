# Admin events money Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Admin page goutsyde.com/admin/events (list by date or by host, needs attention, event detail) with four confirmed actions, backed by new `/api/admin/events` routes.

**Architecture:** Backend: one admin router, one grouped SQL for the list, one migration (071) widening recovery statuses, actions as single SQL statements that also write `audit_logs`. Web: admin pages in the existing inline-style admin pattern, pure bucketing logic with unit tests, BFFs through `proxyToBackend`.

**Spec:** `docs/superpowers/specs/2026-10-23-admin-events-money-design.md` (backend repo; copy goes in the web PR).

## Global Constraints
- Backend branch `feat/admin-events-money` from main `8a42250`; web branch `feat/admin-events-money` from main `3476408`. Never push to main; Legend merges.
- neon-http: no transactions; every multi-row change is ONE SQL statement (CTEs), guarded by the current status in its WHERE.
- Every admin route uses `requirePlatformAdmin` (backend middleware/requirePlatformAdmin.ts). Admin test user: `info@goutsyde.com`, `is_admin=true`, JWT `{userId, isVendor:false, isAdmin:true}` signed with "test".
- Money comes from stored columns (tickets.host_net_cents, stored fee columns); never recompute fees from percentages. No fee percentages in any copy.
- Never return host or buyer emails, full Stripe account ids (mask to last 4), or first/last names. Host name = public name (hostIdentityFrom, eventList.ts:77) plus owner @username.
- Copy: real punctuation, no dash breaks.
- Migration 071 is idempotent and run in Neon (project muddy-violet-59386933) by the controller before merge, then verified read-only. Never db:migrate / drizzle push on production.
- Local tests only: Postgres outsyde_test, backend :5071 with `.dev/neon-local-proxy-array.mjs` and the Stripe stub preload, web :3101 (`/home/claude/stack/restart.sh`; it starts the backend from /home/claude/1outsyde/outsyde-backend, so run the new backend checkout yourself on a spare port such as :5072 with the same env, or point the script at it).
- Look for the web: black #000, cream #F5F0E6, gold #E8B930, green #1A3C34 / #9FC2B5 for paid and ready, red #ff6b6b for problems, Bebas Neue titles, Hanken Grotesk text, admin `.kpi-*` tiles.

## Review Focus
1. Retry on a payout that is not in review, or whose event was cancelled: refused, nothing changes, no audit row.
2. Two admins (or a double click) resolving the same recovery: exactly one changes it, the other gets 409.
3. Email the host clicked twice, or when today's email budget is used up: no second email, clear message.
4. List sums with refunds, a free event, a cancelled event and an event with no payout row: totals equal the sum of the rows, and host earns excludes refunded tickets.
5. Non admin or signed out: 401/403 on every route, and the web shows the not authorized screen.

---

### Task B1: Migration 071 and the shared payout status helper
**Files:** Create `migrations/071_event_recovery_resolution.sql`. Modify `server/events/ticketRefunds.ts` (export `payoutStatusFor` or move it to `server/events/payoutStatus.ts` and import it back, behaviour unchanged).
- [ ] Write the migration (DROP the old status CHECK by name if present, ADD the widened CHECK `pending, reversed, owed, recovered, collected, written_off`; ADD COLUMN IF NOT EXISTS `resolved_at TIMESTAMPTZ`, `resolved_by VARCHAR(36) REFERENCES users(id)`). Run it twice on the local db: second run is a no-op.
- [ ] Extract the helper; run `eventSummary.http.test.ts` and `ticketRefunds.http.test.ts`: same results as main.
- [ ] Commit `feat(events): recovery resolution statuses (migration 071) and shared payout status helper`.

### Task B2: Admin list and detail routes
**Files:** Create `server/events/adminEventsRouter.ts`, `server/events/adminEventsQueries.ts` (SQL), `server/events/adminEvents.http.test.ts`. Modify `server/index.ts` (mount at `/api/admin/events` with the other admin routers).
**Produces:** `GET /api/admin/events?from&to` → `{ success, totals, attention, events }`; `GET /api/admin/events/:id` → `{ success, event, ticketTypes, orders, checkIns, payout, recoveries, host, activity }` (shapes in the spec).
- [ ] Failing http tests: 401 signed out, 403 signed-in non admin, 200 admin. Seed 1 business host event (3 ticket types, 1 refunded ticket, payout in review), 1 user host event (payout held, host without payout account), 1 free event, 1 cancelled event, 1 upcoming event without a payout row, 1 owed recovery older than 30 days. Assert per-event salesCents, refundedCents, hostEarnsCents, outsydeFeesCents against the seeded stored columns, totals = sum of events, attention has exactly the 3 items, detail masks the account id, response has no `email` key anywhere (JSON walk).
- [ ] Implement; tests green; `npx tsc` count unchanged vs main.
- [ ] Commit `feat(events): admin events money list and detail`.

### Task B3: Admin actions
**Files:** Modify `server/events/adminEventsRouter.ts`, tests.
- [ ] Failing tests: retry only from review on a published event (409 otherwise, no audit row); resolve collected/written_off only from owed, concurrent double resolve → one 200 and one 409; email-host only held/review, second within 24h → 429, budget ≥ 70 today → 503, success writes email_log + audit_logs and sends to the host's account email through the Resend stub/mocked sender; job behaviour after retry: the payout job picks the row up again (call the job once locally with the Stripe stub).
- [ ] Implement as single SQL statements with CTE audit inserts; tests green.
- [ ] Re-run eventPayouts.http, ticketRefunds.http, eventSummary.http, bankPayout tests: unchanged.
- [ ] Commit `feat(events): admin retry payout, resolve owed recovery, email host`.

### Task W1: Money logic (web)
**Files:** Create `app/admin/events/_lib/money.ts`, `tests/admin-events-logic.test.ts`.
- [ ] Tests: bucket(event, now) for each bucket incl. "due within 7 days" boundary and waiting on refunds; sortWithinBucket; groupByHost (business, photographer, people) with group totals; filter counts (All, Upcoming, Ended not paid yet, Paid, Needs attention); search by title or host; usd(); payoutPill(payout) text and tone.
- [ ] Implement; tests green. Commit.

### Task W2: BFFs and nav
**Files:** `app/api/admin/events/route.ts`, `[id]/route.ts`, `payouts/[payoutId]/retry/route.ts`, `payouts/[payoutId]/email-host/route.ts`, `recoveries/[recoveryId]/resolve/route.ts`; modify `app/admin/AdminNav.tsx` (one line). Test `tests/admin-events-bff.http.test.ts` (local, admin minted).
- [ ] Ids validated (uuid) before forwarding; resolve body only `collected|written_off`; statuses relayed. Commit.

### Task W3: Pages
**Files:** `app/admin/events/page.tsx` + `EventsMoneyClient.tsx`, `app/admin/events/[id]/page.tsx` + `EventMoneyClient.tsx`. Browser check `tests/admin-events.browser.py`.
- [ ] Per mockup: tiles, Needs attention strip with actions, filters with counts, By date (default) / By host switch, search, date range (Last 30 / 90 days / This year / All), table that scrolls sideways on phones, row links to detail; detail page sections; two-step confirm on every action; 401/403 screens.
- [ ] Browser check: loads as admin, By date default with buckets in order, switch to By host, filter counts, detail page, Try again confirm flow ends with the row out of Needs attention, 390px no horizontal page scroll. Commit.

### Task V: Verify and hand off
- [ ] All backend event suites + new suite, tsc; web unit, http, browser suites, tsc, eslint no new problems, `npm run build`; whole-branch review per repo; run migration 071 in Neon and verify; push branches; PR texts; vault + board.
