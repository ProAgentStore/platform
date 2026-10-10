-- #1011: a reviewed one-click refusal is a narrow, durable recovery authorization.  The
-- original authorization table already makes a decision single-use; these columns bind this
-- exceptional recovery to the exact Runner/run/job state that proved no click was made.
ALTER TABLE job_application_submit_authorizations ADD COLUMN approval_kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE job_application_submit_authorizations ADD COLUMN approved_runner_instance_id TEXT;
ALTER TABLE job_application_submit_authorizations ADD COLUMN approved_fill_run_id TEXT;
ALTER TABLE job_application_submit_authorizations ADD COLUMN approved_job_identity TEXT;
ALTER TABLE job_application_submit_authorizations ADD COLUMN recovery_id TEXT;
ALTER TABLE job_application_submit_authorizations ADD COLUMN recovery_runner_instance_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_submit_auth_recovery
  ON job_application_submit_authorizations(recovery_id)
  WHERE recovery_id IS NOT NULL;
