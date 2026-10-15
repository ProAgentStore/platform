-- Runner crash reports delivered by the CLI (#1087).
--
-- The local runtime and the CLI that supervises it keep each crash on disk (bounded, sanitized,
-- atomically written) until the CLI — the process that holds the account token — delivers it here.
-- Delivery is AT LEAST ONCE: a report is re-sent after an offline stretch or a restart until the
-- CLI has seen it accepted. This table is what makes that idempotent: one row per (user, report
-- id), `INSERT OR IGNORE`, and only a report that is new here is written to `error_log` — where
-- MCP `list_errors(source: "runner-crash")` reads it.
--
-- It holds the id and the receipt time only. The report's content lives in its `error_log` row,
-- with that table's retention (30 days); a receipt older than that is pruned with it.
CREATE TABLE IF NOT EXISTS runner_crash_reports (
  user_id     TEXT NOT NULL,
  report_id   TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, report_id)
);
CREATE INDEX IF NOT EXISTS idx_runner_crash_reports_received ON runner_crash_reports(received_at);
