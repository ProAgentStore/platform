-- #1336: a persistent, atomic per-issue attempt counter, keyed by owner + canonical repo + issue so it holds across every
-- instance that works the repo, and the quarantine that follows from it.
--
-- `issue_attempts` has one row per DISTINCT unsuccessful attempt. `attempt_key` is the attempt's own identity
-- (`entry:<queue entry>` for an admission failure that never became a run, `run:<run>` for a run that ended unsuccessfully),
-- and UNIQUE(user_id, attempt_key) makes a replayed event, a retried step or a second wake a no-op: it cannot count twice.
-- Deferrals, polling and duplicate receipts are never rows here.
--
-- `issue_quarantine` holds at most one row per issue. `floor_attempt_id` is the reset: only attempts with a larger id count,
-- and it moves only on a verified success or an explicit owner release. Nothing expires. The row flips to 'quarantined' in ONE
-- conditional statement that fires only when the count reaches the threshold, so exactly one writer opens the incident.
CREATE TABLE issue_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  attempt_key TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('admission_failed', 'run_unsuccessful')),
  reason TEXT,
  queue_entry_id TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, attempt_key)
);
CREATE INDEX idx_issue_attempts_issue ON issue_attempts(user_id, github_repo, issue_number, id);

CREATE TABLE issue_quarantine (
  user_id TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('quarantined', 'released')),
  threshold INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  incident_id TEXT,
  opened_at INTEGER,
  floor_attempt_id INTEGER NOT NULL DEFAULT 0,
  released_at INTEGER,
  released_by TEXT,
  release_reason TEXT,
  PRIMARY KEY (user_id, github_repo, issue_number)
);
