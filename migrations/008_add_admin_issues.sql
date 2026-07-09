-- Add admin_issues table for the admin Overview "Known Issues" panel.
CREATE TABLE IF NOT EXISTS admin_issues (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  area TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  created_by VARCHAR(36) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP
);
