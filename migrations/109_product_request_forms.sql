-- Migration 109: request forms on products (Request forms step P, Legend 2026-11-09, calls P1 to P8).
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run (no DO blocks, so scripts/migrate.ts can split it on semicolons too).
-- Additive: every new column has a default, so the 37 existing products (22 live) read exactly as before
-- (request_only false = sold as today). estimate_requests was empty when this was written.
--
--   vendor_products.request_only            true = customers send a request (contact for pricing), never buy it as is
--   vendor_products.request_form_id         a saved form this product uses (null = none)
--   vendor_products.request_form_use_base   true = the base form comes first
--   vendor_products.request_questions       the product's own questions
--   estimate_requests.product_id            the product a request is for (a request is for a service OR a product)

ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS request_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS request_form_id VARCHAR(36) REFERENCES request_forms(id) ON DELETE SET NULL;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS request_form_use_base BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS request_questions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE vendor_products DROP CONSTRAINT IF EXISTS vendor_products_request_questions_is_array;
ALTER TABLE vendor_products ADD CONSTRAINT vendor_products_request_questions_is_array CHECK (jsonb_typeof(request_questions) = 'array');

ALTER TABLE estimate_requests ADD COLUMN IF NOT EXISTS product_id VARCHAR(36) REFERENCES vendor_products(id) ON DELETE SET NULL;
ALTER TABLE estimate_requests DROP CONSTRAINT IF EXISTS estimate_requests_service_or_product;
ALTER TABLE estimate_requests ADD CONSTRAINT estimate_requests_service_or_product CHECK (num_nonnulls(service_id, product_id) <= 1);
CREATE INDEX IF NOT EXISTS idx_estimate_requests_product ON estimate_requests (product_id);
