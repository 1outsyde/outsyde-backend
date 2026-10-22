-- Migration 066: public event list + day-of address reveal
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive: one widened CHECK, one new nullable column, one new index.
--
--   events.address_visibility   now also accepts 'ticket_holders_day_of' (address shown to ticket holders
--                               from 9 AM local on the event day, or 6 hours before the start if earlier)
--   tickets.address_reveal_notified_at   when the "address is now available" message was sent to the holder
--   idx_events_list             serves the public event list (status, visibility, ends_at)
--
-- Rollback (only after no event uses 'ticket_holders_day_of'; set those to 'ticket_holders' first):
--   DROP INDEX IF EXISTS idx_events_list;
--   ALTER TABLE tickets DROP COLUMN IF EXISTS address_reveal_notified_at;
--   ALTER TABLE events DROP CONSTRAINT IF EXISTS events_address_visibility_check;
--   ALTER TABLE events ADD CONSTRAINT events_address_visibility_check CHECK (address_visibility IN ('public','ticket_holders'));

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_address_visibility_check;
ALTER TABLE events ADD CONSTRAINT events_address_visibility_check
  CHECK (address_visibility IN ('public','ticket_holders','ticket_holders_day_of'));

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS address_reveal_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_list ON events (status, visibility, ends_at);
