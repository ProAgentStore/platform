-- #1278: bounded, incremental reads of a worker-backed mailbox.
--
--   email_worker_handled   the PROCESSING CHECKPOINT: which provider message ids an instance has already handled (read in full,
--                          or replied to) on a connection. A scan skips them, so a repeated scan spends nothing on mail it
--                          already dealt with, and the id is the dedupe key (a redelivered message has the same id).
--   email_worker_run_budget  what one run has spent: summaries returned, bodies read, characters of body delivered. The limits
--                          live in code; this is the counter, so a limit holds across the separate tool calls of one run.
--
-- Neither table holds a message body, a subject or a secret: ids, counts and times only.
CREATE TABLE IF NOT EXISTS email_worker_handled (
  instance_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL,
  how TEXT NOT NULL,
  handled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (instance_id, endpoint, account_id, message_id)
);

CREATE TABLE IF NOT EXISTS email_worker_run_budget (
  instance_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  summaries INTEGER NOT NULL DEFAULT 0,
  reads INTEGER NOT NULL DEFAULT 0,
  body_chars INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (instance_id, run_key)
);
