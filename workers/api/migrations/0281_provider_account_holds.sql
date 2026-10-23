-- #1314: automatic starts wait for the exact provider credential that was refused. Replacing a
-- key is a different identity; successful verification clears only the credential it actually used.
CREATE TABLE provider_account_holds (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'cloudflare')),
  credential_id TEXT NOT NULL,
  failure_class TEXT NOT NULL CHECK (failure_class IN ('provider_credit', 'provider_credentials')),
  failed_at INTEGER NOT NULL,
  cleared_at INTEGER,
  notice_at INTEGER,
  PRIMARY KEY (user_id, provider, credential_id)
);
