-- Migration 075: door team invites (Events p4-scanner)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: new nullable or defaulted columns and checks on the two 067 door tables.
--
-- Adding someone to a door team now sends an invite. They can scan only after accepting.
--   invited_at          when the latest invite went out (an "invite again" after a decline resets it)
--   accepted_at         set when the invitee accepts; access needs it (doorAccess.ts, GET /door/mine)
--   declined_at         set when the invitee says no; the row stays so the host sees "Said no" and can invite again
--   removed_by_user_id  who set removed_at: the host (remove, cancel invite) or the member (leave)
--   invite_emailed_at   last invite email for this row (at most one a day per row)
--   role                door, security or host (p4-team). Only 'door' is written until p4-team ships.
--
-- Rows that existed before this migration were added directly (no consent step), so they are backfilled as
-- accepted, ONLY in the same step that adds accepted_at. A re-run never accepts a pending invite.
-- Production on 2026-10-28: 0 rows in both tables, so the backfill touches nothing there.
--
-- Rollback (nothing else depends on these columns; the 2026-10-28 app and web code needs them):
--   ALTER TABLE event_door_team    DROP CONSTRAINT IF EXISTS event_door_team_role_check, DROP CONSTRAINT IF EXISTS event_door_team_answer_check,
--     DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS invite_emailed_at, DROP COLUMN IF EXISTS removed_by_user_id,
--     DROP COLUMN IF EXISTS declined_at, DROP COLUMN IF EXISTS accepted_at, DROP COLUMN IF EXISTS invited_at;
--   ALTER TABLE event_door_members DROP CONSTRAINT IF EXISTS event_door_members_role_check, DROP CONSTRAINT IF EXISTS event_door_members_answer_check,
--     DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS invite_emailed_at, DROP COLUMN IF EXISTS removed_by_user_id,
--     DROP COLUMN IF EXISTS declined_at, DROP COLUMN IF EXISTS accepted_at, DROP COLUMN IF EXISTS invited_at;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_door_team', 'event_door_members'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = t AND column_name = 'accepted_at') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN accepted_at TIMESTAMPTZ', t);
      EXECUTE format('UPDATE %I SET accepted_at = created_at WHERE accepted_at IS NULL', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ NOT NULL DEFAULT now()', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS removed_by_user_id VARCHAR(36) REFERENCES users(id)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS invite_emailed_at TIMESTAMPTZ', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT %L', t, 'door');
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t) AND conname = t || '_role_check') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (role IN (%L, %L, %L))', t, t || '_role_check', 'door', 'security', 'host');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t) AND conname = t || '_answer_check') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (NOT (accepted_at IS NOT NULL AND declined_at IS NOT NULL))', t, t || '_answer_check');
    END IF;
  END LOOP;
END $$;
