-- Migration 019: staff_services table + appointment service snapshots
-- Phase 1 of staff-owned-services redesign.
--
-- 1. Creates staff_services — staff members create and own their own bookable services
--    (price, duration, cancellation policy), analogous to photographer_services.
-- 2. Adds a staffServiceId FK column to appointments so staff-service bookings can
--    reference their own table instead of vendor_services.
-- 3. Relaxes appointments.serviceId from NOT NULL to nullable — required because a
--    staff-service booking populates staffServiceId and leaves serviceId null.
-- 4. Adds service snapshot columns to appointments so historical records survive
--    service edits, archival, or deletion (applies to all bookings, not just staff ones).
--
-- booking_holds is unchanged: it already stores serviceName / servicePriceCents /
-- durationMinutes as NOT NULL snapshot columns (added at table creation), and its
-- serviceId column carries no FK constraint, so it can already hold staff_services IDs.
--
-- No data backfill is included. Snapshot columns are nullable; existing rows start
-- empty and only new bookings going forward populate them (Phase 2 work).

-- ── 1. Create staff_services ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_services (
  id                         VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_member_id            VARCHAR(36) NOT NULL REFERENCES staff_members(id),
  -- Denormalized for hot-path queries (derivable via staff_member_id → staff_members.business_id)
  business_id                VARCHAR(36) NOT NULL REFERENCES businesses(id),

  name                       TEXT        NOT NULL,
  description                TEXT,
  category                   TEXT,

  -- Flat-rate fixed-duration pricing only (no hourly/package model)
  price_cents                INTEGER     NOT NULL,
  duration_minutes           INTEGER     NOT NULL,

  is_active                  BOOLEAN     DEFAULT true,

  -- Publishing status: 'draft' | 'live' | 'archived'
  status                     TEXT        NOT NULL DEFAULT 'draft',

  -- Connected account Stripe IDs (staff own their Connect accounts)
  stripe_connected_product_id TEXT,
  stripe_connected_price_id   TEXT,

  -- Service location type: 'business' | 'alternate' | 'customer' | 'virtual'
  service_location_type      TEXT        DEFAULT 'business',
  alternate_address          TEXT,
  alternate_city             TEXT,
  alternate_state            TEXT,
  alternate_zip_code         TEXT,
  virtual_link               TEXT,

  -- Cancellation policy (mirrors vendor_services / photographer_services)
  full_refund_window         TEXT        DEFAULT 'never',  -- '1_week'|'48_hours'|'24_hours'|'1_hour'|'never'
  has_partial_refund         BOOLEAN     DEFAULT false,
  partial_refund_window      TEXT,                         -- nullable, same 5 values
  partial_refund_percentage  INTEGER,                      -- nullable, 0-100
  has_cancellation_fee       BOOLEAN     DEFAULT false,
  cancellation_fee_type      TEXT,                         -- nullable, 'flat'|'percentage'
  cancellation_fee_amount    INTEGER,                      -- nullable, cents if flat / whole pct if percentage

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index: look up all services for a given staff member (staff dashboard, booking flow)
CREATE INDEX IF NOT EXISTS idx_staff_services_staff_member
  ON staff_services (staff_member_id);

-- Index: look up all staff services under a business (business oversight / public listing)
CREATE INDEX IF NOT EXISTS idx_staff_services_business
  ON staff_services (business_id);

-- Index: filter by status (live services for public booking, draft/archived for management)
CREATE INDEX IF NOT EXISTS idx_staff_services_status
  ON staff_services (staff_member_id, status);


-- ── 2. appointments: add staffServiceId FK ─────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS staff_service_id VARCHAR(36) REFERENCES staff_services(id);

-- ── 3. appointments: relax serviceId to nullable ───────────────────────────────
-- Previously NOT NULL; null when the booking is for a staff-owned service instead.
ALTER TABLE appointments
  ALTER COLUMN service_id DROP NOT NULL;

-- ── 4. appointments: add service snapshot columns ──────────────────────────────
-- Captured at booking-creation time so historical records remain correct even if
-- the service is later edited, archived, or deleted.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_name                    TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_price_cents             INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_duration_minutes        INTEGER;
-- Cancellation policy snapshot
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_full_refund_window      TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_has_partial_refund      BOOLEAN;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_partial_refund_window   TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_partial_refund_percentage INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_has_cancellation_fee    BOOLEAN;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_cancellation_fee_type   TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_cancellation_fee_amount INTEGER;
