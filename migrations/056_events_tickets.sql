-- Migration 056: events and tickets (Events & Ticketing, Phase 1)
-- Tables applied in Neon on 2026-10-18 (as "053", before main took 053-055); the tax/discount ALTERs at the
-- end applied the same day. Re-running the whole file is a no-op.
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: six new tables, no existing table or row touched.
--
-- Rules the database enforces (neon-http has no transactions, so these are the race-breakers):
--   * No overselling: events.reserved_count <= capacity and ticket_types.reserved_count <= quantity.
--     A claim bumps both counters in ONE statement; if either CHECK fails, nothing is saved.
--   * Per-account limit: ticket_account_counts.count <= max_count (limit copied from the ticket type).
--   * Money lines add up on every order and every ticket (CHECKs below; tax + discount added at the end).
--   * Fees are saved per ticket at sale (decision 2026-10-18): price, 8% service fee, $0.99 per paid
--     ticket, 2% platform fee. The host is paid once per event, 3 days after it ends (Phase 2).
--
-- Status values
--   events.status              'draft' | 'published' | 'paused' (admin) | 'cancelled'
--   ticket_types.status        'active' | 'archived' (types with sales are never deleted)
--   ticket_orders.status       'pending' (held, waiting for payment) | 'completed' | 'expired'
--                              | 'cancelled' | 'refunded'
--   ticket_order_items.status  'held' | 'issued' | 'released' | 'expired'
--   tickets.status             'valid' | 'cancelled' | 'refunded'

