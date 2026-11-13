-- #1657: the local-browser sync asks "is this run a lead verification" by run_id, which no index covered,
-- so every call scanned the whole table (~2,000 rows, ~125 calls per half hour). run_id is NULL for
-- attempts that never dispatched; those are left out.
CREATE INDEX IF NOT EXISTS idx_job_lead_bv_attempts_run
  ON job_lead_browser_verification_attempts(run_id) WHERE run_id IS NOT NULL;
