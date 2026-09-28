-- Migration 034: per-service deposit on staff services
-- Mirrors vendor_services.deposit_amount_cents (added directly in Neon with
-- commit eb950cd, no migration file). NULL means no deposit. When set, the
-- customer pays the deposit at booking and the rest in person.
-- No statement may contain a semicolon: scripts/migrate.ts splits on it.

ALTER TABLE staff_services ADD COLUMN IF NOT EXISTS deposit_amount_cents integer;
