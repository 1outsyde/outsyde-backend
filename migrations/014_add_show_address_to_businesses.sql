-- Migration 014: add show_address column to businesses
-- Controls whether the business's full street address is shown publicly on their storefront.
-- Defaults to TRUE so existing businesses continue displaying their address with no visible change.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS show_address BOOLEAN DEFAULT TRUE;
