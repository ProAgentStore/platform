-- User API Key Vault: encrypted per-user API keys for AI providers.
-- Vendored from FAGS pattern (AES-256-GCM envelope encryption).
-- Agents call external AI APIs (OpenAI, Anthropic, etc.) via proxy
-- which decrypts and injects the user's key at request time.

CREATE TABLE user_api_keys (
  user_id        TEXT NOT NULL,
  provider       TEXT NOT NULL,        -- openai, anthropic, google, groq, etc.
  key_ciphertext BLOB NOT NULL,        -- AES-256-GCM encrypted API key
  dek_wrapped    BLOB NOT NULL,        -- per-row DEK wrapped under master KEK
  iv             BLOB NOT NULL,        -- AES initialization vector
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE proxy_usage (
  user_id TEXT NOT NULL,
  hour    TEXT NOT NULL,               -- '2026-06-06T14' format
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
