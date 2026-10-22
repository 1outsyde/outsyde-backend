# Events Phase 3 Step 1: Event List + Day-of Address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Legend chose task by task with a reviewer). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public event list for Discover, and an address option that reveals the full address to ticket holders on the day of the event, with a one-time reveal notice.

**Architecture:** One new address value `ticket_holders_day_of`. A pure helper computes the reveal instant (the earlier of 9:00 AM local on the event date or 6 hours before start); the slug route, ticket emails and a new every-minute step all use it. A new `GET /api/events` returns public cards with the same exposure rules as the slug route. Events get a map pin from the existing Nominatim geocoder when the client sends none. Migration 066 widens the CHECK, adds a per-ticket notice claim, and adds a list index. Additive only; no money lines change.

**Tech Stack:** TypeScript, Express, drizzle `sql` + neon-http (`rows` from `server/events/eventsRouter.ts`), zod, plain `npx tsx` test scripts, local Postgres for HTTP tests.

**Spec:** Vault `Features/Events Phase 3 — Discover Design.md` (approved 2026-10-22). Audit and regression: vault `Handoffs/Events Phase 3 Step 1 (Backend) — Audit (2026-10-22).md` and `— Regression (2026-10-22).md`. Base: main `1f91f51`.

## Global Constraints
- Reveal instant = min( 09:00 on the event's local calendar date of `starts_at` in `events.timezone`, `starts_at − 6 hours` ). Host always sees the address; holders from the reveal instant; everyone else never (unless `public`).
- `public` and `ticket_holders` behave exactly as today (same tests must pass unchanged).
- The list never returns: drafts, paused, cancelled, `visibility='unlisted'`, ended events (`ends_at <= now()`), events of inactive or deleting hosts (`u.is_active = true AND COALESCE(u.deletion_status,'active')='active'`), hidden ticket types, and for any event whose address is not public: venue, street, postal code, exact lat/lng, or any distance number.
- No change to fees, checkout, refunds, payouts, points, or any existing response field (additive only).
- Copy: real punctuation, no dashes, never a fee percentage.
- One SQL statement per multi-row change; `updated_at = now()` on UPDATEs of `events`; once-only work uses the claim pattern `UPDATE … WHERE … IS NULL … RETURNING`.
- Tests on localhost only. Migration 066 is hand-run in Neon by Claude before merge (production has 0 events, 0 tickets); never `npm run db:migrate` or `drizzle-kit push` on production.

## Review Focus
1. Event at 1:00 AM local (after midnight): 6 hours before = previous evening, earlier than 9 AM → reveal the evening before. → Task 1 test `1 AM event reveals 7 PM the day before`.
2. Daylight saving day (Nov 1 2026, America/New_York): 9:00 AM must be 9:00 local, not 8 or 10. → Task 1 test `9 AM on DST end day`.
3. Zone ahead of UTC (Asia/Tokyo) where the UTC date differs from the local date → Task 1 test `local date used, not UTC date`.
4. A buyer who purchases after the reveal gets the address in the receipt and no separate reveal notice. → Task 4 test `receipt after reveal has street` and Task 5 test `ticket bought after reveal gets no notice`.
5. Two job runs at once (setInterval has no overlap guard) send one notice per holder per event. → Task 5 test `two runs notify once`.

---

### Task 1: Migration 066 and reveal rules

**Files:**
- Create: `migrations/066_events_list_address_reveal.sql`
- Create: `server/zonedTime.ts` (move `zoneOffsetMs` and `wallClockToUtc` here unchanged; add `localDateInZone`)
- Modify: `server/manualRequests.ts:55-77` (delete the two functions; `export { wallClockToUtc } from "./zonedTime"` so every importer keeps working)
- Modify: `server/events/eventRules.ts:96-113`
- Test: `server/events/eventRules.test.ts`

**Interfaces:**
- Produces: `export type AddressVisibility = "public" | "ticket_holders" | "ticket_holders_day_of"` (eventRules.ts)
- Produces: `export function addressRevealAt(startsAt: Date, timeZone: string): Date`
- Produces: `export function holderCanSeeAddress(v: AddressVisibility, startsAt: Date, timeZone: string, now: Date): boolean` (true for `public` and `ticket_holders`; for day-of `now >= addressRevealAt(...)`)
- Produces: `visibleAddress(a, opts: { addressVisibility: AddressVisibility; viewerIsHost: boolean; viewerHasTicket: boolean; holderRevealed?: boolean })` where `show = public || viewerIsHost || (viewerHasTicket && (holderRevealed ?? true))`
- Produces: `export function localDateInZone(instant: Date, timeZone: string): string` ("YYYY-MM-DD", zonedTime.ts)

- [ ] **Step 1: Write migration 066**
  - Drop `events_address_visibility_check` and re-add it as `CHECK (address_visibility IN ('public','ticket_holders','ticket_holders_day_of'))`.
  - `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS address_reveal_notified_at TIMESTAMPTZ`.
  - `CREATE INDEX IF NOT EXISTS idx_events_list ON events (status, visibility, ends_at)`.
  - Header comment: what it does, "hand run in Neon before merge", rollback lines.
- [ ] **Step 2: Write the failing tests in `eventRules.test.ts`**
  All with `America/New_York` unless named:
  - Start `2026-10-25T01:00:00Z` (Sat Oct 24, 9 PM EDT) → `2026-10-24T13:00:00Z` (9 AM EDT), name `9 PM event reveals 9 AM same day`.
  - Start `2026-10-25T05:00:00Z` (1 AM EDT Oct 25) → `2026-10-24T23:00:00Z` (7 PM the day before), name `1 AM event reveals 7 PM the day before`.
  - Start `2026-10-24T19:00:00Z` (3 PM EDT) → `2026-10-24T13:00:00Z` (both rules agree), name `3 PM event reveals at 9 AM`.
  - Start `2026-10-24T15:00:00Z` (11 AM EDT) → `2026-10-24T09:00:00Z` (5 AM, 6 hours before is earlier), name `11 AM event reveals 6 hours before`.
  - DST end: start `2026-11-02T00:00:00Z` (Sun Nov 1, 7 PM EST) → `2026-11-01T14:00:00Z` (9 AM EST), name `9 AM on DST end day`.
  - `Asia/Tokyo`: start `2026-10-24T23:00:00Z` (8 AM JST Oct 25) → `2026-10-24T17:00:00Z` (6 hours before; using the UTC date would wrongly give `2026-10-24T00:00:00Z`), name `local date used, not UTC date`.
  - `holderCanSeeAddress("ticket_holders_day_of", start, tz, revealAt − 1 ms) === false`, at revealAt `=== true`; `public` and `ticket_holders` always true.
  - `visibleAddress` with day-of: holder before reveal hidden, holder after shown, host before reveal shown, stranger after reveal hidden. Existing visibleAddress tests unchanged.
- [ ] **Step 3: Run** `npx tsx server/events/eventRules.test.ts` → the new tests fail (functions missing).
- [ ] **Step 4: Implement** `zonedTime.ts` (move, plus `localDateInZone` via `Intl.DateTimeFormat("en-CA", { timeZone })`), the manualRequests re-export, and the eventRules functions (`addressRevealAt` = min of `wallClockToUtc(localDateInZone(startsAt, tz), "09:00", tz)` and `startsAt − 6h`). Add a mutation note to the test header: "drop the 6 hour branch → `1 AM event reveals 7 PM the day before` fails".
- [ ] **Step 5: Run** `npx tsx server/events/eventRules.test.ts` → all pass; `npx tsx` any existing manualRequests test file if present; `npx tsc --noEmit` error count equals main's.
- [ ] **Step 6: Commit** `feat(events): day-of address reveal rules + migration 066`

### Task 2: Slug route, create and edit

**Files:**
- Modify: `server/events/eventsRouter.ts:85` (zod enum), `:356-362` (slug), create `:245-300`, PATCH `:399-476`
- Create: `server/events/eventGeocode.ts`
- Test: `server/events/events.http.test.ts`

**Interfaces:**
- Consumes: Task 1 `AddressVisibility`, `holderCanSeeAddress`, `visibleAddress`.
- Produces: `export function geocodeEventInBackground(eventId: string, a: { addressLine1: string | null; city: string | null; state: string | null; postalCode: string | null }): void` — calls `geocodeAddress` from `server/geocoding.ts`; on success `UPDATE events SET latitude, longitude, updated_at = now() WHERE id = $1 AND latitude IS NULL`; never throws; skipped when city or state is missing.

- [ ] **Step 1: Failing HTTP tests** (localhost, existing harness): create with `addressVisibility:"ticket_holders_day_of"` → 201 and manage shows the value; `"bogus"` → 400 `INVALID_EVENT`; holder of a day-of event starting in 3 days sees `addressHidden:true` and null street; host sees the street; holder of a day-of event whose reveal has passed (start in 2 hours) sees the street; create without lat/lng and with a stubbed geocoder fills lat/lng (inject via a `setGeocoderForTest` seam in eventGeocode.ts); create with lat/lng given does not call the geocoder; PATCH changing `addressLine1` without lat/lng clears lat/lng and re-geocodes; geocoder returning null leaves the event saved.
- [ ] **Step 2: Run** with the server on localhost → new tests fail.
- [ ] **Step 3: Implement**: widen zod; slug route passes `holderRevealed: holderCanSeeAddress(e.address_visibility, e.starts_at, e.timezone, new Date())`; create and PATCH call `geocodeEventInBackground` after the write when no lat/lng was sent and an address field was set; PATCH that changes any of `addressLine1, city, state, postalCode` without lat/lng sets `latitude = NULL, longitude = NULL` in the same UPDATE.
- [ ] **Step 4: Run** events.http + tickets.http + ticketCheckout.http suites → all pass (existing counts unchanged plus new).
- [ ] **Step 5: Commit** `feat(events): day-of address on event page, geocode events`

### Task 3: Public list `GET /api/events`

**Files:**
- Modify: `server/events/eventsRouter.ts` (route registered before any `/:id` route)
- Create: `server/events/eventList.ts` (query + card shaping)
- Test: create `server/events/eventList.http.test.ts`

**Interfaces:**
- Consumes: Task 1 `visibleAddress` (with `viewerIsHost:false, viewerHasTicket:false`), existing `ticketSalesStatus`.
- Produces: `GET /api/events?lat&lng&radiusKm&city&from&to&free&limit&cursor` → `{ success, events: EventCard[], nextCursor: string | null }`.
- `EventCard = { id, slug, title, coverImageUrl, startsAt, endsAt, timezone, city, state, venueName, addressHidden, host: { name, avatarUrl, kind }, priceFromCents: number | null, hasFree: boolean, soldOut: boolean }` — `venueName` null when hidden; no lat/lng and no distance in any card.
- Query rules: Global Constraints list filter; `radiusKm` default 40, max 200; distance filter uses the event's stored lat/lng in SQL only (bounding box plus haversine, `storage.ts:3331` pattern) and orders by `starts_at` (never by distance, so hidden locations can't be worked out); `city` = case-insensitive equal; `from`/`to` ISO with offset filter `starts_at < to AND ends_at > from`; `free=true` = no active visible type with `price_cents > 0`; `limit` default 20, max 50; cursor = base64 of `starts_at|id`, ordered `starts_at, id`.
- Validation: zod `.strict()`; bad input → 400 `INVALID_QUERY`.

