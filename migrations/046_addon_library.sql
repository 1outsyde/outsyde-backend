-- Migration 046: Add-on library (business-level add-ons linked to service add-ons)
-- Run manually in the Neon SQL editor BEFORE merging this PR. Never via drizzle-kit push.
-- Every statement is idempotent: safe to re-run.
--
-- Model: business_addons is the vendor's library. Each service still has its own
-- service_addons row (bookings, holds and payments keep reading only that row).
-- A service_addons row may link to a library add-on via business_addon_id.
--   price_synced = true   -> library price changes update this row's price
--   price_synced = false  -> this service keeps its own price; the vendor is asked
--                            once per library price change (declined_library_price_cents
--                            remembers the library price she already turned down)

-- ── 1. business_addons ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_addons (
  id               VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      VARCHAR(36) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  description      TEXT,
  price_cents      INTEGER     NOT NULL DEFAULT 0,
  duration_minutes INTEGER     NOT NULL DEFAULT 0,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order       INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE business_addons
    ADD CONSTRAINT business_addons_desc_check CHECK (description IS NULL OR length(description) <= 300);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE business_addons
    ADD CONSTRAINT business_addons_price_check CHECK (price_cents >= 0 AND price_cents <= 100000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE business_addons
    ADD CONSTRAINT business_addons_duration_check CHECK (duration_minutes >= 0 AND duration_minutes <= 480);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_addons_business
  ON business_addons(business_id, is_active, sort_order, name);

-- ── 2. service_addons: link + price sync columns ───────────────────────────
ALTER TABLE service_addons
  ADD COLUMN IF NOT EXISTS business_addon_id VARCHAR(36) REFERENCES business_addons(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS price_synced BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS declined_library_price_cents INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_service_addons_business_addon
  ON service_addons(business_addon_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_addons_service_library
  ON service_addons(service_id, business_addon_id)
  WHERE business_addon_id IS NOT NULL;

-- ── 3. Backfill: one library add-on per business + name ────────────────────
-- 3a. Create missing library rows from the earliest unlinked add-on of each
--     (business, lower(trim(name))). Archived services are included.
INSERT INTO business_addons (business_id, name, description, price_cents, duration_minutes, is_active, sort_order)
SELECT DISTINCT ON (vs.business_id, lower(trim(sa.name)))
       vs.business_id, trim(sa.name), sa.description, sa.price_cents, sa.duration_minutes, sa.is_active, sa.sort_order
FROM service_addons sa
JOIN vendor_services vs ON vs.id = sa.service_id
WHERE sa.business_addon_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM business_addons ba
    WHERE ba.business_id = vs.business_id
      AND lower(trim(ba.name)) = lower(trim(sa.name))
  )
ORDER BY vs.business_id, lower(trim(sa.name)), sa.created_at, sa.id;

-- 3b. Link every unlinked row to its library add-on. A row whose price differs
--     from the library keeps its own price (price_synced = false) and counts that
--     library price as already seen, so nothing is prompted until it changes.
--     If one service has two add-ons with the same name, only the earliest is
--     linked (the unique index allows one link per service + library add-on).
UPDATE service_addons sa
SET business_addon_id = m.library_id,
    price_synced = (sa.price_cents = m.library_price),
    declined_library_price_cents = CASE WHEN sa.price_cents = m.library_price THEN NULL ELSE m.library_price END
FROM (
  SELECT DISTINCT ON (sa2.service_id, ba.id)
         sa2.id AS addon_id, ba.id AS library_id, ba.price_cents AS library_price
  FROM service_addons sa2
  JOIN vendor_services vs ON vs.id = sa2.service_id
  JOIN business_addons ba
    ON ba.business_id = vs.business_id
   AND lower(trim(ba.name)) = lower(trim(sa2.name))
  WHERE sa2.business_addon_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM service_addons sa3
      WHERE sa3.service_id = sa2.service_id AND sa3.business_addon_id = ba.id
    )
  ORDER BY sa2.service_id, ba.id, sa2.created_at, sa2.id
) m
WHERE sa.id = m.addon_id;

-- ── 4. Verification (run after, read-only) ─────────────────────────────────
-- SELECT business_id, count(*) FROM business_addons GROUP BY 1;
-- SELECT count(*) AS unlinked FROM service_addons WHERE business_addon_id IS NULL;   -- expect 0 today
-- SELECT sa.id, sa.price_cents, ba.price_cents AS library_price, sa.price_synced
--   FROM service_addons sa JOIN business_addons ba ON ba.id = sa.business_addon_id
--  WHERE (sa.price_cents = ba.price_cents) <> sa.price_synced;                      -- expect 0 rows
