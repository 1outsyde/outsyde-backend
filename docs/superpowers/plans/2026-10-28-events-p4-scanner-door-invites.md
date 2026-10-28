# Events p4-scanner: Door Team Invites + App Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adding someone to a door team sends an invite (push, Activity, email) that they must accept before they can scan, and the app gets the door scanner, door team and invite screens (Events canvas 37 to 41, 14, 15).

**Architecture:** Invite state lives on the two existing door tables (067) as new columns from migration 075. Access (`loadEventForDoor`, `GET /door/mine`) counts only accepted, unremoved rows. New member routes under `/api/events/door/invites/*` in `doorRouter.ts` (mounted before `eventsRouter`). Responses stay additive. goutsyde.com and the app consume the same routes; the app ports goutsyde.com's pure door and scan helpers.

**Tech Stack:** Express 4 + raw SQL via `rows()` (backend), Next.js app router BFFs (web), Expo SDK 58 + `expo-camera ~58.0.12` `CameraView` (app).

**Spec:** Events canvas https://claude.ai/artifact/PkGMJ3tib9mtbYdsVvorUr screens 14, 15, 37 to 41 and the orange p4-scanner sticky (rules 1 to 8 approved by Legend 2026-10-28; role column approved). Audit: vault `Handoffs/Events App p4-scanner — Audit (2026-10-26)` + 2026-10-28 audit/regression note.

## Global Constraints

- Mains: backend `439a52d`, app `63b517c`, web `0ef17b2`. Fresh clones only.
- Migration `075_door_team_invites.sql`: hand run in Neon by Claude BEFORE merge, with Legend's go. Never drizzle-kit push / db:migrate against production. Idempotent.
- Responses are additive only (old fields keep name, type and meaning).
- Copy: real punctuation, no dashes, never a fee percentage. Copy as drawn on 37 to 41.
- Role column: `role TEXT NOT NULL DEFAULT 'door' CHECK (role IN ('door','security','host'))`. Every route writes and accepts only `door` until p4-team.
- Email: at most once per invite row per 24 hours, and only while the New York day's `email_log` count is under 70 (same ceiling as `addressReveal.ts:22`). Over budget: push and Activity still go.
- Members never see money, emails or addresses. Host only routes keep answering 404 `EVENT_NOT_FOUND` to anyone else.
- Backend tsc baseline 59; app tsc baseline 65 (SDK 58), app test files 24 all passing; `npx expo export --platform ios|android` must pass.

## Review Focus

- Re-running 075 after real invites exist must NOT mark pending invites accepted: the backfill runs only in the same DO block that adds `accepted_at`. Test: run 075 twice on a DB holding a pending invite; it stays pending.
- An invite opened after the host cancelled it, or after an only-this-event invite's event ended, shows "This invite is no longer open" and Accept answers 409 `INVITE_CLOSED`, never access.
- Someone other than the invitee opening `/door/invites/:id` (link forwarded) gets 404 `INVITE_NOT_FOUND`, same as an unknown id.
- A host hammering Send invite / Invite again: 409 for a pending invite, per host rate limit 30 an hour, and the email guard above, so one person can't be spammed.
- Two taps on Accept (or Accept on app and web at once): exactly one accept, one host push.

---

### Task 1: Migration 075

**Files:** Create `migrations/075_door_team_invites.sql`; Test `server/events/doorInvites.http.test.ts` (migration section).