- [ ] **Step 1: Failing tests**: seeds one each of published public, draft, paused, cancelled, unlisted, ended, inactive host, deleting host → only the published public event is listed; hidden ticket type name never appears in the raw response text; a `ticket_holders` event's card has no "1 Main St", no venue, no latitude key; `free=true` excludes an event with a paid visible type and includes free only; `city=freeport` matches "Freeport"; near filter includes an event 5 km away and excludes one 100 km away, and no response key named `distance*`; paging returns 2 pages with no repeat; `limit=500` → 400; anonymous call works without auth; a request with an invalid Bearer still gets 200 (public route).
- [ ] **Step 2: Run** → fail (route missing).
- [ ] **Step 3: Implement** `eventList.ts` + route.
- [ ] **Step 4: Run** eventList.http + events.http → pass.
- [ ] **Step 5: Commit** `feat(events): public event list for Discover`

### Task 4: Ticket emails respect the reveal time

**Files:**
- Modify: `server/events/ticketNotices.ts:66-87` (`loadOrder` also selects `e.address_visibility`; `emailEvent(e, now)`)
- Test: `server/events/ticketRefunds.http.test.ts` (uses `setNoticeDepsForTest`)

**Interfaces:**
- Consumes: Task 1 `holderCanSeeAddress`.
- Produces: `emailEvent(e, now = new Date())`: `whereText = holderCanSeeAddress(...) ? formatEventWhere(e) : cityState(e)` where `cityState` = "City, ST" or null.

