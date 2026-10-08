-- A posting that disappears while a local application is being filled is a terminal fact, not a
-- retryable runner error. Keep the reason and the runner's bounded evidence on the application so
-- the Scout writeback backstop can finish (or repeat) its corresponding lead disposition.
ALTER TABLE job_applications ADD COLUMN archive_reason TEXT;
ALTER TABLE job_applications ADD COLUMN archive_evidence TEXT;
-- The Scout is a separate Durable Object, so acknowledgement is recorded only after its
-- idempotent disposition write succeeds. This makes a transient cross-store failure retryable
-- without ever reopening or replaying the application run.
ALTER TABLE job_applications ADD COLUMN lead_disposition_synced_at INTEGER;
