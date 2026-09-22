-- Migration 032: create pending_points_transactions table
-- Stores loyalty points earned at booking payment time in a held/pending state.
-- Points are approved (moved to point_transactions) when the appointment is
-- marked completed, or rejected if the appointment is cancelled.

CREATE TABLE IF NOT EXISTS pending_points_transactions (
  id                    VARCHAR(36)   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               VARCHAR(36)   NOT NULL REFERENCES users(id),

  dollar_amount_cents   INTEGER       NOT NULL,
  transaction_type      TEXT          NOT NULL,  -- 'photographer_booking' | 'business_transaction' | 'bonus'
  points_earned         INTEGER       NOT NULL,
  outsyde_revenue_cents INTEGER       NOT NULL,

  business_id           VARCHAR(36),
  business_name         TEXT,
  reference_type        TEXT,
  reference_id          VARCHAR(36),
  description           TEXT,

  status                TEXT          NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  reviewed_at           TIMESTAMP,
  reviewed_by           VARCHAR(36),
  review_note           TEXT,
  live_transaction_id   VARCHAR(36),  -- set when approved, references point_transactions.id

  created_at            TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_points_user_id
  ON pending_points_transactions (user_id);

CREATE INDEX IF NOT EXISTS idx_pending_points_reference
  ON pending_points_transactions (reference_type, reference_id);

CREATE INDEX IF NOT EXISTS idx_pending_points_status
  ON pending_points_transactions (status);
