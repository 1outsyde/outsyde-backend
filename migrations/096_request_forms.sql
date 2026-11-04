-- Migration 096: request forms (Quotes in Messages, step 1)
-- Run manually in the Neon SQL editor BEFORE Render deploys the PR that uses it. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only: one new table and new columns that all have defaults, so every
-- existing row and every existing client reads the same values as before.
--
--   request_forms                      a business's form library: one base form + saved forms
--     questions                        the form's questions (see server/requests/requestForms.ts)
--   vendor_services.request_form_id    a saved form this service uses (null = none)
--   vendor_services.request_form_use_base  true = the base form comes first
--   vendor_services.request_questions  the service's own extra questions
--   estimate_requests.answers          the questions as they were when sent, with the answers
--   estimate_requests.conversation_id  the chat the request opened
--   estimate_requests.message_id       the request card message in that chat
--   messages.kind                      'text' (every message so far) or 'request' (a request card)
--   messages.card                      the card's data; null for a plain message

CREATE TABLE IF NOT EXISTS request_forms (
  id          VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id VARCHAR(36) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_base     BOOLEAN NOT NULL DEFAULT false,
  questions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT request_forms_questions_is_array CHECK (jsonb_typeof(questions) = 'array'),
  CONSTRAINT request_forms_base_active CHECK (NOT is_base OR is_active)
);
CREATE INDEX IF NOT EXISTS idx_request_forms_business ON request_forms (business_id, is_active, name);
-- One base form per business.
CREATE UNIQUE INDEX IF NOT EXISTS uq_request_forms_one_base ON request_forms (business_id) WHERE is_base;

ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS request_form_id VARCHAR(36) REFERENCES request_forms(id) ON DELETE SET NULL;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS request_form_use_base BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS request_questions JSONB NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  ALTER TABLE vendor_services ADD CONSTRAINT vendor_services_request_questions_is_array CHECK (jsonb_typeof(request_questions) = 'array') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Checked in a second step so the table is not locked against writes while it is scanned.
ALTER TABLE vendor_services VALIDATE CONSTRAINT vendor_services_request_questions_is_array;

ALTER TABLE estimate_requests ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE estimate_requests ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(36) REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE estimate_requests ADD COLUMN IF NOT EXISTS message_id VARCHAR(36) REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_estimate_requests_conversation ON estimate_requests (conversation_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS card JSONB;
DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'request')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE messages VALIDATE CONSTRAINT messages_kind_check;
