-- 107: change email, step 1 (Legend 2026-11-06, calls as recommended: no password needed for Google or Apple only
-- accounts, other devices stay signed in, the old address gets a notice).
-- A signed in user asks for a new email; a 6 digit code goes to the NEW address; entering it moves users.email.
-- Only the hash of the code is stored. One open request per user (a new request replaces the old one).
-- New table only, nothing existing changes. Safe to run twice. Run in Neon BEFORE the code is deployed.

CREATE TABLE IF NOT EXISTS email_change_requests (
  id            varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
  user_id       varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_email     text,
  new_email     text NOT NULL,
  code_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  cancelled_at  timestamptz,
  CONSTRAINT email_change_requests_status_check CHECK (status IN ('pending', 'confirmed', 'cancelled', 'replaced', 'expired')),
  CONSTRAINT email_change_requests_new_email_check CHECK (new_email = lower(new_email) AND char_length(new_email) BETWEEN 3 AND 254)
);

-- One open request per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_change_requests_one_pending
  ON email_change_requests (user_id) WHERE status = 'pending';

-- Requests per user per hour (rate limit) and history.
CREATE INDEX IF NOT EXISTS idx_email_change_requests_user_created
  ON email_change_requests (user_id, created_at DESC);
