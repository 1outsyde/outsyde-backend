-- Migration 040: Service Add-ons + Customer Booking Details
-- Run manually in Neon SQL editor BEFORE merging this PR.
-- All statements use IF NOT EXISTS / exception handling — safe to re-run.

-- ── 1. service_addons table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_addons (
  id            VARCHAR(36)  PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    VARCHAR(36)  NOT NULL REFERENCES vendor_services(id) ON DELETE CASCADE,
  name          TEXT         NOT NULL,
  description   TEXT,
  price_cents   INTEGER      NOT NULL DEFAULT 0
                             CONSTRAINT service_addons_price_check CHECK (price_cents >= 0 AND price_cents <= 100000),
  duration_minutes INTEGER   NOT NULL DEFAULT 0
                             CONSTRAINT service_addons_duration_check CHECK (duration_minutes >= 0 AND duration_minutes <= 480),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Add description column in case the table was created before this column was added (re-run safety)
ALTER TABLE service_addons ADD COLUMN IF NOT EXISTS description TEXT;

-- Add constraints idempotently (skip if they already exist)
DO $$ BEGIN
  ALTER TABLE service_addons
    ADD CONSTRAINT service_addons_desc_check CHECK (description IS NULL OR length(description) <= 300);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE service_addons
    ADD CONSTRAINT service_addons_price_check CHECK (price_cents >= 0 AND price_cents <= 100000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE service_addons
    ADD CONSTRAINT service_addons_duration_check CHECK (duration_minutes >= 0 AND duration_minutes <= 480);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_service_addons_service ON service_addons(service_id, is_active, sort_order, name);

-- ── 2. booking_holds: 4 new columns ────────────────────────────────────────
ALTER TABLE booking_holds
  ADD COLUMN IF NOT EXISTS addons              JSONB    DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS addons_total_cents  INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS addons_duration_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_details    TEXT     DEFAULT NULL;

-- ── 3. appointments: 4 new columns ─────────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS addons              JSONB    DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS addons_total_cents  INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS addons_duration_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_details    TEXT     DEFAULT NULL;
