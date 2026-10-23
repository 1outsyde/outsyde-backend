-- Migration 067: event door team (who may scan tickets at the door)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: two new tables and three new indexes. No existing column changes.
--
--   event_door_team      standing door team: a host's people who may scan at ALL of that host's events
--   event_door_members   per-event door members: people who may scan at ONE event, until it ends
--   Rows are never deleted; removing a member sets removed_at. One active row per (host, member) and per (event, member).
--   idx_tickets_event_checkin   serves the door guest list and the checked in count (partial: checked in tickets only)
--
-- Rollback (nothing else depends on these tables):
--   DROP INDEX IF EXISTS idx_tickets_event_checkin;
--   DROP TABLE IF EXISTS event_door_members;
--   DROP TABLE IF EXISTS event_door_team;

CREATE TABLE IF NOT EXISTS event_door_team (
  id                VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id      VARCHAR(36) NOT NULL REFERENCES users(id),
  member_user_id    VARCHAR(36) NOT NULL REFERENCES users(id),
  added_by_user_id  VARCHAR(36) NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at        TIMESTAMPTZ,
  CONSTRAINT event_door_team_not_self CHECK (host_user_id <> member_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_door_team_active ON event_door_team (host_user_id, member_user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_door_team_member ON event_door_team (member_user_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS event_door_members (
  id                VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          VARCHAR(36) NOT NULL REFERENCES events(id),
  member_user_id    VARCHAR(36) NOT NULL REFERENCES users(id),
  added_by_user_id  VARCHAR(36) NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_door_members_active ON event_door_members (event_id, member_user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_door_members_member ON event_door_members (member_user_id) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_event_checkin ON tickets (event_id) WHERE checked_in_at IS NOT NULL;
