# Admin events money: design

Date: 2026-10-23 · Board row p3-admin-money · Approved by Legend 2026-10-23 18:36 ("OK BUILD IT") from the mockup canvas screens 18 to 20 (Events in Discover Mockups, `project/AdminEvents.dc.html`, `AdminEventDetail.dc.html`, `AdminEventsPhone.dc.html`).
Audit: research notes `admin-events-money/backend_audit.md` and `web_and_regression.md` (2026-10-23), backend main `8a42250`, web main `3476408`. Neon read-only 2026-10-23: `audit_logs` exists; events 0, event_payouts 0, event_payout_recoveries 0; recovery CHECK `pending, reversed, owed, recovered`.

## Intent
Legend needs one admin page that tells him, per event and per host, how much was sold, what Outsyde earned, what each host is owed, what was paid, and which payouts need him, sorted so the urgent ones are first. Today none of this is visible; stuck payouts and owed money are only SQL runbooks.

## Goals
- `goutsyde.com/admin/events`: totals, a Needs attention strip, every event either sorted by date into buckets (default) or grouped by host, filters, search, date range.
- `goutsyde.com/admin/events/[id]`: ticket types, orders, check-ins, refunds after payout, payout card, host card, activity.
- Four admin actions, each behind a confirm step: Try again (payout in review), Mark collected and Write off (owed recovery), Email the host (payout held or in review).
- Works on a phone (admin phone menu already exists).

