-- Migration 047: Business industry (category code, specialties, "Other" description)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- Every query that reads the businesses table selects these columns once the code is live,
-- so deploying the code first would break every business read with "column does not exist".
-- Every statement is idempotent: safe to re-run. Additive only: no existing column changes.
--
--   category_code      code of the chosen industry from shared/businessTaxonomy.ts (e.g. 'beauty')
--   specialties        codes of what the business does, e.g. ['beauty.service.braids_locs']
--   other_description  what the business wrote when it chose an "Other" option
--
-- Existing rows keep category_code NULL and specialties '[]' until Legend approves a mapping.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS category_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS specialties JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS other_description TEXT;

DO $$ BEGIN
  ALTER TABLE businesses
    ADD CONSTRAINT businesses_other_description_len CHECK (other_description IS NULL OR length(other_description) <= 500);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE businesses
    ADD CONSTRAINT businesses_specialties_is_array CHECK (jsonb_typeof(specialties) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_category_code ON businesses (category_code);

-- Verify (read-only):
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--  WHERE table_name = 'businesses' AND column_name IN ('category_code','specialties','other_description');
