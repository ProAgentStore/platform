-- #1030: Gmail job leads the server could not check are verified in a browser, not thrown away.
--
-- A scan that resolves a provider alert to ONE canonical posting but cannot check the page (blocked,
-- no structured posting) stores the lead `awaiting_browser_verification`. The dispatcher hands the
-- CANONICAL job identity — never the personalised alert URL — to the Scout's own browser and records
-- every attempt here. `canonical_url` carries only the posting id; alert tokens never reach this table.

ALTER TABLE gmail_scout_scan_receipts ADD COLUMN awaiting_browser_verification INTEGER;

-- One row per lead: the queue and its current state.
CREATE TABLE IF NOT EXISTS job_lead_browser_verifications (
  instance_id      TEXT NOT NULL REFERENCES agent_instances(id),
  lead_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id),
  work_key         TEXT,
  canonical_url    TEXT NOT NULL,
  expected_title   TEXT,
  expected_company TEXT,
  -- awaiting: due for an attempt; dispatched: a browser run is checking it; the rest are final.
  -- superseded: the owner moved the lead on first, so a late outcome was recorded but not applied.
  state            TEXT NOT NULL CHECK (state IN ('awaiting', 'dispatched', 'active', 'expired', 'mismatch', 'unverifiable', 'superseded')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  awaiting_since   INTEGER NOT NULL,
  last_outcome     TEXT,
  last_detail      TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (instance_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_job_lead_bv_due ON job_lead_browser_verifications(state, next_attempt_at);

-- One row per attempt: the auditable receipt of what was dispatched and what came back.
CREATE TABLE IF NOT EXISTS job_lead_browser_verification_attempts (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES agent_instances(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  lead_id      TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  run_id       TEXT,
  state        TEXT NOT NULL CHECK (state IN ('dispatched', 'completed', 'no_runtime', 'refused')),
  outcome      TEXT CHECK (outcome IS NULL OR outcome IN ('active', 'expired', 'mismatch', 'temporarily_unverifiable')),
  detail       TEXT,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_job_lead_bv_attempts ON job_lead_browser_verification_attempts(instance_id, lead_id, attempt);
CREATE INDEX IF NOT EXISTS idx_job_lead_bv_inflight ON job_lead_browser_verification_attempts(state, created_at);
