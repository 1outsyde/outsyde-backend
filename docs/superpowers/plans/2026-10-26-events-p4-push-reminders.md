# Events p4-push: Event Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guests get a push the day before and 2 hours before an event; the host gets one the day before. Tapping opens the right screen in the app.

**Architecture:** One additive migration (074) adds claim columns. A new backend job `runEventReminderJob` runs every minute in the existing cleanup loop, claims per holder with one `UPDATE ... RETURNING` (same pattern as `addressReveal.ts`), and sends one Expo push per person. The app extends `ticketPushTarget` so a reminder opens the ticket (guest) or the manage screen (host).

**Tech Stack:** Node/TypeScript, Postgres (Neon), drizzle `sql` tagged queries, Expo push; React Native app (expo-notifications, React Navigation).

**Spec:** Vault `Handoffs/Events App p4-push — Audit & Regression (2026-10-26).md` (decisions, audit, regression) and Events canvas screen 36 + its sticky (rules 1 to 8, approved by Legend 2026-10-26 6:10 PM).

## Global Constraints

- Two guest pushes: 24 hours before the start and 2 hours before. One push per person per event, however many tickets. Free RSVPs too.
- Skip a reminder for a ticket created at or after that reminder's moment (start minus 24h, start minus 2h). Nothing at or after the start.
- None for events not `published` (cancelled, paused, draft), for tickets not `valid`, or when the host account is inactive.
- Host gets one push the day before, only if the event was published before start minus 24h. "[N] going" = valid tickets on completed orders (same as door guest list).
- Push only, no email. Times shown in the event's own time zone.
- Day-before guest body never shows venue or street (city and state only): day-of address events must not leak.
- Push data: `{ type: "event_reminder", kind: "day_before" | "soon" | "host_day_before", eventId }`.
- Copy (screen 36): guest day before `Tomorrow: <title>` / `<Weekday> at <h:mm AM> in <City, ST>. Your ticket is in the app.`; 2 hours `<title> starts in 2 hours` / `Starts at <h:mm AM>. Tap for your ticket and directions.`; host `Your event is tomorrow: <title>` / `<N> going. Tap to see your guests and manage the event.` No dashes in copy.
- Migration: idempotent, additive only, run in Neon by Claude before merge with Legend's go. Never `drizzle-kit push` or `npm run db:migrate` against production.
- Backend tsc baseline 59 errors, app tsc baseline 67: no new errors.

## Review Focus

1. Job delayed (server down for hours): a late day-before push must not say "Tomorrow" on the event's own day, and a late 2-hour push must not say "in 2 hours" with 20 minutes left. Copy uses `Today` / `starts soon` then. Tests in Task 2.
2. Two job runs at once: each person still gets one push per kind. Test in Task 3.
3. Holder with tickets bought before AND after the moment: still one push (claims all their pre-moment tickets). Test in Task 3.
4. Event at 12:30 AM, local midnight boundaries in another time zone: Tomorrow/Today decided in the event's time zone, not UTC. Test in Task 2.
5. Host who is also a ticket holder: gets the host push and the guest pushes (different kinds), no duplicate of either. Test in Task 3.

---

### Task 1: Migration 074

**Files:**
- Create: `migrations/074_event_reminders.sql`

- [ ] **Step 1:** Write the file with a header comment in the style of 073 (purpose, "Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.", "Idempotent. Additive only."). Statements:
  - `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reminder_day_before_at TIMESTAMPTZ;`
  - `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reminder_soon_at TIMESTAMPTZ;`
  - `ALTER TABLE events ADD COLUMN IF NOT EXISTS host_reminder_at TIMESTAMPTZ;`
- [ ] **Step 2:** Apply twice on local Postgres; second run is a no-op with no error.
- [ ] **Step 3:** Commit `feat(events): migration 074, reminder claim columns`.

### Task 2: Reminder rules and copy (pure)

**Files:**
- Create: `server/events/eventReminderRules.ts`
- Test: `server/events/eventReminderRules.test.ts` (node:test + assert, run with `npx tsx`)

