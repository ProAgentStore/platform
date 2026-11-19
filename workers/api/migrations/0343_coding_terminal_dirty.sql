-- #1642: the hourly terminal-retention sweep found over-cap sessions with
--   SELECT session_id FROM coding_timeline WHERE type = 'terminal' GROUP BY session_id HAVING COUNT(*) > ?
-- which reads EVERY terminal row (~47-51K rows per call in production) however few sessions are over the cap, and the scan
-- grows with the table. This table is the sweep's worklist instead: a terminal write marks its session (appendTimeline), and the
-- sweep visits only marked sessions, counting at most cap+1 rows each through idx_coding_timeline_session_type, pruning the ones
-- that are over, and unmarking a session once it is verified at or under the cap.
CREATE TABLE IF NOT EXISTS coding_terminal_dirty (
  session_id TEXT PRIMARY KEY,
  marked_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coding_terminal_dirty_marked ON coding_terminal_dirty(marked_at);

-- One-time seed: every session that already has terminal rows may be over the cap and must be visited once. This is the only scan of
-- the table this change performs, and it runs once, at migration time — not on every call.
INSERT OR IGNORE INTO coding_terminal_dirty (session_id, marked_at)
  SELECT DISTINCT session_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM coding_timeline WHERE type = 'terminal';
