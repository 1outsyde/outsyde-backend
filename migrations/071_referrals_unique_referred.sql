-- 071: one referral per person (friend referral Step 1, 2026-10-23).
-- processReferral inserts with ON CONFLICT (referred_user_id) DO NOTHING, so two codes applied at
-- the same moment can never create two referral rows for one person. Neon had 0 referral rows when
-- this was written, so the index cannot fail on existing data.
-- Run by hand in Neon BEFORE the backend change merges (the insert needs this index).

CREATE UNIQUE INDEX IF NOT EXISTS uq_referrals_referred_user ON referrals (referred_user_id);

-- New referral rows always set both amounts; keep the defaults in line with the 2,500 rule.
ALTER TABLE referrals ALTER COLUMN referrer_bonus_points SET DEFAULT 2500;
ALTER TABLE referrals ALTER COLUMN referred_bonus_points SET DEFAULT 2500;
