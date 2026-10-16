-- #1075: `coder_questions` becomes the source of truth for an owner's answer, not the runner's memory.
--   answered_via   → the door it came through: `console` or `mcp` for a person, `brain` for the coder brain
--   answered_at    → when it was recorded (ms). Set on EVERY answer, including one that came late
--   applied_at     → when a run consumed it (ms); NULL while the answer is still waiting to be used
--   applied_run_id → the run that consumed it
-- The existing states are reused, so no CHECK rebuild of `state`. A parked run reads its answer from
-- here (`storedAnswer`), so an answer survives a runner restart and a late one waits for the resume.
ALTER TABLE coder_questions ADD COLUMN answered_via TEXT CHECK (answered_via IN ('console', 'mcp', 'brain'));
ALTER TABLE coder_questions ADD COLUMN answered_at INTEGER;
ALTER TABLE coder_questions ADD COLUMN applied_at INTEGER;
ALTER TABLE coder_questions ADD COLUMN applied_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_coder_questions_task ON coder_questions(instance_id, task_id, asked_at DESC);
