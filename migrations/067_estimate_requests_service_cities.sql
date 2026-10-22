-- Migration 067: estimate requests + service cities + request only services (Royal Elite standalone site)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new table, two new columns on vendor_services, one new
-- column on businesses. Every new column has a default, so existing rows and every existing client read
-- the same values as before.
--
--   businesses.service_cities         the cities this business serves (shown on its site's estimate form)
--   vendor_services.service_cities    the cities a service is offered in; empty = every city of the business
--   vendor_services.request_only      true = customers request an estimate instead of booking (never held or paid)
--
--   estimate_requests                 a customer's estimate request to a business, saved from its site
--     status   'new' | 'called' | 'quoted' | 'booked' | 'closed' (the business moves it along by hand)
--     details  the form answers (move date, home size, addresses, floor, stops, notes, ...) as JSON
--     vendor_notes                     the business's own notes from the call back

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS service_cities TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS service_cities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS request_only BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS estimate_requests (
  id              VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     VARCHAR(36) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  service_id      VARCHAR(36) REFERENCES vendor_services(id) ON DELETE SET NULL,
  service_name    TEXT,
  city            TEXT,
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT NOT NULL,
  preferred_date  TEXT,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'new',
  vendor_notes    TEXT,
  source          TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT estimate_requests_status_check CHECK (status IN ('new', 'called', 'quoted', 'booked', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_estimate_requests_business_created ON estimate_requests (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimate_requests_customer ON estimate_requests (customer_id);
