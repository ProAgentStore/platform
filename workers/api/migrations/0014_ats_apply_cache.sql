-- Per-ATS apply cache: remembers the action path that successfully submitted an
-- application on a given ATS host, so the brain replays the known-good route on
-- the next application to the same system (JSW's get-last-run pattern).
CREATE TABLE IF NOT EXISTS ats_apply_cache (
  user_id    TEXT NOT NULL,
  host       TEXT NOT NULL,
  notes      TEXT NOT NULL,
  steps      INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, host)
);