- [ ] **Step 1: Failing tests**: day-of event before reveal → receipt `whereText === "Freeport, NY"` and no street; same for refund and cancel emails; receipt after reveal → full `"The Loft, Freeport, NY"`; `ticket_holders` event receipt unchanged (existing assertion `:190-200` still passes).
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** ticketRefunds.http + ticketCheckout.http → pass.
- [ ] **Step 5: Commit** `fix(events): emails hide the street until the reveal time`

### Task 5: Reveal notice step

**Files:**
- Create: `server/events/addressReveal.ts`
- Modify: `server/emailService.ts` (new `sendAddressRevealToHolder` next to `sendTicketReceiptToBuyer`, same branded layout), `server/events/ticketNotices.ts` `NoticeDeps` (add the sender), `server/bookingStateMachine.ts` (new try/catch step AFTER the booking recovery step)
- Test: create `server/events/addressReveal.http.test.ts`

**Interfaces:**
- Consumes: Task 1 `addressRevealAt`; `sendExpoPush` (`server/expoPushService.ts:23`); notice deps seam.
- Produces: `export async function runAddressRevealJob(now = new Date()): Promise<{ notified: number }>`.
- Algorithm: candidate events = `status='published' AND address_visibility='ticket_holders_day_of' AND ends_at > now AND starts_at <= now + interval '18 hours'`; keep those with `addressRevealAt(starts_at, timezone) <= now`; per event, claim in one statement `UPDATE tickets SET address_reveal_notified_at = now() WHERE id IN (SELECT id FROM tickets WHERE event_id = $1 AND status = 'valid' AND address_reveal_notified_at IS NULL AND created_at < $revealAt LIMIT 200) AND address_reveal_notified_at IS NULL RETURNING holder_user_id`; notify each distinct holder once: push title "Your event address is ready", body "The address for [title] is now in your tickets."; email with event name, when, full address, link to My Tickets. Failures are logged, never thrown.
- Copy is exact as above (no dashes).

