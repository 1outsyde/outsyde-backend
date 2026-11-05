-- 101: Quotes step 4b-2a (B15, Legend 2026-11-05): on a deposit quote the vendor picks how the rest is paid.
-- 'outsyde': held on the card the day before and charged at Job complete (as built in 4a).
-- 'outside': paid to the business directly, usually cash on the day (no service fee, no points, no Report on that part).
-- Additive: one column with a default, so every existing row (none in Neon on 2026-11-05) and every older sender is
-- 'outsyde'. A full payment quote has nothing left to pay outside. Safe to run twice.
-- Run in Neon BEFORE the code deploys. No statement contains a semicolon inside it.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS rest_paid text NOT NULL DEFAULT 'outsyde'
  CONSTRAINT quotes_rest_paid_check CHECK (rest_paid IN ('outsyde', 'outside') AND (rest_paid = 'outsyde' OR payment_mode = 'deposit'));
