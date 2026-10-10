-- #1008: an accepted runner update needs durable, bounded progress evidence.  `phase` is the
-- last control-plane checkpoint; it deliberately does not claim that an unobservable machine step
-- completed.  A late reply is preserved as reconciliation without reopening an abandoned attempt.
ALTER TABLE runner_update_ops ADD COLUMN phase TEXT NOT NULL DEFAULT 'claimed';
ALTER TABLE runner_update_ops ADD COLUMN reconciliation TEXT;
ALTER TABLE runner_update_ops ADD COLUMN reconciled_at INTEGER;
