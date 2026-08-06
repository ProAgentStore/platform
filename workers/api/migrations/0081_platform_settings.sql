-- 0081_platform_settings.sql — operator levers that must not need a deploy (#46).
--
-- Today the only way to stop platform-paid Workers-AI spend is to edit
-- PLATFORM_AI_ENABLED in wrangler.toml and redeploy, which is minutes of CI while the
-- spend continues. This table holds runtime OVERRIDES of deploy-time configuration:
-- a row present wins over the env var, a row absent means "the deployed config stands".
--
-- Deliberately key/value rather than one column per lever: the shape of the next lever
-- is unknown, and a settings table that needs a migration per switch is a settings
-- table nobody reaches for in an incident. Values are TEXT ("true"/"false" here) so a
-- non-boolean lever (a rate cap, a model id) needs no schema change either.
--
-- Reads are on a hot path (checked per unit of AI work), which is why this stays a
-- single-row PK lookup and is never cached: a TTL is exactly what stops a kill switch
-- from killing anything.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- who flipped it; the full record (before → after) lives in admin_audit_log
  updated_by TEXT
);
