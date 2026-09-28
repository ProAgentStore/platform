-- What a repo-less terminal did, kept after the terminal is gone (#878).
--
-- A coding session's pane is persisted to `coding_timeline`, keyed by a `coding_sessions` row —
-- and that row needs a repo (`repo_id NOT NULL`). A terminal-operator instance (tmux.control, no
-- repo) drives the machine through the `tmux_*` / `terminal_*` connector tools instead, which never
-- create a session row, so nothing it did was stored anywhere: once its tmux session ended,
-- `coding_session_capture`, `coding_terminal` and `coding_timeline` had nothing to read, and "did
-- the earlier install finish?" could not be answered.
--
-- This is that record, written by `runRegistryTool` after a terminal connector tool succeeds
-- (`lib/terminal-record.ts`):
--
--   • `terminal` — the pane a capture/run/send returned, deduped and throttled exactly like a
--     coding snapshot (`lib/terminal-snapshot.ts`) and capped at the same 8,000 characters;
--   • `command`  — what was typed or sent, so the narrative has its instructions;
--   • `system`   — lifecycle facts the platform observed (a target created or killed).
--
-- Keyed by instance + owner, not by a session, because the thing that outlives the tmux session is
-- the instance. It is kept until it is explicitly cleared (`DELETE /terminal-history`); the only
-- other deletion is the per-instance row cap, which drops the OLDEST rows of a very long history.
CREATE TABLE IF NOT EXISTS terminal_history (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  target       TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('terminal', 'command', 'system')),
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_terminal_history_owner ON terminal_history(instance_id, user_id, seq);
