-- A posting identity belongs to the Tailor instance that owns its durable application.
-- It deliberately does not deduplicate applications across Scouts, Tailors, or users.
-- Existing history is left untouched: legacy rows have no work key and retain their
-- original idempotency/event identity.
ALTER TABLE job_applications ADD COLUMN work_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_applications_instance_work_key
  ON job_applications(instance_id, work_key)
  WHERE work_key IS NOT NULL;
