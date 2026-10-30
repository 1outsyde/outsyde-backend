-- p4-team step 3: personal promoter links + sales tracking.
--
-- One link per promoter per event. Standing promoters (event_door_team, keyed by host) get their own link for
-- each event, so the link can't live on either team table. A sale counts for the link the buyer checked out
-- through (last link opened wins on goutsyde.com). Decided by Legend 2026-10-30:
--   - a promoter buying through their own link doesn't count
--   - a removed promoter's link stops counting new sales; past sales stay theirs
--   - free RSVPs through a link are shown to the promoter apart from paid tickets
--   - host and co-hosts see a per promoter breakdown
--   - links for promoters (role 'host') only, for now
-- Whether a link still counts is checked live against the team tables, so there is no disabled flag here:
-- removing a promoter stops new sales at once, adding them back starts them again with the same link.
--
-- Safe to run twice. New table + one nullable column with no default: today's code never reads or writes them.

CREATE TABLE IF NOT EXISTS event_promoter_links (
  id                VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          VARCHAR(36) NOT NULL REFERENCES events(id),
  promoter_user_id  VARCHAR(36) NOT NULL REFERENCES users(id),
  code              TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_promoter_links_code_format CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_promoter_links_event_promoter ON event_promoter_links (event_id, promoter_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_promoter_links_code ON event_promoter_links (code);

ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS promoter_link_id VARCHAR(36) REFERENCES event_promoter_links(id);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_promoter_link ON ticket_orders (promoter_link_id) WHERE promoter_link_id IS NOT NULL;

-- Verify (read-only): expect the table with 5 columns, 2 unique indexes, the new ticket_orders column, 0 rows.
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'event_promoter_links' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename IN ('event_promoter_links', 'ticket_orders') AND indexname LIKE '%promoter%';
-- SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'ticket_orders' AND column_name = 'promoter_link_id';
