-- #1027: one row per product-owner triage wake of a coder instance.
--
-- The wake is a `run_po_triage` cron trigger, and an instance may have several (a morning and an
-- evening window). UNIQUE (instance_id, slot) is how two windows that fire in the same minute
-- produce ONE wake: the second insert is ignored and that dispatch records a skip. The report is
-- what the wake decided per issue (queued, waiting on a person, blocked, needs detail) with one
-- line of reason each; `digest` is the sentence the owner was notified with, NULL when nothing
-- changed and no notification was sent. No issue bodies or comments are stored.
CREATE TABLE IF NOT EXISTS po_triage_reports (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id     TEXT NOT NULL,
  trigger_id  TEXT,
  slot        TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  report      TEXT,
  digest      TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (instance_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_po_triage_reports_instance ON po_triage_reports(instance_id, created_at DESC);
