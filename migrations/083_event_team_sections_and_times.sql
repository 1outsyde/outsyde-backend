-- Migration 083: Event team sections and times (p4-team step 2, 2026-10-29).
--
-- 1. Widens the role check on event_door_team and event_door_members (075) to every Event team section:
--      door (Admissions), security, host (Promoter), entertainment, media, cohost, other.
-- 2. role_label: the name the host types for an "other" role (Bartender, Coat check). Required for other, NULL for
--    every other role. 1 to 40 characters.
-- 3. event_team_schedules: per event, per person, per role times and notes. All optional, for every role. One row per
--    (event, member, role). Standing members get their times per event here (their invite row has no event).
--
-- Run in Neon by Claude BEFORE the step 2 PR merges. Old code never writes the new values and never reads the new
-- column or table. New code needs all three (a new role would answer 500 without the wider check).
-- Idempotent: safe to re-run. Additive: no row changes (every existing row is door with no label). Never via drizzle-kit push.
--
-- Rollback (only while no row uses a new role or a label, and no new code is live):
--   DROP TABLE IF EXISTS event_team_schedules;
--   ALTER TABLE event_door_team    DROP CONSTRAINT IF EXISTS event_door_team_role_label_check, DROP COLUMN IF EXISTS role_label;
--   ALTER TABLE event_door_members DROP CONSTRAINT IF EXISTS event_door_members_role_label_check, DROP COLUMN IF EXISTS role_label;
--   then re-add each <table>_role_check with ('door','security','host').

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_door_team', 'event_door_members'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_role_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (role IN (%L, %L, %L, %L, %L, %L, %L))',
      t, t || '_role_check', 'door', 'security', 'host', 'entertainment', 'media', 'cohost', 'other');
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS role_label TEXT', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t) AND conname = t || '_role_label_check') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((role = %L) = (role_label IS NOT NULL) AND (role_label IS NULL OR char_length(role_label) BETWEEN 1 AND 40))',
        t, t || '_role_label_check', 'other');
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS event_team_schedules (
  id                  VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            VARCHAR(36) NOT NULL REFERENCES events(id),
  member_user_id      VARCHAR(36) NOT NULL REFERENCES users(id),
  role                TEXT NOT NULL CHECK (role IN ('door', 'security', 'host', 'entertainment', 'media', 'cohost', 'other')),
  starts_at           TIMESTAMPTZ,          -- shift start / set start
  ends_at             TIMESTAMPTZ,          -- shift end / set end
  call_at             TIMESTAMPTZ,          -- when to show up
  load_in_at          TIMESTAMPTZ,          -- load in (Entertainment, Media)
  place_note          TEXT CHECK (place_note IS NULL OR char_length(place_note) <= 300),  -- where to go
  host_note           TEXT CHECK (host_note IS NULL OR char_length(host_note) <= 500),    -- "From the host"
  updated_by_user_id  VARCHAR(36) NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_team_schedules_order CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_team_schedules ON event_team_schedules (event_id, member_user_id, role);
