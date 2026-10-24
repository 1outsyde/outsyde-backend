-- Migration 072: business referral cash (referral program Step 4, 2026-10-24).
--
-- Rules (Legend, 2026-10-23/24):
--   Anyone who refers a BUSINESS (not a photographer) earns $25 cash. The referred business counts once it is
--   approved and fully set up, has paid its first real plan charge and its plan is active, has an active feed post,
--   and has a live service, staff service or product, all within 90 days of the business signing up.
--   Blocked when the referrer owns or staffs the business, or shares its Stripe account or email.
--   At most 20 paid business referrals per referrer per New York calendar year.
--   The $25 goes out 7 days after the business qualifies, only if the first plan payment still stands.
--
-- business_referrals: one row per referred business (UNIQUE business_id).
--   pending -> qualified (payout row created in the same statement) | expired (90 days passed) | blocked.
-- referral_payouts: one row per qualified referral (UNIQUE business_referral_id). Same job shape as event_payouts:
--   'pending' until sent, 'held' when the referrer can't be paid yet, 'review' when a person must look,
--   'paid' when Stripe took the transfer, 'cancelled' when the plan payment was refunded or a block appeared.
--   There is no 'sending' status: the claim UPDATE plays that role.
-- vendor_subscriptions.first_paid_at / first_paid_invoice_id: set once, by invoice.paid, when a real amount was
--   charged (trials, 100% coupons and complimentary plans never set it).
--
-- Run in Neon by Claude as part of the build, before the PR is merged. Never via drizzle-kit push.
-- Idempotent: safe to re-run. Additive only.

CREATE TABLE IF NOT EXISTS business_referrals (
  id                     VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id       VARCHAR(36) NOT NULL REFERENCES users(id),
  business_id            VARCHAR(36) NOT NULL REFERENCES businesses(id),
  referred_owner_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  code                   TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',
  block_reason           TEXT,
  qualified_at           TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ NOT NULL,
  last_checked_at        TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_referrals_business_unique UNIQUE (business_id),
  CONSTRAINT business_referrals_status_valid CHECK (status IN ('pending', 'qualified', 'expired', 'blocked')),
  CONSTRAINT business_referrals_not_self CHECK (referrer_user_id <> referred_owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_business_referrals_referrer ON business_referrals (referrer_user_id, qualified_at);
CREATE INDEX IF NOT EXISTS idx_business_referrals_pending ON business_referrals (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS referral_payouts (
  id                   VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  business_referral_id VARCHAR(36) NOT NULL REFERENCES business_referrals(id),
  recipient_user_id    VARCHAR(36) NOT NULL REFERENCES users(id),
  amount_cents         INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  payable_after        TIMESTAMPTZ NOT NULL,
  destination_type     TEXT,
  connected_account_id TEXT,
  hold_reason          TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ,
  last_error           TEXT,
  alerted_at           TIMESTAMPTZ,
  transfer_id          TEXT,
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT referral_payouts_referral_unique UNIQUE (business_referral_id),
  CONSTRAINT referral_payouts_amount_fixed CHECK (amount_cents = 2500),
  CONSTRAINT referral_payouts_status_valid CHECK (status IN ('pending', 'held', 'review', 'paid', 'cancelled')),
  CONSTRAINT referral_payouts_destination_valid
    CHECK (destination_type IS NULL OR destination_type IN ('user', 'business', 'photographer'))
);

CREATE INDEX IF NOT EXISTS idx_referral_payouts_due
  ON referral_payouts (next_attempt_at)
  WHERE status IN ('pending', 'held');

ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS first_paid_at TIMESTAMPTZ;
ALTER TABLE vendor_subscriptions ADD COLUMN IF NOT EXISTS first_paid_invoice_id TEXT;
