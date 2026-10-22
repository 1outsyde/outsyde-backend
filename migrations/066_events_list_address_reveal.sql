-- Migration 066: public event list + day-of address reveal
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one widened CHECK, two new nullable columns, two new indexes.
--
--   events.address_visibility   now also accepts 'ticket_holders_day_of' (address shown to ticket holders
--                               from 9 AM local on the event day, or 6 hours before the start if earlier)
--   tickets.address_reveal_notified_at   when the "address is now available" message was sent to the holder
--   tickets.address_reveal_emailed_at    set on one ticket per holder whose reveal EMAIL was sent; counts the daily reveal email budget
--                               (REVEAL_EMAIL_DAILY_CAP, default 40, per UTC day: Resend's plan allows 100 emails a day)
--   idx_events_list             serves the public event list (status, visibility, ends_at)
--   idx_events_public_starts    serves the public list's ordering by start time (partial: published public events only)
--
-- Rollback (only after no event uses 'ticket_holders_day_of'; set those to 'ticket_holders' first):
--   DROP INDEX IF EXISTS idx_events_public_starts;
--   DROP INDEX IF EXISTS idx_events_list;
--   ALTER TABLE tickets DROP COLUMN IF EXISTS address_reveal_emailed_at;
--   ALTER TABLE tickets DROP COLUMN IF EXISTS address_reveal_notified_at;
--   ALTER TABLE events DROP CONSTRAINT IF EXISTS events_address_visibility_check;
--   ALTER TABLE events ADD CONSTRAINT events_address_visibility_check CHECK (address_visibility IN ('public','ticket_holders'));

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_address_visibility_check;
ALTER TABLE events ADD CONSTRAINT events_address_visibility_check
  CHECK (address_visibility IN ('public','ticket_holders','ticket_holders_day_of'));

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS address_reveal_notified_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS address_reveal_emailed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_list ON events (status, visibility, ends_at);
CREATE INDEX IF NOT EXISTS idx_events_public_starts ON events (starts_at, id) WHERE status = 'published' AND visibility = 'public';
