-- Migration 041: Photographer service add-ons + customer details on shoot bookings
-- Run manually in the Neon SQL editor BEFORE merging. Safe to re-run.

-- ── 1. photographer_service_addons table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS photographer_service_addons (
  id                       VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_service_id  VARCHAR(36) NOT NULL REFERENCES photographer_services(id) ON DELETE CASCADE,
  name                     TEXT        NOT NULL,
  description              TEXT,
  price_cents              INTEGER     NOT NULL DEFAULT 0,
  duration_minutes         INTEGER     NOT NULL DEFAULT 0,
  is_active                BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order               INTEGER     NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE photographer_service_addons
    ADD CONSTRAINT photographer_service_addons_price_check CHECK (price_cents >= 0 AND price_cents <= 100000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE photographer_service_addons
    ADD CONSTRAINT photographer_service_addons_duration_check CHECK (duration_minutes >= 0 AND duration_minutes <= 480);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE photographer_service_addons
    ADD CONSTRAINT photographer_service_addons_desc_check CHECK (description IS NULL OR length(description) <= 300);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_photographer_service_addons_service
  ON photographer_service_addons(photographer_service_id, is_active, sort_order, name);

-- ── 2. shoot_bookings: 4 new columns ────────────────────────────────────────
ALTER TABLE shoot_bookings
  ADD COLUMN IF NOT EXISTS addons                  JSONB   DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS addons_total_cents      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS addons_duration_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_details        TEXT    DEFAULT NULL;
