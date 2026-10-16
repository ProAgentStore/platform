-- #1123 (epic #1122, part 1): named HTTP credential profiles and their per-instance bindings.
--
-- A PROFILE is an owner's named secret for the generic HTTP connector: the secret envelope-
-- encrypted at rest (AES-256-GCM data key wrapped under KEY_ENCRYPTION_KEY, as user_api_keys and
-- agent_credentials are), plus non-secret metadata. A BINDING attaches a profile to ONE instance and
-- connector under a binding name — the name an agent selects it by. An instance can use a profile
-- only through a binding, and both rows carry the owner, so neither another owner nor an unbound
-- instance can reach it.
--
-- Stored but NOT acted on here (later parts of #1122 build on these columns):
--   strategy, strategy_config  — how the secret is rendered into a request (#1124). Non-secret only.
--   allowed_origins            — the origins a binding may call (#1125 enforces them).
-- No secret value, prefix, suffix or hash is stored outside the three ciphertext columns.

CREATE TABLE IF NOT EXISTS http_credential_profiles (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  strategy          TEXT NOT NULL DEFAULT 'unspecified',
  strategy_config   TEXT NOT NULL DEFAULT '{}',
  allowed_origins   TEXT NOT NULL DEFAULT '[]',
  secret_ciphertext BLOB NOT NULL,
  secret_dek        BLOB NOT NULL,
  secret_iv         BLOB NOT NULL,
  -- Incremented by each rotation, so a caller can see a rotation happened without seeing the secret.
  secret_version    INTEGER NOT NULL DEFAULT 1,
  secret_rotated_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_http_credential_profiles_user ON http_credential_profiles(user_id, name);

CREATE TABLE IF NOT EXISTS http_credential_bindings (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES http_credential_profiles(id) ON DELETE CASCADE,
  instance_id   TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector     TEXT NOT NULL DEFAULT 'http',
  binding_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(instance_id, connector, binding_name)
);
CREATE INDEX IF NOT EXISTS idx_http_credential_bindings_instance ON http_credential_bindings(instance_id, connector);
CREATE INDEX IF NOT EXISTS idx_http_credential_bindings_profile ON http_credential_bindings(profile_id);
