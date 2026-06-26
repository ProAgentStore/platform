-- Coding workspaces: the AgentCoder control-plane modelled on PAGS primitives.
--
-- A "workspace" IS an agent_instance (no separate table) — the Coding Orchestrator
-- agent's instance is the workspace. Repos and coding sessions hang off the
-- instance. The live terminal buffer / session status lives in the instance's
-- AgentDO (broadcast over WebSocket); D1 holds the durable registry so the
-- console, MCP, and audit still work when the local runner is stopped.
--
-- Mirrors the instance_runtimes (0011) / instance_runtime_tasks (0012) shape:
-- TEXT ids, JSON-as-TEXT, datetime('now') stamps, (user_id) + (status,updated_at)
-- indexes. The coding runtime registers itself through the SAME instance_runtimes
-- table with a `coding.sessions` capability — no new runtime table needed.

-- A git repo imported into a workspace (one coding agent per repo).
CREATE TABLE coding_repos (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL REFERENCES agent_instances(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,                       -- display name / folder name
  github_repo   TEXT,                                -- "owner/repo" when imported from GitHub
  clone_url     TEXT,                                -- https/ssh clone URL
  branch        TEXT NOT NULL DEFAULT '',            -- checked-out branch ('' = default)
  workdir       TEXT,                                -- absolute path on the runner machine
  clone_status  TEXT NOT NULL DEFAULT 'unknown',     -- unknown, cloning, ready, missing_url, error
  clone_error   TEXT,
  default_client TEXT NOT NULL DEFAULT 'claude',     -- claude, gemini, codex, grok
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coding_repos_instance ON coding_repos(instance_id, updated_at);
CREATE INDEX idx_coding_repos_user ON coding_repos(user_id);

-- One AI-coding-CLI session against a repo. The tmux pane + streamed output live
-- on the runner and in the DO; this row is the durable record + board entry.
CREATE TABLE coding_sessions (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL REFERENCES agent_instances(id),
  repo_id       TEXT NOT NULL REFERENCES coding_repos(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  client_type   TEXT NOT NULL DEFAULT 'claude',      -- claude, gemini, codex, grok
  status        TEXT NOT NULL DEFAULT 'active',       -- active, ended, error
  tmux_session  TEXT,                                 -- runner-side tmux session name
  issue_number  INTEGER,                              -- GitHub issue this session works on
  issue_title   TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coding_sessions_instance ON coding_sessions(instance_id, updated_at);
CREATE INDEX idx_coding_sessions_repo ON coding_sessions(repo_id, updated_at);
CREATE INDEX idx_coding_sessions_user ON coding_sessions(user_id);
CREATE INDEX idx_coding_sessions_status ON coding_sessions(status, updated_at);

-- GitHub App installations granting a user repo access. The short-lived
-- installation token is envelope-encrypted under the master KEY_ENCRYPTION_KEY,
-- same trio scheme as agent_credentials (0015) / user_api_keys.
CREATE TABLE github_installations (
  id                 TEXT PRIMARY KEY,                -- our row id
  user_id            TEXT NOT NULL REFERENCES users(id),
  installation_id    INTEGER NOT NULL,               -- GitHub's installation id
  account_login      TEXT NOT NULL DEFAULT '',       -- org/user the app is installed on
  account_type       TEXT NOT NULL DEFAULT '',       -- User, Organization
  token_ciphertext   BLOB,                           -- AES-GCM(installation access token)
  token_dek          BLOB,                           -- data key wrapped under the master KEK
  token_iv           BLOB,
  token_expires_at   TEXT,                           -- installation token expiry (1h)
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, installation_id)
);

CREATE INDEX idx_github_installations_user ON github_installations(user_id);
