-- Migration 036: per-service deposit on photographer services and shoot bookings
-- NULL means no deposit. When set, the customer pays the deposit plus the
-- consumer fee at booking and the rest of the price in person. Only services
-- with a fixed price_cents may carry a deposit (enforced in the API).
-- No statement may contain a semicolon: scripts/migrate.ts splits on it.

ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS deposit_amount_cents integer;
ALTER TABLE shoot_bookings ADD COLUMN IF NOT EXISTS deposit_amount_cents integer;
