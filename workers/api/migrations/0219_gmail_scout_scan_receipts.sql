-- #1023: one durable, non-secret receipt per Gmail Scout scan, scheduled or on demand.
--
-- `gmail_scout_scan_state` keeps only the LATEST counts and is overwritten every scan, so an owner
-- could not see what an earlier scan found, why messages were rejected, or whether a scan was the
-- schedule's or their own. A receipt records who triggered it, its outcome and counts, and the
-- rejection reasons by category — never mail content, addresses, tokens or message bodies.
-- `handoff` records that a scan hands nothing downstream: leads stay unverified until the owner
-- explicitly applies one.
CREATE TABLE IF NOT EXISTS gmail_scout_scan_receipts (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL REFERENCES agent_instances(id),
  scan_trigger     TEXT NOT NULL CHECK (scan_trigger IN ('schedule', 'on_demand')),
  triggered_by     TEXT,
  status           TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at     TEXT,
  hits             INTEGER,
  candidates       INTEGER,
  added            INTEGER,
  deduped          INTEGER,
  rejected         TEXT,
  error_message    TEXT,
  last_message_id  TEXT,
  handoff          TEXT NOT NULL DEFAULT 'none' CHECK (handoff IN ('none')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gmail_scout_scan_receipts_instance ON gmail_scout_scan_receipts(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_scout_scan_receipts_running ON gmail_scout_scan_receipts(instance_id, status);
