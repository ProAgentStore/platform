-- #1056: owner-selected job URL intake. One durable receipt per attempt — accepted, duplicate or rejected —
-- carrying only the canonical posting URL (never the pasted one, which may hold personal tokens) or, for a
-- rejection, the reason category and host. `created` is unique per owner and canonical posting: the second
-- paste of the same job, into any of the owner's Scouts, is answered with the first one's lead.
CREATE TABLE IF NOT EXISTS job_lead_intake_receipts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  instance_id       TEXT NOT NULL REFERENCES agent_instances(id),
  canonical_url     TEXT,
  provider          TEXT,
  lead_id           TEXT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('created', 'duplicate', 'rejected')),
  rejection_reason  TEXT,
  rejection_host    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_lead_intake_created ON job_lead_intake_receipts (user_id, canonical_url) WHERE outcome = 'created';
CREATE INDEX IF NOT EXISTS idx_job_lead_intake_instance ON job_lead_intake_receipts (instance_id, created_at DESC);
