-- Local browser research reads the runner, rather than the runner writing to the API (#944).
--
-- The relay carries only cloud→runner commands, and the runner process holds no API token, so the
-- callback design of 0175 could not work. PAGS now pulls `/local-browser/status` when a run is read
-- and from the per-minute cron. `runner_seq` is the last runner event seq already stored — the
-- next pull's `afterSeq` — and `last_synced_at` is when the runner last answered for this run, so
-- a run whose runner is gone for good can be ended instead of shown as running forever.
ALTER TABLE local_browser_runs ADD COLUMN runner_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_browser_runs ADD COLUMN last_synced_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_local_browser_runs_sync ON local_browser_runs(status, last_synced_at);
