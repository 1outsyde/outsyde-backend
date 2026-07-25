-- Migration 022: pending points transactions for admin review before crediting
CREATE TABLE IF NOT EXISTS pending_points_transactions (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),

  dollar_amount_cents INTEGER NOT NULL,           -- consumer total paid (including 8% upcharge)
  transaction_type TEXT NOT NULL,                 -- 'photographer_booking' | 'business_transaction' | 'bonus'
  points_earned INTEGER NOT NULL,                 -- calculated: round(dollar_amount_cents * 4 / 108)
  outsyde_revenue_cents INTEGER NOT NULL,         -- = points_earned (same numeric value, unit = cents = $)

  business_id VARCHAR(36),
  business_name TEXT,
  reference_type TEXT,                            -- 'appointment' | 'shoot_booking' | 'cart_order' | etc.
  reference_id VARCHAR(36),
  description TEXT,

  status TEXT NOT NULL DEFAULT 'pending',         -- 'pending' | 'approved' | 'rejected'
  reviewed_at TIMESTAMP,
  reviewed_by VARCHAR(36),
  review_note TEXT,
  live_transaction_id VARCHAR(36),                -- set on approval; FK to point_transactions.id

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_points_user_id
  ON pending_points_transactions (user_id);

CREATE INDEX IF NOT EXISTS idx_pending_points_status
  ON pending_points_transactions (status);

CREATE INDEX IF NOT EXISTS idx_pending_points_reference
  ON pending_points_transactions (reference_type, reference_id);
