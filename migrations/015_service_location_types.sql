-- Migration 015: add service location type columns
-- Adds per-service location type to vendor_services, a default on businesses,
-- and customer-provided address fields to appointments.
-- Existing services default to 'business' (no behaviour change).

-- Per-service location type: 'business' | 'alternate' | 'customer'
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS service_location_type TEXT DEFAULT 'business';
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS alternate_address TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS alternate_city TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS alternate_state TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS alternate_zip_code TEXT;

-- Business-level default location type (used when service has no override)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS default_service_location_type TEXT DEFAULT 'business';

-- Customer-provided address on confirmed appointments (populated when service_location_type = 'customer')
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS customer_service_address TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS customer_service_city TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS customer_service_state TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS customer_service_zip_code TEXT;
