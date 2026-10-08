-- Migration 040: Service Add-ons + Customer Booking Details
-- Run manually in Neon SQL editor BEFORE merging this PR.
-- All statements use IF NOT EXISTS / IF NOT EXISTS patterns — safe to re-run.

-- ── 1. service_addons table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_addons (
  id            VARCHAR(36)  PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    VARCHAR(36)  NOT NULL REFERENCES vendor_services(id) ON DELETE CASCADE,
  name          TEXT         NOT NULL,
  price_cents   INTEGER      NOT NULL DEFAULT 0,
  duration_minutes INTEGER   NOT NULL DEFAULT 0,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

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
