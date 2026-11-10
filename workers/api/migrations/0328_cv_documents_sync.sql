-- #1624: what has been copied to the owner's CV app (cv.proappstore.online) for each application, and why
-- a copy failed. Same shape as 0324's Jobs columns, kept separate so neither mirror blocks the other.
ALTER TABLE job_applications ADD COLUMN cv_synced_key TEXT;
ALTER TABLE job_applications ADD COLUMN cv_sync_error TEXT;
ALTER TABLE job_applications ADD COLUMN cv_sync_at INTEGER;
