-- Migration 017: add vendor_terms_and_conditions column to businesses
-- Stores vendor-defined booking terms shown as a required checkbox to customers
-- at the Review step in BookingFlow. NULL = vendor has not set any terms.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS vendor_terms_and_conditions TEXT;
