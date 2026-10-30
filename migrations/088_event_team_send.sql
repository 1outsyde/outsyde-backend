-- p4-team step 4b-2: sending team pay. Decided by Legend 2026-10-30 (calls 20 to 23):
--   20 Sending is behind a pause only switch on Render (TEAM_PAYOUTS_ENABLED). Off: team pay is still worked out and
--      held on Stripe, never given to the host. No column needed.
--   21 Taking someone off the team: a reason (late, no show, unprofessional conduct, other with a short note) the
--      person is shown. Once the event is over its team is locked.
--   22 Payout setup is not needed to accept a team spot. Paid members without it get reminders until the payout is
--      worked out (3 days after the event). Not set up by then: their share goes to the host ('no_setup', the host
--      pays them directly) and they get one last message.
--   23 I paid them / Got it / Not yet: the host marks a member paid (undo until Got it), the member answers. A Not yet
--      still open after 3 days goes to the admin.
--
-- 1. event_team_payouts: outcome 'no_setup'; hold_reason (sending held: event paused, Stripe not ready);
--    member_notified_at (the one last message); member_not_yet_at; flagged_at (sent to the admin once).
--    Already there from 087: host_settled_at (I paid them), member_confirmed_at (Got it).
-- 2. event_door_members and event_door_team: removal_reason and removal_note.
-- 3. event_team_setup_notices: one row per event and member, when the setup reminders went out.
--
-- Safe to run twice. Old code keeps working with this in place: it never reads the new columns or table, and it only
-- writes outcomes 'covered' and 'not_covered', both still allowed. Production has 0 event_team_payouts rows today.
--
-- Rollback (nothing else depends on these):
--   DROP TABLE IF EXISTS event_team_setup_notices;
--   ALTER TABLE event_door_members DROP CONSTRAINT IF EXISTS event_door_members_removal_reason_check, DROP COLUMN IF EXISTS removal_reason, DROP COLUMN IF EXISTS removal_note;
--   ALTER TABLE event_door_team    DROP CONSTRAINT IF EXISTS event_door_team_removal_reason_check,    DROP COLUMN IF EXISTS removal_reason, DROP COLUMN IF EXISTS removal_note;
--   ALTER TABLE event_team_payouts DROP COLUMN IF EXISTS hold_reason, DROP COLUMN IF EXISTS member_notified_at,
--     DROP COLUMN IF EXISTS member_not_yet_at, DROP COLUMN IF EXISTS flagged_at;
--   (and put back event_team_payouts_outcome_valid with ('covered', 'not_covered') once no row says 'no_setup')

ALTER TABLE event_team_payouts ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE event_team_payouts ADD COLUMN IF NOT EXISTS member_notified_at TIMESTAMPTZ;
ALTER TABLE event_team_payouts ADD COLUMN IF NOT EXISTS member_not_yet_at TIMESTAMPTZ;
ALTER TABLE event_team_payouts ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
ALTER TABLE event_team_payouts DROP CONSTRAINT IF EXISTS event_team_payouts_outcome_valid;
ALTER TABLE event_team_payouts ADD CONSTRAINT event_team_payouts_outcome_valid CHECK (outcome IN ('covered', 'not_covered', 'no_setup'));
-- Got it needs I paid them first; only pay the host owes directly is settled this way.
ALTER TABLE event_team_payouts DROP CONSTRAINT IF EXISTS event_team_payouts_settle_order;
ALTER TABLE event_team_payouts ADD CONSTRAINT event_team_payouts_settle_order CHECK (
  (member_confirmed_at IS NULL OR host_settled_at IS NOT NULL)
  AND (member_not_yet_at IS NULL OR host_settled_at IS NOT NULL)
  AND (host_settled_at IS NULL OR status = 'host_to_pay'));
-- Not yet answers still open, for the admin flag.
CREATE INDEX IF NOT EXISTS idx_event_team_payouts_not_yet ON event_team_payouts (member_not_yet_at)
  WHERE member_not_yet_at IS NOT NULL AND member_confirmed_at IS NULL;

ALTER TABLE event_door_members ADD COLUMN IF NOT EXISTS removal_reason TEXT;
ALTER TABLE event_door_members ADD COLUMN IF NOT EXISTS removal_note TEXT;
ALTER TABLE event_door_members DROP CONSTRAINT IF EXISTS event_door_members_removal_reason_check;
ALTER TABLE event_door_members ADD CONSTRAINT event_door_members_removal_reason_check CHECK (
  (removal_reason IS NULL OR removal_reason IN ('late', 'no_show', 'unprofessional', 'other'))
  AND (removal_note IS NULL OR char_length(removal_note) <= 200)
  AND (removal_reason IS NULL OR removed_at IS NOT NULL));
ALTER TABLE event_door_team ADD COLUMN IF NOT EXISTS removal_reason TEXT;
ALTER TABLE event_door_team ADD COLUMN IF NOT EXISTS removal_note TEXT;
ALTER TABLE event_door_team DROP CONSTRAINT IF EXISTS event_door_team_removal_reason_check;
ALTER TABLE event_door_team ADD CONSTRAINT event_door_team_removal_reason_check CHECK (
  (removal_reason IS NULL OR removal_reason IN ('late', 'no_show', 'unprofessional', 'other'))
  AND (removal_note IS NULL OR char_length(removal_note) <= 200)
  AND (removal_reason IS NULL OR removed_at IS NOT NULL));

CREATE TABLE IF NOT EXISTS event_team_setup_notices (
  event_id            VARCHAR(36) NOT NULL REFERENCES events(id),
  member_user_id      VARCHAR(36) NOT NULL REFERENCES users(id),
  last_push_at        TIMESTAMPTZ,
  day_of_email_at     TIMESTAMPTZ,
  day_after_email_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, member_user_id)
);

-- Verify (read-only):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'event_team_payouts' AND column_name IN ('hold_reason', 'member_notified_at', 'member_not_yet_at', 'flagged_at');  -- 4
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'event_team_payouts'::regclass AND conname IN ('event_team_payouts_outcome_valid', 'event_team_payouts_settle_order');
-- SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('event_door_members', 'event_door_team') AND column_name LIKE 'removal_%' ORDER BY 1, 2;  -- 4
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'event_team_setup_notices';  -- 6
