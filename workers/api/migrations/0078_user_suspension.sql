-- Operator moderation: user suspension (epic: PAGS Admin Portal, issue #34).
--
-- Before this there was no lever at all for abuse or a runaway account: an operator
-- could SEE the damage (admin users/agents/instances views) and do nothing about it.
-- Revoking the session token is not a substitute — tokens live 30 days and the user
-- can just sign in again, minting a fresh one.
--
-- `suspended` is checked in requireUser (lib/auth.ts), so it gates EVERY authenticated
-- route at once rather than being sprinkled per-handler where the next new route would
-- silently forget it. Suspension is reversible and always audited (admin_audit_log).
ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN suspended_at TEXT;
ALTER TABLE users ADD COLUMN suspended_reason TEXT;

-- Partial index: the requireUser check is a PK lookup, but the operator's "who is
-- suspended" query scans, and suspended users are a tiny minority of the table.
CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(suspended) WHERE suspended = 1;
