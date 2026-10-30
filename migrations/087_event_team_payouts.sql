-- p4-team step 4b-1: team pay fixed 3 days after the event and taken from the host payout. Nothing is sent yet
-- (4b-2 sends one transfer per person). Decided by Legend 2026-10-30 (calls 1 to 18):
--   - order: what the host owes Outsyde first (may take the whole payout), then team pay, all or nothing against what
--     is left, then the host. The host payout can be $0 (recorded as paid, nothing sent).
--   - team = whoever was on it when the event ended. Free and uncovered events get team rows too ('host_to_pay').
--
-- 1. events.team_pay_fixed_at: set in the same statement that works the payout out, so the job visits each event once
--    (free events with team pay have no event_payouts row to mark that).
-- 2. event_payouts.team_cents and new checks: amount = gross - deducted - team, amount >= 0 (was > 0).
-- 3. event_team_payouts: one row per person per event with what they are owed. 'pending' = Outsyde pays it (4b-2),
--    'host_to_pay' = not covered, the host pays them directly. Destination, transfer and settle columns are for 4b-2.
-- 4. event_payout_recoveries.host_reminded_at: when the host was last reminded they owe it (every 7 days).
--
-- Safe to run twice. Production has 0 event payouts today, so the changed checks touch no row. Old code keeps working
-- with these columns in place (it never reads them, inserts leave team_cents at 0, and 0 still satisfies the checks).

ALTER TABLE events ADD COLUMN IF NOT EXISTS team_pay_fixed_at TIMESTAMPTZ;

ALTER TABLE event_payouts ADD COLUMN IF NOT EXISTS team_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_payouts DROP CONSTRAINT IF EXISTS event_payouts_amount_positive;
ALTER TABLE event_payouts DROP CONSTRAINT IF EXISTS event_payouts_amount_matches;
ALTER TABLE event_payouts DROP CONSTRAINT IF EXISTS event_payouts_amount_nonneg;
ALTER TABLE event_payouts DROP CONSTRAINT IF EXISTS event_payouts_team_valid;
ALTER TABLE event_payouts ADD CONSTRAINT event_payouts_amount_nonneg CHECK (amount_cents >= 0);
ALTER TABLE event_payouts ADD CONSTRAINT event_payouts_team_valid CHECK (team_cents >= 0);
ALTER TABLE event_payouts ADD CONSTRAINT event_payouts_amount_matches CHECK (amount_cents = gross_cents - deducted_cents - team_cents);

CREATE TABLE IF NOT EXISTS event_team_payouts (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              VARCHAR(36) NOT NULL REFERENCES events(id),
  member_user_id        VARCHAR(36) NOT NULL REFERENCES users(id),
  payout_id             VARCHAR(36) REFERENCES event_payouts(id),   -- NULL when the event earned nothing (no host payout)
  amount_cents          INTEGER     NOT NULL,
  breakdown             JSONB       NOT NULL,
  outcome               TEXT        NOT NULL,
  status                TEXT        NOT NULL,
  destination_type      TEXT,
  connected_account_id  TEXT,
  transfer_id           TEXT,
  attempts              INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ,
  last_error            TEXT,
  alerted_at            TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  host_settled_at       TIMESTAMPTZ,
  member_confirmed_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_team_payouts_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT event_team_payouts_outcome_valid CHECK (outcome IN ('covered', 'not_covered')),
  CONSTRAINT event_team_payouts_status_valid CHECK (status IN ('pending', 'paid', 'held', 'review', 'host_to_pay')),
  CONSTRAINT event_team_payouts_status_matches CHECK ((outcome = 'covered') = (status <> 'host_to_pay')),
  CONSTRAINT event_team_payouts_covered_has_payout CHECK (outcome <> 'covered' OR payout_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_team_payouts_member ON event_team_payouts (event_id, member_user_id);
CREATE INDEX IF NOT EXISTS idx_event_team_payouts_open ON event_team_payouts (next_attempt_at) WHERE status IN ('pending', 'held', 'review');

ALTER TABLE event_payout_recoveries ADD COLUMN IF NOT EXISTS host_reminded_at TIMESTAMPTZ;

-- Verify (read-only):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'team_pay_fixed_at';
-- SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'event_payouts' AND column_name = 'team_cents';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'event_payouts'::regclass ORDER BY conname;
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'event_team_payouts';  -- 20
-- SELECT conname FROM pg_constraint WHERE conrelid = 'event_team_payouts'::regclass ORDER BY conname;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'event_team_payouts';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'event_payout_recoveries' AND column_name = 'host_reminded_at';
