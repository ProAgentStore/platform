-- Site monitoring history stored in D1
-- Per-site state (current hash, last check) lives in Durable Objects

CREATE TABLE IF NOT EXISTS sites (
  id          TEXT PRIMARY KEY,           -- nanoid
  url         TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  webhook_url TEXT,                        -- per-site override; falls back to global
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS change_history (
  id          TEXT PRIMARY KEY,           -- nanoid
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  old_hash    TEXT NOT NULL,
  new_hash    TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',   -- short human-readable diff summary
  content_len INTEGER NOT NULL DEFAULT 0  -- byte length of new content
);

CREATE INDEX IF NOT EXISTS idx_history_site ON change_history(site_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default global webhook (empty until set via API)
INSERT OR IGNORE INTO config(key, value) VALUES ('webhook_url', '');
