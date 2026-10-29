-- Migration 082: event team roles, part B (p4-team step 1 follow up, 2026-10-29).
--
-- Drops the 067 one-row-per-person indexes so one person can hold several roles on one team
-- (Admissions = door, security, host / promoter). The per-role indexes from 081 keep one active row
-- per (host, member, role) and per (event, member, role).
--
-- Run in Neon ONLY after Render serves backend #385 (a50bff7) or later. The old code's
-- ON CONFLICT (host_user_id, member_user_id) needs uq_event_door_team_active; the new code's
-- ON CONFLICT (..., role) uses the 081 indexes (doorRouter.ts:75 and :80).
--
-- Idempotent. No row changes. Never via drizzle-kit push.
--
-- Rollback (only valid while every active (host, member) / (event, member) pair still has one role):
--   CREATE UNIQUE INDEX IF NOT EXISTS uq_event_door_team_active ON event_door_team (host_user_id, member_user_id) WHERE removed_at IS NULL;
--   CREATE UNIQUE INDEX IF NOT EXISTS uq_event_door_members_active ON event_door_members (event_id, member_user_id) WHERE removed_at IS NULL;

DROP INDEX IF EXISTS uq_event_door_team_active;
DROP INDEX IF EXISTS uq_event_door_members_active;
