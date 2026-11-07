-- #1586: what has been synced to the Jobs app for each application, and why a sync failed.
-- jobs_synced_key is "<tailoring run id>|<status>" of the last fully synced state; the sweep
-- retries any application whose current state differs. NULL error = nothing wrong.
ALTER TABLE job_applications ADD COLUMN jobs_synced_key TEXT;
ALTER TABLE job_applications ADD COLUMN jobs_sync_error TEXT;
ALTER TABLE job_applications ADD COLUMN jobs_sync_at INTEGER;
