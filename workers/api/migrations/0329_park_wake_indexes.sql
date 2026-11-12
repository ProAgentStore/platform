-- #1641: runDueParkWakes (every-minute backstop, coding-park.ts) scanned all of coder_questions on each
-- tick (~780K rows read per call, ~11B rows in 10 days): nothing indexed coder_questions by run. With
-- this index it starts from the parked runs (idx_agent_loop_runs_parked, 0150) and looks their
-- questions up by run.
CREATE INDEX IF NOT EXISTS idx_coder_questions_run ON coder_questions(run_id);
