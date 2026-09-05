-- Add auto-incrementing booking_number to appointments for human-readable booking references.
-- Schema.ts declared this column (serial) but no migration had created it, causing
-- NeonDbError on every Drizzle ORM SELECT from the appointments table (Drizzle generates
-- explicit column lists, not SELECT *).

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS booking_number SERIAL;
