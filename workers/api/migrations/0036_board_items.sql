-- Durable overlay for the single agent work board.
--
-- A board card is one JOB (runtime-task retries of the same job collapse into it).
-- Almost everything about a card — title, status, attempts — is derived from the
-- runtime tasks at read time. This table only persists what the automation can't
-- know: the human's status override (moving a card into Interview / Offer /
-- Rejected, columns the runner never sets). One row per (instance, user, job).
CREATE TABLE IF NOT EXISTS board_items (
  instance_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  job_key     TEXT NOT NULL,
  user_status TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, user_id, job_key)
);

CREATE INDEX IF NOT EXISTS idx_board_items_instance
  ON board_items (instance_id, user_id);