## Non-goals
- Pausing or removing events (separate safety item), disputes, Stripe dashboard sync, changing any fee or payout rule, CSV export (button left out of v1; Claude's call, cheap to add later).

## Anti-goals
- Any change in how the payout job, refunds, recoveries or the bank payout behave for rows the admin does not touch.
- Sending a payout twice, or retrying one that can't succeed (cancelled event).
- Showing host or buyer emails, card details, or real names beyond what the public sees plus owner @username.
- Spending the shared Resend budget (100 a day) on repeated host emails.

## Decided
- Legend: mockup approved; build the four buttons. Page opens on By date (Claude's suggestion, "OK BUILD IT").
- Claude's calls: confirm step on every action; each action writes `audit_logs` in the same SQL statement; Email the host limited to once per payout per 24 hours and skipped when today's `email_log` count is 70 or more (same budget rule as the address reveal); CSV left out.

## Backend (outsyde-backend, PR 1, merge first)
- **Migration 071** `migrations/071_event_recovery_resolution.sql` (idempotent): replace the `event_payout_recoveries` status CHECK with `pending, reversed, owed, recovered, collected, written_off`; add `resolved_at TIMESTAMPTZ NULL`, `resolved_by VARCHAR(36) NULL REFERENCES users(id)`. Claude runs it in Neon before merge and verifies read-only.
- Router `server/events/adminEventsRouter.ts`, mounted at `/api/admin/events` in server/index.ts next to the other admin routers (~:380), every route behind `requirePlatformAdmin` (middleware/requirePlatformAdmin.ts).
- `GET /api/admin/events?from=&to=` (ISO; default: events starting from 90 days ago, all upcoming): one grouped SQL over events, ticket_types, tickets, ticket_orders, event_payouts, recoveries. Per event: id, slug, title, city, state, startsAt, endsAt, timezone, status, capacity, ticketsSold, ticketsValid, ticketsRefunded, salesCents (ticket prices of tickets sold), refundedCents, hostEarnsCents (sum host_net_cents of valid tickets), outsydeFeesCents (buyer service fees kept + host fees of valid tickets, from the stored per-ticket/order columns, never recomputed from percentages), host {type, id, name, ownerUsername, payoutReady}, payout {id, status, dueAt, paidAt, amountCents, deductedCents, attempts, lastError, holdReason} or null, plus `payoutStatus` from the exported helper used by the host summary (ticketRefunds.ts `payoutStatusFor`, extracted, unchanged behaviour). Also `totals` (same sums over the list) and `attention`: payouts in review, payouts held, recoveries owed over 30 days, each with ids, event title, host name, amount, reason.
- `GET /api/admin/events/:id`: the event row fields above, ticket types (name, priceCents, sold, salesCents, refundedCents, hostEarnsCents), orders counts (completed, refunded, refunding, flagged), checkedIn and validTickets, payout (all columns except the full connected account id: masked to last 4), recoveries list, host card, activity (created, published, ended, order refunds, payout created/paid/held/review, recoveries, admin actions from audit_logs), newest first.
- `POST /api/admin/events/payouts/:payoutId/retry`: one SQL statement: update `status='pending', attempts=0, next_attempt_at=now(), last_error=NULL, updated_at=now()` WHERE id and `status='review'` and the event is `published`; insert audit_logs in the same statement (CTE). 404 not found, 409 `NOT_IN_REVIEW` or `EVENT_NOT_PUBLISHED`.
- `POST /api/admin/events/recoveries/:recoveryId/resolve` body `{action: "collected" | "written_off"}`: one SQL statement WHERE `status='owed'`, sets status, resolved_at, resolved_by, updated_at, plus audit_logs. 409 `NOT_OWED`.
- `POST /api/admin/events/payouts/:payoutId/email-host`: only for `held` or `review`; 429 `EMAIL_RECENTLY_SENT` when an audit_logs row for this payout's email exists within 24 hours; 503 `EMAIL_BUDGET` when today's email_log count is 70 or more; sends through the existing Resend helper, logs email_log, writes audit_logs. Copy (real punctuation, no fee percentages): held: "Your payout for [event] is waiting. Finish your payout setup so we can send your earnings." review: "We couldn't send your payout for [event]. Please check your payout account details in Stripe, then reply to this email." Recipient resolved by host type, never returned in any response.
- Tests (localhost Postgres): `server/events/adminEvents.http.test.ts`: admin only (401, 403 non admin), list sums against seeded tickets (including a refund and a free event), buckets data, detail, retry guards and audit row, resolve guards, email guards (cooldown, budget) with the Resend stub. Re-run eventPayouts, ticketRefunds, eventSummary suites unchanged.

## Web (outsyde-web, PR 2, after PR 1 is live)
- `NAV_LINKS` gets `{ label: "Events", href: "/admin/events" }` (one line).
- `app/admin/events/page.tsx` + client component, `app/admin/events/[id]/page.tsx` + client, same inline style approach and admin classes (`.kpi-*` tiles, `.tab` filters, refunds-page rows and pills), look per mockup: black, cream, gold, Outsyde green for paid and ready.
- Pure logic `app/admin/events/_lib/money.ts` with tests: buckets (needs you now: payout review or held; payout due in 7 days: ended, unpaid, due within 7 days or waiting on refunds; coming up: not ended, soonest first; paid: most recent first; cancelled), host grouping (business, photographer, individual people), filter counts, search, money formatting, payout pill text.
- BFFs `app/api/admin/events/route.ts`, `[id]/route.ts`, `payouts/[payoutId]/retry`, `recoveries/[recoveryId]/resolve`, `payouts/[payoutId]/email-host`, using `backendAuthHeaders` + `proxyToBackend`, ids validated.
- Two-step confirm on every action (pattern from app/admin/users/page.tsx:579-596), busy state, success and error banners; 401/403 screens like refunds.
- Tests: logic unit tests; BFF http test (admin seeded as `info@goutsyde.com` with `is_admin`, token minted with `isAdmin:true`); browser check: list loads, By date default, switch to By host, filter counts, detail page, confirm flow for Try again.

## Order and checks
Backend PR (migration 071 run in Neon first) → Legend merges → Render live check → web PR → Vercel preview check → Legend merges. Regression: only the new routes and the recovery status values change; every reader of recovery status (eventPayouts.ts :153, :175-177, :391, :451, :518, :548, :603; bookingRecoveries.ts :549, :588) only matches the old values, so `collected`/`written_off` rows simply drop out of deduction and alerts, which is the intent.
