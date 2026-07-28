-- Migration 023: add cta_config column to businesses and photographers
-- Stores the floating CTA button configuration set by vendors/photographers
-- on their profile screens in the OutsydeCapture mobile app.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS cta_config JSONB DEFAULT NULL;

ALTER TABLE photographers
  ADD COLUMN IF NOT EXISTS cta_config JSONB DEFAULT NULL;
