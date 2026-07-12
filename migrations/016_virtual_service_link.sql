-- Migration 016: add virtual_link column to vendor_services
-- Stores a meeting/session URL for services with serviceLocationType = 'virtual'.

ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS virtual_link TEXT;
