-- Metadata tables for the data-analyst agent.
-- Actual user data lands in dynamically-created tables (one per upload).

-- Registry of uploaded datasets
CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,              -- friendly name supplied at upload
  table_name  TEXT NOT NULL UNIQUE,       -- sanitised SQL table name
  source_type TEXT NOT NULL DEFAULT 'csv', -- 'csv' | 'json'
  row_count   INTEGER NOT NULL DEFAULT 0,
  columns     TEXT NOT NULL,              -- JSON array: [{name, type}]
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_datasets_uploaded ON datasets(uploaded_at DESC);

-- Query history (natural language + generated SQL + result preview)
CREATE TABLE IF NOT EXISTS query_history (
  id          TEXT PRIMARY KEY,
  dataset_id  TEXT REFERENCES datasets(id) ON DELETE SET NULL,
  question    TEXT NOT NULL,
  sql         TEXT NOT NULL,
  row_count   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,                       -- NULL on success
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_executed ON query_history(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_dataset  ON query_history(dataset_id, executed_at DESC);
