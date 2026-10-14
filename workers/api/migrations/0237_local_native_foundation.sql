-- #1057 slice 1: the foundation for the `local_native` runtime (native desktop + Maestro).
--
-- 1. Per-MACHINE owner opt-in, OFF by default, on the existing per-(owner, machine) policy row
--    (`machine_policies`, 0199). Desktop and Maestro are separate switches: screen control acts as
--    the owner across everything on that machine, so it is a decision about the machine, not about
--    one agent. Turning either on requires the owner to acknowledge the account-risk disclosure
--    (lib/native/policy.ts, NATIVE_RISK_DISCLOSURE_V1 — e.g. WeChat bans automated accounts); the
--    version they acknowledged is recorded, so a revised disclosure can require a new one.
-- 2. The run and event tables later slices will write. Slice 1 drives nothing, so nothing writes
--    them yet; they exist so the shape is reviewed once and cascaded with the instance from day one.

ALTER TABLE machine_policies ADD COLUMN native_desktop_enabled INTEGER NOT NULL DEFAULT 0 CHECK (native_desktop_enabled IN (0, 1));
ALTER TABLE machine_policies ADD COLUMN native_maestro_enabled INTEGER NOT NULL DEFAULT 0 CHECK (native_maestro_enabled IN (0, 1));
ALTER TABLE machine_policies ADD COLUMN native_risk_disclosure_version TEXT;
ALTER TABLE machine_policies ADD COLUMN native_opted_in_at INTEGER;

CREATE TABLE IF NOT EXISTS native_runs (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  machine_id  TEXT,
  backend     TEXT NOT NULL CHECK (backend IN ('desktop', 'maestro')),
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  -- NativeRunConfig (contract.ts): backend, targetApp, readOnly. Never screen content.
  config      TEXT NOT NULL DEFAULT '{}',
  error_code  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_native_runs_instance ON native_runs(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_native_runs_owner_status ON native_runs(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS native_run_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES native_runs(id),
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  -- Metadata only (ids, codes, counts) — never screen text, message content or credentials.
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_native_run_events_instance ON native_run_events(instance_id, created_at DESC);
