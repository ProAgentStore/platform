-- #1088: one receipt per browser error event id, so a browser that retries a report it already
-- delivered (the answer was lost, a reload replayed its outbox, two tabs share one outbox) writes ONE
-- occurrence, not two. Anonymous reports carry no user, so the id alone is the key; ids are random
-- UUIDs minted by the reporting tab. Aged out with error_log's 30-day retention by the route.
CREATE TABLE IF NOT EXISTS client_error_receipts (
  report_id   TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
