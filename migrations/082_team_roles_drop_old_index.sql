-- Migration 082: event team roles, part B (p4-team step 1, 2026-10-29).
--
-- Drops the 067 one-row-per-person indexes so one person can hold several roles. Run in Neon only AFTER Render
-- runs the code from the p4-team step 1 PR (its ON CONFLICT targets use the 081 per-role indexes). Before this
-- runs, a second role for the same person is refused as ALREADY_INVITED / ALREADY_ON_TEAM: safe, just not yet
-- allowed. Idempotent.
--
-- Rollback (only while no person holds two active roles on one team):
--   CREATE UNIQUE INDEX uq_event_door_team_active ON event_door_team (host_user_id, member_user_id) WHERE removed_at IS NULL;
--   CREATE UNIQUE INDEX uq_event_door_members_active ON event_door_members (event_id, member_user_id) WHERE removed_at IS NULL;

DROP INDEX IF EXISTS uq_event_door_team_active;
DROP INDEX IF EXISTS uq_event_door_members_active;
