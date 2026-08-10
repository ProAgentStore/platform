-- Persisted activity timestamp for agent_instances (#472).
--
-- `last_activity_at` is set on real user-driven events: a chat message, a task
-- creation, an apply start, a coding session start. It is NOT bumped by config
-- writes (voice settings, runner pins, etc.) — those live on `updated_at`.
--
-- The list endpoint (GET /v1/instances/my/instances) returns this column so a
-- caller can sort most-recently-used first without probing each DO.
--
-- Backfilled from `updated_at` so existing rows are not all null. NULL means
-- "we have never seen activity since the migration landed", which is the honest
-- state for a fresh install tested after deployment.
--
-- D1 does not allow ALTER TABLE … ADD COLUMN with a non-constant DEFAULT that
-- reads another column, so backfill is a separate UPDATE.

ALTER TABLE agent_instances ADD COLUMN last_activity_at TEXT;

UPDATE agent_instances SET last_activity_at = updated_at WHERE last_activity_at IS NULL;