**Interfaces:**
- Produces:
  - `export type ReminderKind = "day_before" | "soon";`
  - `export const DAY_BEFORE_MS = 24*3600e3; export const SOON_MS = 2*3600e3;`
  - `export function dueKind(startsAt: Date, now: Date): ReminderKind | null` : `day_before` when `start-24h <= now < start-2h`, `soon` when `start-2h <= now < start`, else null.
  - `export function reminderMoment(startsAt: Date, kind: ReminderKind): Date`
  - `export function guestReminderCopy(kind: ReminderKind, e: { title: string; starts_at: Date | string; timezone: string; city?: string | null; state?: string | null }, now: Date): { title: string; body: string }`
  - `export function hostReminderCopy(e: { title: string; starts_at: Date | string; timezone: string }, going: number, now: Date): { title: string; body: string }`

- [ ] **Step 1: Write failing tests** (event "Rooftop Night", starts `2026-10-31T01:00:00Z` = Fri Oct 30 9:00 PM America/New_York, city Freeport, state NY):
  - `dueKind` at start-24h → `day_before`; start-2h-1ms → `day_before`; start-2h → `soon`; start-1ms → `soon`; start → null; start-24h-1ms → null.
  - day before at start-24h: `{ title: "Tomorrow: Rooftop Night", body: "Friday at 9:00 PM in Freeport, NY. Your ticket is in the app." }`.
  - day before delivered late on the event's local day (start-5h): title `Today: Rooftop Night`, same body.
  - no city/state: body `Friday at 9:00 PM. Your ticket is in the app.`
  - soon at start-2h: `{ title: "Rooftop Night starts in 2 hours", body: "Starts at 9:00 PM. Tap for your ticket and directions." }`; at start-89min: title `Rooftop Night starts soon`.
  - time zone: event at `2026-10-31T04:30:00Z` in America/New_York (Sat 12:30 AM) with now `2026-10-30T04:30:00Z` (Fri 12:30 AM NY, already Fri in UTC too) → `Tomorrow:`; same instant in America/Los_Angeles (Fri 9:30 PM LA event, now Thu 9:30 PM LA) → `Tomorrow:` and body starts `Friday at 9:30 PM`.
  - host at start-24h, going 12 → `{ title: "Your event is tomorrow: Rooftop Night", body: "12 going. Tap to see your guests and manage the event." }`; late same day → `Your event is today: Rooftop Night`.
