# Events Door Check-in, Door Team and QR Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Legend chose task by task with a reviewer). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host and their door team check tickets in at the door by scanning a QR, and show each ticket's QR in My Tickets and the receipt email.

**Architecture:** Migration 067 adds a standing door team per host and per-event door members. One access helper decides, on every call, whether a user is the host or an active team member of an event. A new router under `/api/events` holds the door routes (team management, check-in with one atomic UPDATE, host undo, a money-free guest list) and a public signed QR PNG route. Receipt emails and `/me/tickets` gain QR image links (additive). No money lines change.

**Tech Stack:** TypeScript, Express 4, drizzle `sql` + neon-http (`rows` from server/events/eventsRouter.ts), zod, express-rate-limit, new dependency `qrcode` (approved by Legend 2026-10-22), plain `npx tsx` tests on local Postgres.

**Spec:** Vault `Features/Events Phase 3 — Discover Design.md` (2026-10-22 door check-in note + Legend's decisions). Audit and regression: vault `Handoffs/Events Door Check-in, Team and QR Email — Audit / Regression (2026-10-22)`. Mockups 14 to 17 on the Events in Discover canvas. Base: main `b669f57`.

## Global Constraints
- Access (recomputed on every call): **host** = `events.host_user_id = user`; **standing member** = active row in `event_door_team` for that host (`removed_at IS NULL`); **event member** = active row in `event_door_members` for that event and `now() < events.ends_at`. Users must be active (`users.is_active = true AND COALESCE(deletion_status,'active') = 'active'`, same as `loadActiveUser`).
- Scan window: `events.status = 'published'` and `starts_at − 6 hours <= now() <= ends_at` (Legend 2026-10-22). Outside it: 409 `CHECKIN_CLOSED`.
- Check-in: one atomic `UPDATE tickets SET checked_in_at = now(), checked_in_by_user_id = $user WHERE code = $code AND event_id = $event AND status = 'valid' AND checked_in_at IS NULL AND <order completed> AND <event published, in window> RETURNING …`. On 0 rows, classify with a read: `ALREADY_CHECKED_IN` (with time and scanner first name), `NOT_VALID` (refunded or cancelled), `WRONG_EVENT` (code belongs to another event **that this scanner also has access to**, with that event's title), else `NOT_FOUND`. A code for an event the scanner can't access answers exactly like an unknown code.
- Undo: host only, sets both check-in columns to NULL where `checked_in_at IS NOT NULL`.
- Host refunds after check-in stay allowed (unchanged); buyer refund and RSVP cancel already block after check-in (unchanged).
- Team members never receive money fields (`*_cents`, earnings, payouts), emails, addresses, or event edit access. Guest list fields: ticket id, guest first name, username, ticket type name, `checkedInAt`, `checkedInBy` first name.
- QR: the QR encodes only the existing 16 character ticket `code`. The image URL is `${API_BASE_URL}/api/events/qr/<token>.png` where token = base64url(ticketId) + "." + base64url(HMAC-SHA256(secret, "ticket-qr:" + ticketId)) truncated to 22 chars; secret = `JWT_SECRET ?? SESSION_SECRET`; verify with `timingSafeEqual`. The code never appears in the URL. Unknown, tampered or not-`valid` ticket → identical 404. Response headers: `Content-Type: image/png`, `Cross-Origin-Resource-Policy: cross-site`, `Referrer-Policy: no-referrer`, `Cache-Control: private, max-age=86400`.
- Rate limits (express-rate-limit, new instances): door check-in/undo/lookup 120 per minute keyed by user id; QR route 120 per minute per IP. JSON error body `{ success:false, error:{ code:"RATE_LIMITED", message } }`.
- Adding a member: by exact username (case-insensitive), not self, active account, no duplicate active row; push only (no email): title "You're on the door team", body "You can now scan tickets for [event title]." (standing: "for [host name]'s events."). Fire and forget.
- Additive only: existing response fields unchanged; `TicketReceiptParams` new fields optional.
- Copy: real punctuation, no dashes, never a fee percentage.
- One SQL statement per multi-row change; tests on localhost only; migration 067 hand-run in Neon by Claude before merge (production has 0 tickets).

## Review Focus
1. Two phones scan the same ticket at the same moment: exactly one "Checked in", the other "Already checked in". → Task 3 test `double scan checks in once`.
2. A per-event member scans after the event's end, or after being removed: denied on that very call. → Task 1 tests `event member denied after ends_at`, `removed member denied`.
3. A scanner tries a code from an event they have no access to: same answer as a made-up code. → Task 3 test `code from inaccessible event looks unknown`.
4. Refunded ticket that was checked in before: scanning says not valid, undo still works for the host. → Task 3 tests.
5. Forged or edited QR link: 404, and the real code never appears in any URL or log. → Task 4 tests.

---

### Task 1: Migration 067 and door access

**Files:**
- Create: `migrations/067_event_door_team.sql`
- Create: `server/events/doorAccess.ts`
- Test: create `server/events/doorAccess.http.test.ts`

**Interfaces:**
- Produces: `export type DoorRole = "host" | "standing" | "event"`.
- Produces: `export async function loadEventForDoor(eventId: string, userId: string): Promise<{ event: any; role: DoorRole } | null>` (null = no access; uses the access rules in Global Constraints; event row includes `id, title, host_user_id, status, starts_at, ends_at, timezone`).
- Produces: `export function isWithinScanWindow(e: { status: string; starts_at: Date | string; ends_at: Date | string }, now: Date): boolean`.
- Migration 067: `event_door_team (id VARCHAR(36) PK DEFAULT gen_random_uuid()::text, host_user_id VARCHAR(36) NOT NULL REFERENCES users(id), member_user_id VARCHAR(36) NOT NULL REFERENCES users(id), added_by_user_id VARCHAR(36) NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), removed_at TIMESTAMPTZ, CHECK (host_user_id <> member_user_id))`, partial unique index on `(host_user_id, member_user_id) WHERE removed_at IS NULL`, index on `member_user_id WHERE removed_at IS NULL`; `event_door_members` same shape with `event_id VARCHAR(36) NOT NULL REFERENCES events(id)` instead of host, unique `(event_id, member_user_id) WHERE removed_at IS NULL`, index on member; `CREATE INDEX IF NOT EXISTS idx_tickets_event_checkin ON tickets (event_id) WHERE checked_in_at IS NOT NULL`. Idempotent; header with hand-run note and rollback lines (copy 066's style). Check the id default matches how other tables in 056 generate ids and follow that instead if different.

- [ ] **Step 1:** Write migration 067; apply to local DB twice (idempotent).
- [ ] **Step 2: Failing tests:** host → `host`; standing member → `standing`; event member before end → `event`; `event member denied after ends_at`; `removed member denied`; standing member of a different host denied; stranger denied; inactive member denied; `isWithinScanWindow` true at `starts_at − 6h`, false 1 minute earlier, true at `ends_at`, false 1 minute after, false for draft, paused, cancelled.
- [ ] **Step 3: Run** → fail. **Step 4: Implement.** **Step 5: Run** → pass; tsc 59.
- [ ] **Step 6: Commit** `feat(events): door team tables and access rules`

### Task 2: Door team management

**Files:**
- Create: `server/events/doorRouter.ts` (mounted in `server/index.ts` next to the other `/api/events` routers)
- Modify: `server/events/ticketNotices.ts` (`NoticeDeps` already has `sendPush`; add `notifyDoorTeamAdded`)
- Test: create `server/events/doorTeam.http.test.ts`

**Interfaces:**
- Consumes: Task 1 `loadEventForDoor`; `loadActiveUser`, `rows`, `fail` from eventsRouter.ts; `hybridAuthMiddleware`.
- Produces routes (all `hybridAuthMiddleware`):
  - `GET /api/events/:id/door/team` (host only) → `{ success, standing: Member[], event: Member[] }`, `Member = { userId, firstName, username, addedAt }`.
  - `POST /api/events/:id/door/team` (host only) body `.strict()` `{ username: string (1-40), scope: "standing" | "event" }` → 201 `{ success, member: Member, scope }`; errors 404 `USER_NOT_FOUND`, 400 `CANNOT_ADD_SELF`, 409 `ALREADY_ON_TEAM`.
  - `DELETE /api/events/:id/door/team/:userId?scope=standing|event` (host only) → `{ success, removed: true }` (sets `removed_at = now()`), 404 `NOT_ON_TEAM`.
  - `GET /api/events/door/mine` (any signed-in user) → `{ success, events: { id, slug, title, startsAt, endsAt, timezone, role }[] }` — published events the user can scan that haven't ended, so a team member can find them.
- Non-host callers get 404 `EVENT_NOT_FOUND` on host-only routes (no existence leak).

- [ ] **Step 1: Failing tests:** add by username (case-insensitive) standing and event; self → 400; unknown → 404; duplicate → 409; inactive user → 404; non-host can't add or list (404); remove then re-add works; `/door/mine` lists host's events for a standing member, only the one event for an event member, nothing after removal; push sent once per add with the exact copy (stub deps); response never contains an email key.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass; existing event suites unchanged; tsc 59.
- [ ] **Step 5: Commit** `feat(events): host door team`

### Task 3: Check-in, undo and team guest list

**Files:**
- Modify: `server/events/doorRouter.ts`
- Test: create `server/events/doorCheckin.http.test.ts`

**Interfaces:**
- Consumes: Task 1 `loadEventForDoor`, `isWithinScanWindow`.
- Produces routes:
  - `POST /api/events/:id/door/check-in` body `.strict()` `{ code: string }` (trim, uppercase, `^[A-Z0-9]{16}$` else 400 `INVALID_CODE`) → 200 `{ success, result: "checked_in", ticket: GuestTicket }`; 409 with `error.code` one of `ALREADY_CHECKED_IN` (+ `ticket` with `checkedInAt`, `checkedInBy`), `NOT_VALID`, `WRONG_EVENT` (+ `otherEvent: { id, title }`), `CHECKIN_CLOSED`; 404 `NOT_FOUND`; 404 `EVENT_NOT_FOUND` when no access.
  - `POST /api/events/:id/door/undo` (host only) body `{ ticketId }` → `{ success, ticket: GuestTicket }`; 409 `NOT_CHECKED_IN`.
  - `GET /api/events/:id/door/guests` (host or team) → `{ success, checkedIn: number, total: number, guests: GuestTicket[] }` (valid tickets only for `total`; ordered by guest first name), `GuestTicket = { ticketId, firstName, username, ticketTypeName, checkedInAt, checkedInBy }`.
  - `POST /api/events/:id/door/check-in-ticket` body `{ ticketId }` → same results as check-in by code (guest list tap).
- Rate limiter per user id on these routes (Global Constraints).

- [ ] **Step 1: Failing tests:** valid code checks in and records scanner; `double scan checks in once` (two concurrent requests, one 200 and one 409 `ALREADY_CHECKED_IN`); refunded ticket → `NOT_VALID`; cancelled → `NOT_VALID`; ticket of pending order not checkable; `code from inaccessible event looks unknown` (404 `NOT_FOUND`); code of another event the scanner can access → `WRONG_EVENT` with title; before window and after end → `CHECKIN_CLOSED`; draft/paused/cancelled event → `CHECKIN_CLOSED`; stranger → 404 `EVENT_NOT_FOUND`; standing and event members can check in; team member can't undo (404); host undo then buyer refund works again; host refund of a checked-in order still works (existing route); guests list has no key ending `Cents`, no `email`, no address keys; counts correct; lowercase code with spaces accepted; 121st call in a minute → 429.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass; ticketRefunds, tickets, events suites unchanged; tsc 59.
- [ ] **Step 5: Commit** `feat(events): door check-in, undo and guest list`

### Task 4: Signed QR image route and My Tickets QR link

**Files:**
- Modify: `package.json`, `package-lock.json` (add `qrcode` and `@types/qrcode`)
- Create: `server/events/ticketQr.ts`
- Modify: `server/events/doorRouter.ts` (route), `server/events/ticketsRouter.ts:~530` (additive `qrUrl`), `server/index.ts:~187-206` (request logger redacts `/api/events/qr/<token>.png` to `/api/events/qr/[token].png`)
- Test: create `server/events/ticketQr.http.test.ts`; extend `server/events/tickets.http.test.ts`

**Interfaces:**
- Produces: `export function qrTokenFor(ticketId: string): string`, `export function ticketIdFromQrToken(token: string): string | null`, `export function qrUrlFor(ticketId: string): string` (`API_BASE_URL` base, trailing slash trimmed), `export async function qrPng(code: string): Promise<Buffer>` (error correction M, margin 2, width 512).
- Route: `GET /api/events/qr/:token.png` — no auth; looks up the ticket by id, requires `status = 'valid'`; responds with Global Constraints headers. Per-IP rate limit.
- `/me/tickets` each ticket gains `qrUrl` (string). Nothing else changes.

- [ ] **Step 1: Failing tests:** token round trip; tampered token → null; route returns PNG magic bytes `89 50 4E 47` with the four headers; decoding is optional, but at least assert `qrPng(code)` differs for two codes; tampered, unknown, refunded, cancelled → identical 404 body; the code string never appears in `qrUrl`; logger redaction unit check (export the redaction helper); `/me/tickets` has `qrUrl` and every old key unchanged.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** (`npm install qrcode @types/qrcode`). **Step 4: Run** → pass; tsc 59.
- [ ] **Step 5: Commit** `feat(events): signed QR images for tickets`

### Task 5: QR codes in the receipt email

**Files:**
- Modify: `server/events/ticketNotices.ts:~106` (select `id, code`), `server/emailService.ts:~2236-2272` (`TicketReceiptParams.qrUrls?: string[]`; when present render one `<img src width="160" height="160" alt="QR code for ticket N">` above each code row; copy line becomes "Show the QR code at the door. Each code lets one person in." only when QR present)
- Test: `server/events/ticketRefunds.http.test.ts` (existing receipt assertions + new)

**Interfaces:**
- Consumes: Task 4 `qrUrlFor`.

- [ ] **Step 1: Failing tests:** receipt with qrUrls has one `<img` per code with the right `src`; money rows identical to the receipt without qrUrls; old call without qrUrls renders exactly as before; `notifyOrderSettled` passes qrUrls in item order; still one send per order.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass; tsc 59.
- [ ] **Step 5: Commit** `feat(events): QR codes in ticket receipts`

### Task 6: Branch verification and hand-off

- [ ] **Step 1:** All event suites + bookingRecoveries + new door suites pass on localhost; tsc 59.
- [ ] **Step 2:** Whole-branch review (fresh reviewer, most capable model).
- [ ] **Step 3:** Hand-run migration 067 in Neon; confirm tables, indexes, constraint by SELECT.
- [ ] **Step 4:** Push `feat/events-door-checkin`, open PR with +/− summary; Legend merges; check Render is live (a new route answers); update vault and board.