- [ ] **Step 1: Failing tests** (localhost, stub deps): reveal passed → each holder notified once (two tickets same holder = one notice); `two runs notify once` (two `runAddressRevealJob` calls concurrently); refunded and cancelled tickets get none; `ticket bought after reveal gets no notice`; reveal not yet passed → none; `ticket_holders` event → none; a throwing email sender doesn't stop the push or other holders.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** + job step; keep `bookingRecoveries.test.ts:732-735` order check passing.
- [ ] **Step 4: Run** addressReveal.http + bookingRecoveries.test + all event suites → pass.
- [ ] **Step 5: Commit** `feat(events): one-time address reveal notice`

### Task 6: Branch verification and hand-off

- [ ] **Step 1:** `npx tsc --noEmit` error count equals main `1f91f51`; every event suite and bookingRecoveries tests pass on localhost; record counts.
- [ ] **Step 2:** Whole-branch review (fresh reviewer) against this plan and the Global Constraints.
- [ ] **Step 3:** Hand-run migration 066 in Neon (Claude), then confirm by SELECT: the new CHECK text, the column, the index.
- [ ] **Step 4:** Push branch `feat/events-list-day-of-address`, open PR with +/− diff summary; Legend merges in GitHub; then check the Render deploy log shows the service live for the merge commit; update the vault notes and the launch board.
