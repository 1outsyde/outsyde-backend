-- 104: gap after every booking (Legend 2026-11-05).
-- A business (and its staff) gets booking_gap_minutes free after each booking:
-- a booking ending 3:30 means the next customer can start at 3:45. Default 15,
-- the vendor can change it. Photographers keep photographers.travel_buffer_minutes.
-- Safe to run twice. Run in Neon BEFORE the code that reads it is deployed
-- (full-row selects on businesses need the column to exist).

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS booking_gap_minutes integer NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_booking_gap_minutes_check'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_booking_gap_minutes_check
      CHECK (booking_gap_minutes IN (0, 5, 10, 15, 20, 30, 45, 60));
  END IF;
END $$;
