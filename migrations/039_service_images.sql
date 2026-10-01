-- Migration 039: one optional image per staff service and per photographer service
-- Same rule as vendor_services.image_url. NULL means no image.
-- No statement may contain a semicolon: scripts/migrate.ts splits on it.

ALTER TABLE staff_services ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS image_url text;
