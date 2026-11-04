-- Migration 097: quotes (Quotes in Messages, step 2)
-- Run manually in the Neon SQL editor BEFORE the PR that uses it is merged (Render deploys on merge).
-- Never via drizzle-kit push. Idempotent: safe to re-run. Additive: one new table, and the messages kind rule
-- gains 'quote' (every existing message is 'text' or 'request', both still allowed).
--
--   quotes                a quote a business sends to a customer inside a chat
--     staff_member_id     set when a staff member sent it (they are paid, like their bookings; step 3)
--     request_id          the request it answers, if any
--     service_id          optional service it is for
--     job_date/start_time the job's local date and time in time_zone (the business's, New York when none)
--     starts_at           the same moment in UTC
--     payment_mode        'deposit' (deposit_cents now, the rest held later) or 'full'
--     status              sent | withdrawn | declined | expired | paid (paid arrives in step 3)
--     version             1 on send, +1 on each edit
--     expires_at          7 days after the last send or edit, or starts_at if sooner
--     link_code           code for goutsyde.com/q/<code> (page in step 5)
--     message_id          the newest quote card in the chat

CREATE TABLE IF NOT EXISTS quotes (
  id               VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      VARCHAR(36) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_member_id  VARCHAR(36) REFERENCES staff_members(id) ON DELETE SET NULL,
  sender_id        VARCHAR(36) NOT NULL REFERENCES users(id),
  customer_id      VARCHAR(36) NOT NULL REFERENCES users(id),
  conversation_id  VARCHAR(36) NOT NULL REFERENCES conversations(id),
  request_id       VARCHAR(36) REFERENCES estimate_requests(id) ON DELETE SET NULL,
  service_id       VARCHAR(36) REFERENCES vendor_services(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  details          TEXT,
  extras_note      TEXT,
  job_date         TEXT NOT NULL,
  start_time       TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  time_zone        TEXT NOT NULL,
  starts_at        TIMESTAMPTZ NOT NULL,
  total_cents      INTEGER NOT NULL,
  payment_mode     TEXT NOT NULL,
  deposit_cents    INTEGER,
  status           TEXT NOT NULL DEFAULT 'sent',
  version          INTEGER NOT NULL DEFAULT 1,
  expires_at       TIMESTAMPTZ NOT NULL,
  link_code        TEXT NOT NULL,
  message_id       VARCHAR(36) REFERENCES messages(id) ON DELETE SET NULL,
  decline_reason   TEXT,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at     TIMESTAMPTZ,
  declined_at      TIMESTAMPTZ,
  expired_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quotes_status_check CHECK (status IN ('sent', 'withdrawn', 'declined', 'expired', 'paid')),
  CONSTRAINT quotes_payment_mode_check CHECK (payment_mode IN ('deposit', 'full')),
  CONSTRAINT quotes_total_check CHECK (total_cents >= 700),
  CONSTRAINT quotes_deposit_check CHECK (
    (payment_mode = 'full' AND deposit_cents IS NULL) OR
    (payment_mode = 'deposit' AND deposit_cents >= 700 AND deposit_cents < total_cents)
  ),
  CONSTRAINT quotes_duration_check CHECK (duration_minutes BETWEEN 15 AND 4320),
  CONSTRAINT quotes_version_check CHECK (version >= 1),
  CONSTRAINT quotes_not_self CHECK (customer_id <> sender_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quotes_link_code ON quotes (link_code);
CREATE INDEX IF NOT EXISTS idx_quotes_business_created ON quotes (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_customer_created ON quotes (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_conversation ON quotes (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quotes_open_expiry ON quotes (expires_at) WHERE status = 'sent';

-- Message cards: 'quote' joins 'text' and 'request' (migration 096).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'request', 'quote')) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_kind_check;
