-- SEO Auditor D1 schema
-- Per-page live state (score history, last extraction) lives in AuditStateDO.

CREATE TABLE IF NOT EXISTS sites (
  id         TEXT PRIMARY KEY,            -- nanoid
  url        TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audits (
  id           TEXT PRIMARY KEY,          -- nanoid
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  audited_at   TEXT NOT NULL DEFAULT (datetime('now')),
  score        INTEGER NOT NULL,          -- 0-100
  title        TEXT NOT NULL DEFAULT '',
  meta_desc    TEXT NOT NULL DEFAULT '',
  word_count   INTEGER NOT NULL DEFAULT 0,
  h1_count     INTEGER NOT NULL DEFAULT 0,
  images_total INTEGER NOT NULL DEFAULT 0,
  images_no_alt INTEGER NOT NULL DEFAULT 0,
  links_internal INTEGER NOT NULL DEFAULT 0,
  links_external INTEGER NOT NULL DEFAULT 0,
  has_schema   INTEGER NOT NULL DEFAULT 0, -- 1 if JSON-LD schema markup present
  recommendations TEXT NOT NULL DEFAULT '', -- AI-generated JSON array of strings
  regression   INTEGER NOT NULL DEFAULT 0  -- 1 if score dropped vs previous audit
);

CREATE INDEX IF NOT EXISTS idx_audits_site ON audits(site_id, audited_at DESC);