Columns on BOTH `event_door_team` and `event_door_members`: `invited_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `accepted_at TIMESTAMPTZ`, `declined_at TIMESTAMPTZ`, `removed_by_user_id VARCHAR(36) REFERENCES users(id)`, `invite_emailed_at TIMESTAMPTZ`, `role` as above, plus `CHECK (NOT (accepted_at IS NOT NULL AND declined_at IS NOT NULL))`. Backfill `accepted_at = created_at` only inside `DO $$ ... IF NOT EXISTS (column accepted_at) THEN ALTER ...; UPDATE ...; END IF $$`. Header: run in Neon before merge, rollback lines.

- [ ] Test: apply 075 to the local DB twice; insert a row with accepted_at NULL between the runs; assert still NULL after run 2; assert `role` default `door` and CHECK rejects `bouncer`.
- [ ] Write the migration; run on local Postgres; test passes.
- [ ] Commit.

### Task 2: Access counts only accepted rows

**Files:** Modify `server/events/doorAccess.ts:21-24`, `server/events/doorRouter.ts:78-89` (`/door/mine`); Tests `doorAccess.http.test.ts`, `doorCheckin.http.test.ts`, `eventSummary.http.test.ts` (fixtures insert `accepted_at = now()`).

- [ ] Test (doorAccess): pending standing row and pending event row → `loadEventForDoor` null; declined → null; accepted → role as today. `/door/mine` lists accepted only.
- [ ] Add `AND accepted_at IS NOT NULL` to all four EXISTS clauses. Update existing fixtures to accepted. All door tests pass.
- [ ] Commit.

### Task 3: Host side, invite instead of add

**Files:** Modify `server/events/doorRouter.ts` (`POST /:id/door/team` :121, `GET /:id/door/team` :102), `server/events/ticketNotices.ts` (replace `notifyDoorTeamAdded` :250 with `notifyDoorInvite`), `server/emailService.ts` (add `renderDoorTeamInvite`, `sendDoorTeamInviteEmail`); Test `server/events/doorTeam.http.test.ts`.

**Interfaces — Produces:** member JSON gains `inviteId: string`, `status: "invited" | "accepted" | "declined"`, `invitedAt: string | null` (all old keys unchanged). `notifyDoorInvite(p: { inviteId: string; table: "standing" | "event" }): Promise<void>` never throws.

Rules: new row → 201 status invited. Existing declined row → same row reset (`declined_at NULL, invited_at now()`) → 201. Pending → 409 `ALREADY_INVITED` "You already invited them. They can scan once they accept." Accepted → 409 `ALREADY_ON_TEAM` (today's copy). Per host limiter 30/hour → 429 `RATE_LIMITED`. Team list returns non-removed rows of all three states.
Notice: push `{ title: "[Host name] invited you to their door team", body: "Tap to accept or decline.", data: { type: "door_team_invite", inviteId } }`; Activity row `type door_team_invite, referenceType event_door_invite, referenceId inviteId, metadata { inviteId, scope, eventId? }`; email per Global Constraints, subject "[Host name] invited you to their door team", body as canvas 41, button "Accept or decline" → `${FRONTEND_URL}/events/door`, tag `{ kind: "ticket", label: "Door team invite" }`.

- [ ] Tests: add → 201 invited + no access yet; push/Activity/email each once (test deps); second add → 409 ALREADY_INVITED and no second notice; decline then add → 201, same row id; accepted → 409 ALREADY_ON_TEAM; email skipped when 70 email_log rows today but push + Activity sent; email skipped when invite_emailed_at < 24h; 31st invite in an hour → 429; team list shows the three statuses; member JSON has no email key.
- [ ] Implement; tests pass. Commit.

### Task 4: Member routes

**Files:** Modify `server/events/doorRouter.ts` (new section, before `/:id/...` routes), header comment; Test `server/events/doorInvites.http.test.ts`.

Routes (all `hybridAuthMiddleware`, `doorLimiter`):
- `GET /door/invites` → `{ success, invites: Invite[] }` open invites only (pending, not removed, event scope event not ended/cancelled).
- `GET /door/invites/:inviteId` → `{ success, invite: Invite }`; status `invited | accepted | declined | gone` (removed, or event scope and event ended/cancelled). Not the invitee or unknown → 404 `INVITE_NOT_FOUND`.
- `POST /door/invites/:inviteId/accept` | `/decline` → 200 `{ success, invite }`; one atomic UPDATE `WHERE accepted_at IS NULL AND declined_at IS NULL AND removed_at IS NULL` (+ event not ended for event scope); miss → 409 `INVITE_CLOSED` "This invite is no longer open." Accept pushes the host once `{ title: "[First name] joined your door team", body: "They can scan tickets for [what].", data: { type: "door_team_accepted", eventId } }`. Decline: no host notice.
- `POST /door/invites/:inviteId/leave` → accepted rows only, sets `removed_at, removed_by_user_id = member`; else 409 `NOT_ON_TEAM`.

`Invite` = `{ id, scope: "standing"|"event", role: "door", status, invitedAt, host: { name }, event: {id,title,startsAt,endsAt,timezone} | null, upcoming: {id,title,startsAt,timezone}[] }` (standing: host's next 5 published, not ended events). Host name = `hostIdentity(e).publicName` (same as reveal push). Invite id lookup searches both tables (UUIDs).

- [ ] Tests: list/get/accept/decline/leave happy paths; double accept in parallel → exactly one 200 + one host push; accept after host cancel → 409; get as stranger → 404; event scope after ends_at → status gone and accept 409; leave → access gone on the next call; route table check that `/api/events/me/tickets`, `/mine`, `/slug/x`, `/payouts/status`, `/:id/orders`, `/door/mine` still answer as before.
- [ ] Implement; full backend door suite + tsc (≤ 59) pass. Commit, PR.

### Task 5: goutsyde.com invites (40) and team states

**Files:** Create `app/api/events/door/invites/route.ts`, `app/api/events/door/invites/[inviteId]/route.ts`, `.../[inviteId]/{accept,decline,leave}/route.ts` (forward + `isUuid` guard, as `door/team`). Modify `app/events/_host/doorLogic.ts` (types `TeamMember.status?`, `DoorInvite`, `isDoorInvite`, `memberStatusLine`, `inviteSummary`), `app/events/door/DoorClient.tsx` (INVITES FOR YOU section, Accept/Decline, reload list), `app/events/[id]/team/TeamClient.tsx` (Send invite, notice "Invite sent. [name] can scan once they accept.", row actions Remove / Cancel invite / Invite again). Tests `tests/events-door-logic.test.ts`, `tests/events-bff.http.test.ts` (add → invite → accept before door/mine lists it; BFF guard cases for new routes), `tests/events-door.browser.py` (accept step).

- [ ] Logic tests first, then BFF test, then UI; `next build` passes; browser test passes on localhost against the Task 4 backend. Commit, PR.

### Task 6: App door screens and scanner

**Files:** Create `utils/host/doorLogic.ts` + `.test.ts` (port of web doorLogic + scanLogic: `qrToCode`, `cleanTyped`, `makeRecent`, `resultFor`, `filterGuests`, `replaceGuest`, `progressPct`, invite guards and status copy), `screens/host/DoorTeamScreen.tsx` (38), `screens/DoorInviteScreen.tsx` (39, states invited/accepted/declined/gone), `screens/host/DoorScannerScreen.tsx` (14, 15: `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ["qr"] }}`, `onBarcodeScanned`, `enableTorch`, `useCameraPermissions`; Type a code; Guest list with tap to check in; Undo for host only; same code ignored for 3 s), `screens/DoorEventsScreen.tsx` (Door check in: invites + events I can scan, like 40). Modify `services/api.ts` (door team, invites, mine, check-in, check-in-ticket, undo), `screens/host/ManageEventScreen.tsx` (Scan tickets + Door team (n), replace the "come with the door scanner step" line), Account menu (Door check in item), `navigation/types.ts` + stack, `screens/NotificationsScreen.tsx:157` and `utils/ticketCheckoutLogic.ts:317` push targets (`door_team_invite` → DoorInvite, `door_team_accepted` → DoorTeam), `app.json:18` camera text "Outsyde uses your camera to create posts and stories, and to scan event tickets at the door."

- [ ] Logic tests first (push targets included); screens; tsc error set equals baseline 65; 25 test files pass; expo export ios + android pass; harness screenshots of 37, 38, 39 (4 states), scanner (camera denied + result states) at 390x844. Commit, PR.

### Task 7: Verify and hand over

- [ ] Fresh reviewer agent over all three branches; fix findings.
- [ ] Legend's go → run 075 in Neon, verify columns via information_schema, 0 rows changed. Then Legend merges backend, web, app.
- [ ] Vault: audit note, Events & Ticketing, Priority Queue, Regression hotspot (door invites), Hosting (075). Launch Board row p4-scanner.
