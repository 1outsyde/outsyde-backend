-- Migration 071: admin can resolve an owed host payout recovery (collected / written off)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: widens one CHECK (every existing row stays valid) and adds two nullable columns.
--
--   event_payout_recoveries.status       now also allows 'collected' (money got back outside Stripe) and
--                                        'written_off' (Outsyde absorbs it). Existing values unchanged.
--   event_payout_recoveries.resolved_at  when an admin resolved it (NULL until then)
--   event_payout_recoveries.resolved_by  the admin user who resolved it (NULL until then; set back to NULL if that user is deleted)
--
-- The old CHECK is found by definition, not by name: local databases call it event_payout_recoveries_status_valid,
-- but any CHECK on this table that mentions status (and is not already the widened one) is dropped first, so the widened one is the only status rule and a re-run changes nothing.
--
-- Rollback (only valid while no row is 'collected' or 'written_off'; old code never reads the new columns):
--   ALTER TABLE event_payout_recoveries DROP CONSTRAINT IF EXISTS event_payout_recoveries_status_valid;
--   ALTER TABLE event_payout_recoveries ADD CONSTRAINT event_payout_recoveries_status_valid
--     CHECK (status IN ('pending', 'reversed', 'owed', 'recovered'));
--   ALTER TABLE event_payout_recoveries DROP COLUMN IF EXISTS resolved_by, DROP COLUMN IF EXISTS resolved_at;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'event_payout_recoveries'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%written_off%'
  LOOP
    EXECUTE format('ALTER TABLE event_payout_recoveries DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'event_payout_recoveries'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  ) THEN
    ALTER TABLE event_payout_recoveries
      ADD CONSTRAINT event_payout_recoveries_status_valid
      CHECK (status IN ('pending', 'reversed', 'owed', 'recovered', 'collected', 'written_off'));
  END IF;
END $$;

ALTER TABLE event_payout_recoveries ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE event_payout_recoveries ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL;

-- A database that already ran an earlier copy of this file has resolved_by with a plain REFERENCES (no action on
-- delete, so deleting an admin user would fail). Swap that foreign key for ON DELETE SET NULL; a re-run finds it
-- already set and changes nothing.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'event_payout_recoveries'::regclass AND con.contype = 'f'
      AND a.attname = 'resolved_by' AND con.confdeltype <> 'n'
  LOOP
    EXECUTE format('ALTER TABLE event_payout_recoveries DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'event_payout_recoveries'::regclass AND con.contype = 'f' AND a.attname = 'resolved_by'
  ) THEN
    ALTER TABLE event_payout_recoveries
      ADD CONSTRAINT event_payout_recoveries_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
