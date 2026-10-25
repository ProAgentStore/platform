-- #1195: re-redact the terminal text the platform already stored.
--
-- #1166 made the runner mask a pane before it leaves the machine, and #1195 makes the platform mask what it takes in; neither
-- reaches rows written before. `redactStoredPanes` (lib/pane-redaction-sweep.ts) walks the three places that hold terminal
-- text — terminal_history, the coding timeline's terminal / command rows and error_log — in bounded batches from the cron, and
-- rewrites a row only if masking changes it. This table is its place: the highest rowid it has processed per source, so a tick
-- picks up where the last stopped and a finished walk costs one cheap query. New rows are masked as they are written, so catching
-- up to the table's end is all there is to do.
CREATE TABLE pane_redaction_progress (
  source       TEXT PRIMARY KEY,
  last_rowid   INTEGER NOT NULL DEFAULT 0,
  rows_changed INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
