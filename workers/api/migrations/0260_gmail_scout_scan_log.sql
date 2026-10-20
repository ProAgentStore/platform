-- #1247: a per-item decision log for every Gmail Scout scan.
--
-- A receipt (0219, #1023) counts rejections by category and nothing else, so ten scans in a row could
-- report `rejected: {digest: N}` and the owner could not check a single one of those decisions: no
-- sender, no subject, no link to the email. This records, per scan, the exact Gmail query and window it
-- searched, and per message what it read, what it took the message for, what it decided and why. A
-- digest's jobs are logged one row each (`sub_index` 1..n under the message's row, which has NULL).
--
-- Metadata and short snippets only: sender, subject, date, Gmail's own snippet clipped to 500 chars,
-- counts of what was read, and canonical posting URLs (personal tracking parameters never stored). No
-- message body. Rows older than 30 days are pruned; receipts are kept at least as long (receipts.ts).
ALTER TABLE gmail_scout_scan_receipts ADD COLUMN search_query TEXT;
ALTER TABLE gmail_scout_scan_receipts ADD COLUMN search_window TEXT;

CREATE TABLE IF NOT EXISTS gmail_scout_scan_log_items (
  id              TEXT PRIMARY KEY,
  receipt_id      TEXT NOT NULL,
  instance_id     TEXT NOT NULL REFERENCES agent_instances(id),
  seq             INTEGER NOT NULL,
  sub_index       INTEGER,
  message_id      TEXT,
  thread_id       TEXT,
  gmail_link      TEXT,
  sender          TEXT,
  subject         TEXT,
  received_at     TEXT,
  snippet         TEXT,
  read_summary    TEXT,
  classification  TEXT NOT NULL,
  evidence        TEXT,
  decision        TEXT NOT NULL CHECK (decision IN ('added', 'awaiting_browser_verification', 'deduped', 'rejected')),
  rejection       TEXT,
  reason          TEXT NOT NULL,
  lead_id         TEXT,
  job_title       TEXT,
  job_company     TEXT,
  job_url         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gmail_scout_scan_log_receipt ON gmail_scout_scan_log_items(receipt_id, seq, sub_index);
CREATE INDEX IF NOT EXISTS idx_gmail_scout_scan_log_created ON gmail_scout_scan_log_items(created_at);