- [ ] **Step 2:** Run `npx tsx server/events/eventReminderRules.test.ts`, expect failures (module missing).
- [ ] **Step 3:** Implement. Day comparison: local `YYYY-MM-DD` of start vs now via `Intl.DateTimeFormat("en-CA", { timeZone })`; same day → Today, else Tomorrow. Weekday and time via `Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" })` and `{ hour: "numeric", minute: "2-digit" }`. "starts in 2 hours" when at least 90 minutes remain, else "starts soon". Invalid time zone falls back to UTC (like `formatEventWhen`).
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(events): reminder rules and copy`.

### Task 3: Reminder job

**Files:**
- Create: `server/events/eventReminders.ts`
- Test: `server/events/eventReminders.http.test.ts` (local Postgres via `EV_TEST_PG_URL`, recording fake via `setNoticeDepsForTest`, same harness as `addressReveal.http.test.ts`)
- Modify: `server/bookingStateMachine.ts` (after the address reveal step, own try/catch, comment in the same style)

**Interfaces:**
- Consumes: Task 2 exports; `rows` from `./eventsRouter`; `noticeDeps` from `./ticketNotices`.
- Produces: `export async function runEventReminderJob(now: Date = new Date(), opts: { batchSize?: number } = {}): Promise<{ guestPushes: number; hostPushes: number }>`

Behavior: select events `status = 'published'`, `starts_at > now`, `starts_at <= now + 24h`, host active (same subquery as addressReveal). Per event (own try/catch), kind = `dueKind`; if kind, claim guests in batches (default 200, max 50 batches): `UPDATE tickets SET <column> = now() WHERE event_id = $e AND status = 'valid' AND <column> IS NULL AND created_at < <moment> AND holder_user_id IN (SELECT DISTINCT holder_user_id ... ORDER BY holder_user_id LIMIT $n) RETURNING holder_user_id`; one push per distinct holder. Host (only when kind is `day_before`): `UPDATE events SET host_reminder_at = now() WHERE id = $e AND host_reminder_at IS NULL AND published_at < <day-before moment> RETURNING host_user_id`, then count going (valid tickets joined to completed orders) and push. Push failures are logged, never thrown, never retried.

- [ ] **Step 1: Write failing tests** (each seeds its own users/event/orders/tickets with a unique prefix; `now` passed explicitly):
  - day before: holder with 3 valid tickets gets exactly 1 push, data `{ type: "event_reminder", kind: "day_before", eventId }`, copy as Task 2; all 3 tickets stamped.
  - second run at the same `now` sends nothing.
  - two runs at once (`Promise.all`) send 1 push total per holder.
  - ticket created after start-24h: no day-before push; at start-2h that holder gets the `soon` push.
  - holder with one ticket before and one after the moment: one push.
  - refunded or cancelled tickets only: no push. Event `paused` or `cancelled`: no push. Host inactive: no push. Event already started: no push.
  - `batchSize: 2` with 5 holders: 5 pushes.
  - host: published before start-24h, 2 valid tickets on a completed order + 1 refunded → host push `kind: "host_day_before"`, body `2 going. ...`; once only. Published after start-24h: no host push. At start-2h no host push.
  - host who also holds a ticket: gets host push and day-before guest push (2 pushes, different kinds).
  - mutation notes (comment block, like addressReveal.http.test.ts): drop `created_at <` → late-ticket test fails; drop `IS NULL` → second-run test fails; drop `status = 'valid'` → refunded test fails.
- [ ] **Step 2:** Run with the local servers' env (vault "How Claude tested"): `npx tsx server/events/eventReminders.http.test.ts`, expect failures.
- [ ] **Step 3:** Implement `eventReminders.ts` and wire it into `startBookingCleanupJob` after address reveal.
- [ ] **Step 4:** Tests pass; `addressReveal.http.test.ts` still passes; backend `npx tsc --noEmit` error count 59 with the same set as main.
- [ ] **Step 5:** Commit `feat(events): day before and 2 hour reminder pushes, host day before push`.

### Task 4: App tap targets

**Files (OutsydeCapture):**
- Modify: `utils/ticketCheckoutLogic.ts:313-319`
- Modify: `hooks/useTicketPushLinks.ts`
- Test: `utils/ticketCheckoutLogic.test.ts:267-272`

**Interfaces:**
- Produces: `export type TicketPushTarget = { screen: "tickets" | "ticket" | "manage"; eventId: string | null };` and `ticketPushTarget(data) : TicketPushTarget | null` (keeps `eventId`, adds `screen`).

- [ ] **Step 1: Update and add tests:**
  - `address_reveal` with eventId → `{ screen: "tickets", eventId: "e1" }`; without → `{ screen: "tickets", eventId: null }`.
  - `event_reminder` kind `day_before` / `soon` with eventId → `{ screen: "ticket", eventId: "e1" }`; without eventId → `{ screen: "tickets", eventId: null }`.
  - `event_reminder` kind `host_day_before` with eventId → `{ screen: "manage", eventId: "e1" }`; without → null.
  - `event_reminder` unknown kind → null; `new_message` → null; null → null.
- [ ] **Step 2:** `npx tsx utils/ticketCheckoutLogic.test.ts` fails.
- [ ] **Step 3:** Implement. Hook keeps the target object in state (not a boolean); after sign-in check: `tickets` → `CartOrders { openTab: "tickets", _ts }` (unchanged), `ticket` → `TicketDetail { eventId }`, `manage` → `ManageEvent { eventId }`. Update the hook's header comment.
- [ ] **Step 4:** All 24 app test files pass; app tsc error set equals main (67); `npx expo export --platform ios` and `--platform android` succeed.
- [ ] **Step 5:** Commit `feat(events): reminder push opens the ticket or the manage screen`.

### Task 5: Ship

- [ ] Fresh independent review of both branches (reviewer has not seen the work).
- [ ] Push branches, open backend and app PRs (diffs with +/-; backend first, app ships with the next EAS build).
- [ ] With Legend's go, run 074 in Neon, then read-only check the three columns exist.
- [ ] Update vault (p4-push note, Priority Queue, Regression Check Protocol hotspot, Events & Ticketing) and the Launch Board.
