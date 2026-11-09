-- Migration 108: request forms and requests for photographers (Request forms F2, Legend 2026-11-09, calls 1 to 12).
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run (no DO blocks, so scripts/migrate.ts can split it on semicolons too).
-- Both owner tables were empty when this was written (0 request_forms, 0 estimate_requests, 0 photographer_services
-- in Neon 2026-11-09), so the new rules are checked instantly. Every existing row keeps business_id set.
--
--   request_forms.business_id                    now optional: a form belongs to a business OR a photographer
--   request_forms.photographer_id                the photographer whose library it is
--   request_forms_one_owner                      exactly one of the two is set
--   uq_request_forms_one_base_photographer       one base form per photographer (the business index ignores nulls)
--   estimate_requests.business_id                now optional: a request is to a business OR a photographer
--   estimate_requests.photographer_id            the photographer it was sent to (service_id then holds a photographer_services id)
--   estimate_requests_one_owner                  exactly one of the two is set
--   photographer_services.request_form_id        a saved form this service uses (null = none)
--   photographer_services.request_form_use_base  true = the base form comes first
--   photographer_services.request_questions      the service's own questions

ALTER TABLE request_forms ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE request_forms ADD COLUMN IF NOT EXISTS photographer_id VARCHAR(36) REFERENCES photographers(id) ON DELETE CASCADE;
ALTER TABLE request_forms DROP CONSTRAINT IF EXISTS request_forms_one_owner;
ALTER TABLE request_forms ADD CONSTRAINT request_forms_one_owner CHECK (num_nonnulls(business_id, photographer_id) = 1);
CREATE INDEX IF NOT EXISTS idx_request_forms_photographer ON request_forms (photographer_id, is_active, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_request_forms_one_base_photographer ON request_forms (photographer_id) WHERE is_base;

ALTER TABLE estimate_requests ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE estimate_requests ADD COLUMN IF NOT EXISTS photographer_id VARCHAR(36) REFERENCES photographers(id) ON DELETE CASCADE;
ALTER TABLE estimate_requests DROP CONSTRAINT IF EXISTS estimate_requests_one_owner;
ALTER TABLE estimate_requests ADD CONSTRAINT estimate_requests_one_owner CHECK (num_nonnulls(business_id, photographer_id) = 1);
CREATE INDEX IF NOT EXISTS idx_estimate_requests_photographer_created ON estimate_requests (photographer_id, created_at);

ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS request_form_id VARCHAR(36) REFERENCES request_forms(id) ON DELETE SET NULL;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS request_form_use_base BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE photographer_services ADD COLUMN IF NOT EXISTS request_questions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE photographer_services DROP CONSTRAINT IF EXISTS photographer_services_request_questions_is_array;
ALTER TABLE photographer_services ADD CONSTRAINT photographer_services_request_questions_is_array CHECK (jsonb_typeof(request_questions) = 'array');
