-- Local CLI browser research (#945, epic #943): the durable run, its trace, and per-domain consent.
--
-- A general agent hands a browser-research objective to a Codex or Claude Code CLI signed in on
-- the owner's machine. These tables are deliberately independent of `coding_sessions` /
-- `coding_timeline` (no repository, no terminal) and of `instance_connector_consent` /
-- `instance_mcp_consent` (those gate a connector's WRITES; this gates NAVIGATING to a domain).
--
-- Instance settings are NOT a table: they live at `agent_instances.config.localBrowser`, beside
-- the `config.runnerNode` pin they depend on, like every other per-instance choice.

CREATE TABLE IF NOT EXISTS local_browser_runs (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL REFERENCES agent_instances(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  -- The caller's idempotency key: a retried start with the same key returns the same run.
  request_id     TEXT NOT NULL,
  objective      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  -- Set while paused: login_required | captcha | consent_required | access_blocked | paywall | write_affordance.
  pause_reason   TEXT,
  -- Why a run failed, as a code a console can act on (runner_offline, runner_unsupported, …).
  error_code     TEXT,
  error          TEXT,
  -- The effective policy the run was started with (engine, auth mode, limits, domains). No secrets.
  policy         TEXT NOT NULL,
  -- The validated result envelope, once the runner reports one.
  result         TEXT,
  engine_auth    TEXT,
  runner_node    TEXT,
  runner_task_id TEXT,
  created_at     INTEGER NOT NULL, -- ms epoch
  started_at     INTEGER,
  ended_at       INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_browser_runs_request ON local_browser_runs(instance_id, request_id);
CREATE INDEX IF NOT EXISTS idx_local_browser_runs_instance ON local_browser_runs(instance_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_browser_runs_active ON local_browser_runs(instance_id, status);

CREATE TABLE IF NOT EXISTS local_browser_run_events (
  run_id      TEXT NOT NULL REFERENCES local_browser_runs(id),
  seq         INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  url         TEXT,
  domain      TEXT,
  pause_reason TEXT,
  consent_id  TEXT,
  -- Redacted on both sides of the relay (contract.ts `redactDetail`): no cookie, password, form value or key.
  detail      TEXT,
  at          TEXT NOT NULL,      -- the reporter's ISO time
  recorded_at INTEGER NOT NULL,   -- ms epoch, PAGS clock
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS local_browser_domain_consent (
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  -- A hostname (covers its subdomains), or '*' for the signed-in-profile decision.
  domain      TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('navigate', 'signed_in_profile')),
  decision    TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  decided_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  PRIMARY KEY (instance_id, domain, scope)
);
