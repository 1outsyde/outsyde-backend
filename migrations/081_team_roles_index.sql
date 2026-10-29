-- Migration 081: event team roles, part A (p4-team step 1, 2026-10-29).
--
-- One person can hold several roles on one team (Admissions = door, security, host / promoter). The 067 indexes
-- allow one active row per (host, member) and per (event, member); the new ones allow one per role.
--
-- Part A (this file) only ADDS the per-role indexes. Run it in Neon BEFORE the PR merges: the old code's
-- ON CONFLICT (host_user_id, member_user_id) still finds its 067 index, and the new code's
-- ON CONFLICT (..., role) finds these. Part B (082) drops the 067 indexes once Render runs the new code.
--
-- Idempotent. Additive: no row changes. Every existing row has role 'door' (075 default), and the 067 indexes
-- already make (host, member) / (event, member) unique, so the new indexes always build.
-- Never via drizzle-kit push.

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_door_team_active_role
  ON event_door_team (host_user_id, member_user_id, role) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_door_members_active_role
  ON event_door_members (event_id, member_user_id, role) WHERE removed_at IS NULL;
