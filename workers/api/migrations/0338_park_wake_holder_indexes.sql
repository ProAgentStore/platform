-- #1641: runDueParkWakes asks, for each answered run that released its checkout, whether something else
-- holds that repo. It walked EVERY session the repo ever had (~370 each, almost all ended) to find one
-- with a driver or a direct turn, about 14,000 rows a minute. Sessions holding a checkout that way are a
-- handful at any time; this index holds only those.
CREATE INDEX IF NOT EXISTS idx_coding_sessions_held
  ON coding_sessions(repo_id) WHERE driver_id IS NOT NULL OR direct_turn_id IS NOT NULL;

-- #1654: the "is this coder busy" predicates (keepsCoderBusySql / ownsCheckoutSql) are asked by instance_id
-- alone, so idx_agent_loop_runs_open_user_instance (user_id first) cannot serve them and they read every
-- run the instance ever had through idx_agent_loop_runs_instance (~470 rows a call in coderBlocker). Only
-- running rows are in this index, and neither column changes on a heartbeat.
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_open_instance
  ON agent_loop_runs(instance_id, started_at) WHERE status = 'running';
