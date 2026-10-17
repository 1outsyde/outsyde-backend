-- Migration 048: Loyalty points ledger integrity (R2 points fix)
-- Run manually in the Neon SQL editor BEFORE Render deploys this PR. Never via drizzle-kit push.
-- The new code selects pending_points_transactions.release_after, so deploying the code first
-- would break every pending points read with "column does not exist".
-- Every statement is idempotent: safe to re-run. Additive only: no existing column changes.
--
--   release_after                 when a pending row may be released automatically
--                                 (3 days after the appointment or shoot, or 3 days after a
--                                 qualifying first purchase for referral rows). NULL = never auto.
--   uq_point_tx_earn_redeem_ref   one earn and one redeem row per user per reference, so a retried
--                                 webhook or a double click can never credit or charge points twice.
--                                 Reversal rows are not covered (partial refunds can add several).
--
-- Pre-check (read-only) before running: this must return 0 rows, or the unique index will fail.
--   SELECT user_id, type, reference_type, reference_id, count(*)
--   FROM point_transactions
--   WHERE reference_id IS NOT NULL AND type IN ('earn', 'redeem')
--   GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;

ALTER TABLE pending_points_transactions ADD COLUMN IF NOT EXISTS release_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pending_points_release
  ON pending_points_transactions (release_after)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_point_tx_earn_redeem_ref
  ON point_transactions (user_id, type, reference_type, reference_id)
  WHERE reference_id IS NOT NULL AND type IN ('earn', 'redeem');

-- Already in production since migration 033 (not declared in schema.ts); listed here so a fresh
-- local database matches. The new code relies on it (ON CONFLICT (reference_type, reference_id)).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_points_reference
  ON pending_points_transactions (reference_type, reference_id);
