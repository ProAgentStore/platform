-- Active execution time excludes time awaiting the owner. Existing active runs receive a
-- fresh bounded budget because their truncated historical trace cannot recover past pause time.
ALTER TABLE local_apply_runs ADD COLUMN active_elapsed_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_apply_runs ADD COLUMN active_started_at INTEGER;
UPDATE local_apply_runs SET active_started_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE status = 'running';
