-- Persistent per-session history for the coding agent.
--
-- One append-only timeline per coding session that interleaves EVERYTHING in
-- chronological order: the co-pilot conversation (chat_user/chat_assistant),
-- terminal snapshots, commands the user sent, the brain's actions, and outcomes.
-- This is the single source of truth so:
--   • the console reloads your conversation when you reopen a session, and
--   • the co-pilot has continuity — it reads the recent timeline so it knows
--     what was discussed, what the agent did, and how it turned out.
--
-- `seq` (AUTOINCREMENT) gives a stable global chronological order; query a
-- session's history with ORDER BY seq, filter the chat with `type`.

CREATE TABLE coding_timeline (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES coding_sessions(id),
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,   -- chat_user | chat_assistant | terminal | command | brain | outcome | system
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coding_timeline_session ON coding_timeline(session_id, seq);
CREATE INDEX idx_coding_timeline_session_type ON coding_timeline(session_id, type, seq);
