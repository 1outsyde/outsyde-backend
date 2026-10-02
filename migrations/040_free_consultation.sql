-- Migration 040: free consultation services + booking questions
-- vendor_services.is_free_consultation marks a $0 service booked without
-- payment. vendor_services.booking_questions holds the service's intake
-- questions (generic column, currently only allowed on free consultations).
-- appointments.booking_answers is the customer's answers snapshot
-- (label and type copied at booking time).
-- No statement may contain a semicolon: scripts/migrate.ts splits on it.

ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS is_free_consultation boolean NOT NULL DEFAULT false;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS booking_questions jsonb;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booking_answers jsonb;
