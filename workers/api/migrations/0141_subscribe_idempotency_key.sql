-- subscribe is not idempotent: a transient error after the row is written tells the caller
-- to retry, and the retry creates a duplicate instance (#716).
--
-- The fix is an optional caller-supplied idempotency key.  When the same key is presented
-- on a retry the route returns the existing instance instead of inserting a second one.
-- Multi-instance remains a deliberate feature: omitting the key always creates a new
-- instance, so a second intentional subscription is unaffected.
--
-- The guard is a unique index on (user_id, idempotency_key): if two concurrent requests
-- with the same key race past the SELECT-then-INSERT, exactly one INSERT wins and the
-- other gets a UNIQUE constraint violation, which the route resolves by returning the
-- winning row.  NULL values are excluded from the unique constraint in SQLite (each NULL
-- is distinct), so existing rows and calls without a key are never touched.

ALTER TABLE agent_instances ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_agent_instances_idempotency_key
    ON agent_instances (user_id, idempotency_key)
 WHERE idempotency_key IS NOT NULL;
