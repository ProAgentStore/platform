-- Credentials vault: per-instance site logins the agent can use (e.g. ATS
-- accounts). Secrets (password, PIN, recovery codes) are envelope-encrypted under
-- the master KEY_ENCRYPTION_KEY (same scheme as the AI-key vault) and never stored
-- or returned in plaintext except on an explicit owner reveal. Non-secret fields
-- (domain, login URL, username, comments, recovery history) are stored plainly.
CREATE TABLE IF NOT EXISTS agent_credentials (
  id                 TEXT PRIMARY KEY,
  instance_id        TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  domain             TEXT NOT NULL,            -- normalized host, e.g. dayforcehcm.com
  login_url          TEXT,                     -- the sign-in page URL
  username           TEXT,                     -- email / username (not a secret)
  secrets_ciphertext BLOB,                     -- AES-GCM( {password,pin,recoveryCodes} )
  secrets_dek        BLOB,                     -- data key wrapped under the master KEK
  secrets_iv         BLOB,
  comments           TEXT,
  recovery_history   TEXT,                     -- free text / JSON log of resets & recovery events
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_credentials_instance ON agent_credentials(instance_id, user_id);
CREATE INDEX IF NOT EXISTS idx_agent_credentials_domain ON agent_credentials(user_id, domain);
