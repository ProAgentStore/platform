-- #1052: an owner-selected or bounded historical reprocess of Gmail Scout mail records its own receipt,
-- distinct from the schedule's and from "Scan now". SQLite cannot widen a CHECK in place, so the
-- receipts table is rebuilt with `reprocess` added to `scan_trigger`. Nothing references this table,
-- every column and row is carried over unchanged, and both indexes are recreated.
CREATE TABLE gmail_scout_scan_receipts_new (
  id                            TEXT PRIMARY KEY,
  instance_id                   TEXT NOT NULL REFERENCES agent_instances(id),
  scan_trigger                  TEXT NOT NULL CHECK (scan_trigger IN ('schedule', 'on_demand', 'reprocess')),
  triggered_by                  TEXT,
  status                        TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at                  TEXT,
  hits                          INTEGER,
  candidates                    INTEGER,
  added                         INTEGER,
  deduped                       INTEGER,
  rejected                      TEXT,
  error_message                 TEXT,
  last_message_id               TEXT,
  handoff                       TEXT NOT NULL DEFAULT 'none' CHECK (handoff IN ('none')),
  created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  awaiting_browser_verification INTEGER
);
INSERT INTO gmail_scout_scan_receipts_new (id, instance_id, scan_trigger, triggered_by, status, started_at, completed_at, hits, candidates, added, deduped, rejected, error_message, last_message_id, handoff, created_at, awaiting_browser_verification)
  SELECT id, instance_id, scan_trigger, triggered_by, status, started_at, completed_at, hits, candidates, added, deduped, rejected, error_message, last_message_id, handoff, created_at, awaiting_browser_verification
    FROM gmail_scout_scan_receipts;
DROP TABLE gmail_scout_scan_receipts;
ALTER TABLE gmail_scout_scan_receipts_new RENAME TO gmail_scout_scan_receipts;
CREATE INDEX IF NOT EXISTS idx_gmail_scout_scan_receipts_instance ON gmail_scout_scan_receipts(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_scout_scan_receipts_running ON gmail_scout_scan_receipts(instance_id, status);
