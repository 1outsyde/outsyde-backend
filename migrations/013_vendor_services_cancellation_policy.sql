-- Migration 013: vendor_services + businesses cancellation policy columns — per-service
-- refund windows, partial refund settings, and cancellation fee configuration.
-- businesses columns serve as the "apply to all services" template default.
-- All columns nullable (or boolean with default false) so existing rows are unaffected.

ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS full_refund_window TEXT DEFAULT 'never';
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS has_partial_refund BOOLEAN DEFAULT FALSE;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS partial_refund_window TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS partial_refund_percentage INTEGER;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS has_cancellation_fee BOOLEAN DEFAULT FALSE;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS cancellation_fee_type TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS cancellation_fee_amount INTEGER;

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS full_refund_window TEXT DEFAULT 'never';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS has_partial_refund BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS partial_refund_window TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS partial_refund_percentage INTEGER;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS has_cancellation_fee BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cancellation_fee_type TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cancellation_fee_amount INTEGER;
