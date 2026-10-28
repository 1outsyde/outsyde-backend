-- Migration 075: product add-on groups (2026-10-28).
--
-- A product can have add-on groups, e.g. "Toppings (pick up to 3)" or "Name on the cake (optional)".
--   product_addon_groups  one row per group: name, min_select, max_select (NULL = no limit)
--   product_addons        one row per choice in a group: price added per unit, optional text the customer types
-- Add-ons have an on/off switch only (is_active). No stock counts, by decision (Oct 28).
-- business_addon_id links a choice to the shared add-on library (business_addons) for step 2b; NULL until then.
-- Checkout (server/cartPricing.ts) prices add-ons from these tables, never from the client. Old app builds send
-- no add-ons and are never blocked, even when a group has min_select > 0.
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: two new tables, no change to existing tables.

CREATE TABLE IF NOT EXISTS product_addon_groups (
  id          VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  VARCHAR(36) NOT NULL REFERENCES vendor_products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  min_select  INTEGER NOT NULL DEFAULT 0 CHECK (min_select BETWEEN 0 AND 20),
  max_select  INTEGER CHECK (max_select IS NULL OR (max_select BETWEEN 1 AND 20 AND max_select >= min_select)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_addon_groups_product ON product_addon_groups (product_id, sort_order);

CREATE TABLE IF NOT EXISTS product_addons (
  id                            VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id                      VARCHAR(36) NOT NULL REFERENCES product_addon_groups(id) ON DELETE CASCADE,
  product_id                    VARCHAR(36) NOT NULL REFERENCES vendor_products(id) ON DELETE CASCADE,
  business_addon_id             VARCHAR(36) REFERENCES business_addons(id) ON DELETE CASCADE,
  name                          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description                   TEXT CHECK (description IS NULL OR char_length(description) <= 300),
  price_cents                   INTEGER NOT NULL DEFAULT 0 CHECK (price_cents BETWEEN 0 AND 100000),
  accepts_text                  BOOLEAN NOT NULL DEFAULT FALSE,
  text_label                    TEXT CHECK (text_label IS NULL OR char_length(text_label) <= 60),
  text_max_length               INTEGER NOT NULL DEFAULT 40 CHECK (text_max_length BETWEEN 1 AND 200),
  is_active                     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  price_synced                  BOOLEAN NOT NULL DEFAULT TRUE,
  declined_library_price_cents  INTEGER,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_addons_group   ON product_addons (group_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_addons_product ON product_addons (product_id);
CREATE INDEX IF NOT EXISTS idx_product_addons_library ON product_addons (business_addon_id) WHERE business_addon_id IS NOT NULL;
