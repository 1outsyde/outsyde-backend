-- Case-insensitive username uniqueness enforcement
-- Applied: 2026-03-20
-- Reason: Database safety net for username case collisions
-- Coexists with existing users_username_unique btree index

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx 
ON users (LOWER(username));
