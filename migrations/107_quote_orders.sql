-- 107: deliverable quotes, step D1b (Legend 2026-11-06, D1b plan v2 calls 1 to 12, "just like selling a product").
-- A paid deliverable (product) quote becomes a normal product order: one orders row for the business, paid with a
-- destination charge like a single shop product sale. The order keeps which quote it came from, how it gets to
-- the customer (pickup or delivery), the quote total and the part paid directly to the business (deposit quotes).
-- quotes.order_id links back. At most one live (pending, paid, shipped or delivered) order per quote.
-- All additive and nullable: product orders from the cart never set these. Safe to run twice.
-- Run in Neon BEFORE the code is deployed (full-row selects need the columns).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS quote_id varchar(36) REFERENCES quotes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fulfillment text,
  ADD COLUMN IF NOT EXISTS quote_total_cents integer,
  ADD COLUMN IF NOT EXISTS paid_directly_cents integer;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_check CHECK (fulfillment IS NULL OR fulfillment IN ('pickup', 'delivery'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS orders_one_live_per_quote
  ON orders (quote_id) WHERE quote_id IS NOT NULL AND status IN ('pending', 'paid', 'shipped', 'delivered');

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS order_id varchar(36) REFERENCES orders(id) ON DELETE SET NULL;
