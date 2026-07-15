-- Migration 018: add location-type + cancellation-policy + photographer-level defaults
-- Mirrors the exact field set already on vendor_services / businesses onto
-- photographer_services / photographers, so the photographer booking rebuild
-- can reuse the same Review & Confirm UI logic used for the business side.

-- Per-service location type (mirrors vendor_services)
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS service_location_type TEXT DEFAULT 'business';
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS alternate_address TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS alternate_city TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS alternate_state TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS alternate_zip_code TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS virtual_link TEXT;

-- Per-service cancellation policy (mirrors vendor_services)
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS full_refund_window TEXT DEFAULT 'never';
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS has_partial_refund BOOLEAN DEFAULT false;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS partial_refund_window TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS partial_refund_percentage INTEGER;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS has_cancellation_fee BOOLEAN DEFAULT false;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS cancellation_fee_type TEXT;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS cancellation_fee_amount INTEGER;

-- Photographer-level defaults (mirrors businesses)
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS default_service_location_type TEXT DEFAULT 'business';
ALTER TABLE photographers ADD COLUMN IF NOT EXISTS vendor_terms_and_conditions TEXT;
