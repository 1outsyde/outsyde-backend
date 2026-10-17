-- Migration 049: Product options (Length, Size, Color) for product variations
-- Run manually in the Neon SQL editor BEFORE merging this PR. Never via drizzle-kit push.
-- Every statement is idempotent: safe to re-run. Nothing is dropped or rewritten.
--
-- Model (same idea as Shopify):
--   product_options        up to 3 named options per product, each with its values
--                          (position 1 = option1 on the variant, 2 = option2, 3 = option3)
--   product_variants       gains option1/option2/option3 (the value picked for each option)
--                          and image_url (optional photo, e.g. one per color)
--   product_variants.price_cents becomes optional: NULL = use the product's price,
--                          so 15 colors at the same price are priced once on the product.
-- Existing variants keep their label and price; their option columns stay NULL.

-- ── 1. product_options ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_options (
  id          VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  VARCHAR(36) NOT NULL REFERENCES vendor_products(id) ON DELETE CASCADE,
  position    SMALLINT    NOT NULL,
  name        TEXT        NOT NULL,
  -- [{"value": "Black", "swatchHex": "#0A0A0A"}, {"value": "Cream"}] in display order
  "values"    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE product_options
    ADD CONSTRAINT product_options_position_check CHECK (position BETWEEN 1 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_options
    ADD CONSTRAINT product_options_name_check CHECK (length(name) BETWEEN 1 AND 40);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_options
    ADD CONSTRAINT product_options_values_array_check CHECK (jsonb_typeof("values") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS product_options_product_position_uq
  ON product_options (product_id, position);

-- ── 2. product_variants: option values + photo ─────────────────────────────
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS option1   TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS option2   TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS option3   TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS image_url TEXT;

-- ── 3. product_variants.price_cents optional (NULL = product price) ────────
ALTER TABLE product_variants ALTER COLUMN price_cents DROP NOT NULL;

CREATE INDEX IF NOT EXISTS product_variants_product_id_idx
  ON product_variants (product_id);

-- ── Verify (read-only) ─────────────────────────────────────────────────────
-- SELECT column_name, is_nullable FROM information_schema.columns
--   WHERE table_name = 'product_variants' AND column_name IN ('price_cents','option1','option2','option3','image_url');
-- SELECT to_regclass('public.product_options');
