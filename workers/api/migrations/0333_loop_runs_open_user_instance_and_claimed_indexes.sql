-- #1654: the open-run lookups (runner-park wake, repo owners, busy holder, PO triage, start idempotency,
-- machine-registered wake) all ask for an instance's or user's RUNNING runs, and had only
-- (user_id, started_at) / (instance_id, started_at) to find them with: every call read every run the
-- instance ever had (~5,960 rows). Partial like idx_agent_loop_runs_open, so it holds only the handful
-- of open runs. user_id leads because one of them (wakeRunsParkedOnMachine) has no instance; started_at
-- keeps the ORDER BY started_at DESC callers on it.
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_open_user_instance
  ON agent_loop_runs(user_id, instance_id, started_at DESC) WHERE status = 'running';

-- #1654: releaseStaleClaims (account-stop-resume.ts) ran as a full table scan on every sweep. Only a
-- run mid-claim has auto_resume_state = 'claimed', so this index is normally empty.
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_resume_claimed
  ON agent_loop_runs(auto_resume_at) WHERE auto_resume_state = 'claimed';
