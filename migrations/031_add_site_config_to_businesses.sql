-- Migration 031: add site_config column to businesses
-- Stores vendor-site-only media config (stylist photo, gallery photos)
-- that is managed through the whitelabel dashboard and displayed
-- on the vendor's standalone site. Not surfaced in the mobile app.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS site_config JSONB DEFAULT NULL;
