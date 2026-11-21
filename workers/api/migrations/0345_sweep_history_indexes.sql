-- #1680: three per-minute sweeps full-scanned history tables that only ever grow. Each index below is PARTIAL, so it
-- holds only the live set the sweep is looking for and the sweep reads no history.
-- failExpiredCodeWaits: sign-ins still waiting on a code.
CREATE INDEX IF NOT EXISTS idx_local_apply_agent_sign_ins_code_wait ON local_apply_agent_sign_ins(code_requested_at)
  WHERE state = 'signing_in' AND code_message_id IS NULL AND code_requested_at IS NOT NULL;
-- expireScheduledUpdateOps: scheduled updates not yet reconciled, oldest first.
CREATE INDEX IF NOT EXISTS idx_runner_update_ops_scheduled ON runner_update_ops(created_at)
  WHERE state = 'scheduled' AND reconciliation IS NULL;
-- syncLeadWritebacks: the recently-moved arm seeks updated_at; the backlog arm reads only unsynced dispositions.
CREATE INDEX IF NOT EXISTS idx_job_applications_updated ON job_applications(updated_at);
CREATE INDEX IF NOT EXISTS idx_job_applications_disposition_backlog ON job_applications(updated_at)
  WHERE lead_disposition_synced_at IS NULL AND (archive_reason = 'job_unavailable' OR json_extract(lead, '$.verification.state') IN ('live', 'unavailable', 'unverifiable'));
