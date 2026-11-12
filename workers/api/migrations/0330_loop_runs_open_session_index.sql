-- #1641: the park-wake backstop (runDueParkWakes) asks, for every sibling session of every parked run,
-- whether an open run on that session holds the checkout. With no session_id index each probe scanned
-- the whole open set: ~830K rows read per call. Partial like idx_agent_loop_runs_open, so it stays small.
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_open_session
  ON agent_loop_runs(session_id) WHERE status = 'running';
