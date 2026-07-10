-- Migration 012: appointments.hold_id — traceability back to the bookingHolds
-- row an appointment was created from (unified availability engine / hold-based
-- booking flow). Nullable: existing rows and rows created outside that flow
-- (e.g. the dev-test endpoint) have no originating hold.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hold_id VARCHAR(36);

CREATE INDEX IF NOT EXISTS idx_appointments_hold_id ON appointments (hold_id);