CREATE TABLE IF NOT EXISTS events (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id          VARCHAR(36) NOT NULL REFERENCES users(id),
  host_type             TEXT        NOT NULL DEFAULT 'user' CHECK (host_type IN ('user', 'business', 'photographer')),
  host_business_id      VARCHAR(36) REFERENCES businesses(id),
  host_photographer_id  VARCHAR(36) REFERENCES photographers(id),
  slug                  TEXT        NOT NULL,
  title                 TEXT        NOT NULL CHECK (length(btrim(title)) > 0),
  description           TEXT,
  cover_image_url       TEXT,
  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ NOT NULL,
  timezone              TEXT        NOT NULL,
  venue_name            TEXT,
  address_line1         TEXT,
  address_line2         TEXT,
  city                  TEXT,
  state                 TEXT,
  postal_code           TEXT,
  latitude              DOUBLE PRECISION,
  longitude             DOUBLE PRECISION,
  address_visibility    TEXT        NOT NULL DEFAULT 'ticket_holders' CHECK (address_visibility IN ('public', 'ticket_holders')),
  visibility            TEXT        NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
  capacity              INTEGER     CHECK (capacity IS NULL OR capacity > 0),
  reserved_count        INTEGER     NOT NULL DEFAULT 0,
  refund_policy         TEXT        NOT NULL DEFAULT 'no_refunds' CHECK (refund_policy IN ('no_refunds', 'until_cutoff')),
  refund_cutoff_hours   INTEGER     CHECK (refund_cutoff_hours IS NULL OR refund_cutoff_hours >= 0),
  status                TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'cancelled')),
  published_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancel_reason         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT events_ends_after_starts CHECK (ends_at > starts_at),
  CONSTRAINT events_capacity_not_exceeded CHECK (reserved_count >= 0 AND (capacity IS NULL OR reserved_count <= capacity)),
  CONSTRAINT events_host_profile_matches CHECK (
    (host_type = 'user'         AND host_business_id IS NULL     AND host_photographer_id IS NULL) OR
    (host_type = 'business'     AND host_business_id IS NOT NULL AND host_photographer_id IS NULL) OR
    (host_type = 'photographer' AND host_photographer_id IS NOT NULL AND host_business_id IS NULL)
  ),
  CONSTRAINT events_refund_cutoff_set CHECK (refund_policy = 'no_refunds' OR refund_cutoff_hours IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_events_slug ON events (slug);
CREATE INDEX IF NOT EXISTS idx_events_host_user ON events (host_user_id);
CREATE INDEX IF NOT EXISTS idx_events_published_starts ON events (starts_at) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS ticket_types (
  id                           VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                     VARCHAR(36) NOT NULL REFERENCES events(id),
  name                         TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  description                  TEXT,
  price_cents                  INTEGER     NOT NULL CHECK (price_cents = 0 OR price_cents >= 100),
  quantity                     INTEGER     NOT NULL CHECK (quantity > 0),
  reserved_count               INTEGER     NOT NULL DEFAULT 0,
  sales_start_at               TIMESTAMPTZ,
  sales_end_at                 TIMESTAMPTZ,
  unlock_after_ticket_type_id  VARCHAR(36) REFERENCES ticket_types(id),
  min_per_order                INTEGER     NOT NULL DEFAULT 1 CHECK (min_per_order >= 1),
  max_per_order                INTEGER     NOT NULL DEFAULT 10,
  per_account_limit            INTEGER     CHECK (per_account_limit IS NULL OR per_account_limit >= 1),
  hidden                       BOOLEAN     NOT NULL DEFAULT false,
  sort_order                   INTEGER     NOT NULL DEFAULT 0,
  status                       TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_types_quantity_not_exceeded CHECK (reserved_count >= 0 AND reserved_count <= quantity),
  CONSTRAINT ticket_types_order_limits CHECK (max_per_order >= min_per_order),
  CONSTRAINT ticket_types_sales_window CHECK (sales_start_at IS NULL OR sales_end_at IS NULL OR sales_end_at > sales_start_at),
  CONSTRAINT ticket_types_not_self_unlock CHECK (unlock_after_ticket_type_id IS NULL OR unlock_after_ticket_type_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON ticket_types (event_id);

CREATE TABLE IF NOT EXISTS ticket_orders (
  id                        VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                  VARCHAR(36) NOT NULL REFERENCES events(id),
  buyer_user_id             VARCHAR(36) NOT NULL REFERENCES users(id),
  status                    TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired', 'cancelled', 'refunded')),
  ticket_count              INTEGER     NOT NULL CHECK (ticket_count > 0),
  subtotal_cents            INTEGER     NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  service_fee_cents         INTEGER     NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
  per_ticket_fee_cents      INTEGER     NOT NULL DEFAULT 0 CHECK (per_ticket_fee_cents >= 0),
  platform_fee_cents        INTEGER     NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  host_net_cents            INTEGER     NOT NULL DEFAULT 0 CHECK (host_net_cents >= 0),
  total_cents               INTEGER     NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  refunded_cents            INTEGER     NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  fee_model_version         TEXT,
  stripe_payment_intent_id  TEXT,
  idempotency_key           TEXT,
  expires_at                TIMESTAMPTZ,
  paid_at                   TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_orders_total_adds_up CHECK (total_cents = subtotal_cents + service_fee_cents + per_ticket_fee_cents),
  CONSTRAINT ticket_orders_host_net_adds_up CHECK (host_net_cents = subtotal_cents - platform_fee_cents),
  CONSTRAINT ticket_orders_refund_capped CHECK (refunded_cents <= total_cents)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_orders_payment_intent ON ticket_orders (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_orders_idempotency ON ticket_orders (buyer_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ticket_orders_event ON ticket_orders (event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_buyer ON ticket_orders (buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_pending ON ticket_orders (expires_at) WHERE status = 'pending';

-- One row per ticket type in an order. While status = 'held' it is the 10 minute checkout hold.
CREATE TABLE IF NOT EXISTS ticket_order_items (
  id                    VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              VARCHAR(36) NOT NULL REFERENCES ticket_orders(id),
  event_id              VARCHAR(36) NOT NULL REFERENCES events(id),
  ticket_type_id        VARCHAR(36) NOT NULL REFERENCES ticket_types(id),
  buyer_user_id         VARCHAR(36) NOT NULL REFERENCES users(id),
  quantity              INTEGER     NOT NULL CHECK (quantity > 0),
  unit_price_cents      INTEGER     NOT NULL CHECK (unit_price_cents >= 0),
  status                TEXT        NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'issued', 'released', 'expired')),
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_order_items_type ON ticket_order_items (order_id, ticket_type_id);
CREATE INDEX IF NOT EXISTS idx_ticket_order_items_held ON ticket_order_items (expires_at) WHERE status = 'held';

-- Per-account limit. max_count is copied from ticket_types.per_account_limit (NULL = no limit).
CREATE TABLE IF NOT EXISTS ticket_account_counts (
  ticket_type_id  VARCHAR(36) NOT NULL REFERENCES ticket_types(id),
  user_id         VARCHAR(36) NOT NULL REFERENCES users(id),
  count           INTEGER     NOT NULL DEFAULT 0,
  max_count       INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_type_id, user_id),
  CONSTRAINT ticket_account_counts_limit CHECK (count >= 0 AND (max_count IS NULL OR count <= max_count))
);

-- One row per guest. Fees saved per ticket at sale.
CREATE TABLE IF NOT EXISTS tickets (
  id                       VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 VARCHAR(36) NOT NULL REFERENCES ticket_orders(id),
  order_item_id            VARCHAR(36) NOT NULL REFERENCES ticket_order_items(id),
  event_id                 VARCHAR(36) NOT NULL REFERENCES events(id),
  ticket_type_id           VARCHAR(36) NOT NULL REFERENCES ticket_types(id),
  holder_user_id           VARCHAR(36) NOT NULL REFERENCES users(id),
  item_index               INTEGER     NOT NULL CHECK (item_index >= 1),
  code                     TEXT        NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'cancelled', 'refunded')),
  price_cents              INTEGER     NOT NULL CHECK (price_cents >= 0),
  service_fee_cents        INTEGER     NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
  per_ticket_fee_cents     INTEGER     NOT NULL DEFAULT 0 CHECK (per_ticket_fee_cents >= 0),
  platform_fee_cents       INTEGER     NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  host_net_cents           INTEGER     NOT NULL DEFAULT 0 CHECK (host_net_cents >= 0),
  checked_in_at            TIMESTAMPTZ,
  checked_in_by_user_id    VARCHAR(36) REFERENCES users(id),
  cancelled_at             TIMESTAMPTZ,
  refunded_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tickets_host_net_adds_up CHECK (host_net_cents = price_cents - platform_fee_cents),
  CONSTRAINT tickets_free_has_no_fees CHECK (price_cents > 0 OR (service_fee_cents = 0 AND per_ticket_fee_cents = 0 AND platform_fee_cents = 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_code ON tickets (code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_item_index ON tickets (order_item_id, item_index);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets (event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_holder ON tickets (holder_user_id);

-- Room for sales tax and discounts (added 2026-10-18 before any order exists; written as ALTERs so this
-- file converges both on a fresh database and on Neon, where the tables above were created earlier).
--   buyer total = subtotal + service fee + per-ticket fee + tax - discount
--   host net    = subtotal - platform fee  (a discount is covered by Outsyde, never taken from the host)
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS tax_cents      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticket_orders DROP CONSTRAINT IF EXISTS ticket_orders_total_adds_up;
ALTER TABLE ticket_orders DROP CONSTRAINT IF EXISTS ticket_orders_tax_discount_valid;
ALTER TABLE ticket_orders ADD CONSTRAINT ticket_orders_tax_discount_valid CHECK (tax_cents >= 0 AND discount_cents >= 0);
ALTER TABLE ticket_orders ADD CONSTRAINT ticket_orders_total_adds_up
  CHECK (total_cents = subtotal_cents + service_fee_cents + per_ticket_fee_cents + tax_cents - discount_cents);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tax_cents      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_tax_discount_valid;
ALTER TABLE tickets ADD CONSTRAINT tickets_tax_discount_valid CHECK (tax_cents >= 0 AND discount_cents >= 0);

-- Verify (read-only): expect 6 tables, each with 0 rows.
-- SELECT 'events' t, count(*) FROM events UNION ALL SELECT 'ticket_types', count(*) FROM ticket_types
-- UNION ALL SELECT 'ticket_orders', count(*) FROM ticket_orders UNION ALL SELECT 'ticket_order_items', count(*) FROM ticket_order_items
-- UNION ALL SELECT 'ticket_account_counts', count(*) FROM ticket_account_counts UNION ALL SELECT 'tickets', count(*) FROM tickets;
