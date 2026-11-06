-- 106: deliverable quotes, step D1a (Legend 2026-11-06, plan calls 1 to 12 as recommended, call 5 revised).
-- A product quote (a cake, a dress) can name the business's own product (a label and a link, never stock),
-- says how it gets to the customer (pickup or delivery), can carry a delivery fee line inside the total, and keeps
-- the delivery address the customer adds before paying. Service quotes have none of these.
-- All columns are nullable and additive: older app builds, goutsyde.com and the vendor sites never send them.
-- Safe to run twice. Run in Neon BEFORE the code is deployed (full-row selects need the columns).

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS product_id varchar(36) REFERENCES vendor_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fulfillment text,
  ADD COLUMN IF NOT EXISTS delivery_fee_cents integer,
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS delivery_address_at timestamptz;

DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_fulfillment_check CHECK (
    fulfillment IS NULL OR (kind = 'product' AND fulfillment IN ('pickup', 'delivery')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_delivery_fee_check CHECK (
    delivery_fee_cents IS NULL OR (fulfillment = 'delivery' AND delivery_fee_cents > 0 AND delivery_fee_cents < total_cents));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_delivery_address_check CHECK (
    delivery_address IS NULL OR (fulfillment = 'delivery' AND char_length(delivery_address) BETWEEN 5 AND 300));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_product_kind_check CHECK (product_id IS NULL OR kind = 'product');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
