-- Endpoint-scoped credentials for the outbound MCP connector (issue #286).
--
-- THE BUG THIS CLOSES. `connectorClient("mcp").token()` read `user_api_keys` at its primary
-- key `(user_id, provider)`, and the provider is the bare string 'mcp'. So one user had ONE
-- MCP bearer slot shared by every authenticated MCP endpoint they ever named — and the endpoint
-- is user config supplied at call time. A token issued by server A was therefore sent, verbatim,
-- to server B the moment a pipeline step or an agent reading untrusted text pointed at B. That
-- is credential disclosure to an attacker-chosen party, not a missing convenience.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not add a second identity for an MCP server. #266
-- established that a "connection" is derived from the grants held on a normalized endpoint, and
-- that health is never cached because it is a fact about now. Both still hold: `endpoint` here
-- is the SAME normalized string `instance_mcp_consent` keys on (lib/mcp-consent.ts
-- normalizeMcpEndpoint — scheme://host[:port]/path, lowercased, no trailing slash, query and
-- fragment dropped), so there is no nickname to rename and nothing that can drift from
-- enforcement. This table holds credential MATERIAL and nothing else.
--
-- Dropping the query string matters twice over here. An MCP endpoint's query routinely IS the
-- access token, so keying on the normalized form keeps a credential out of this table's key
-- column as well as out of the logs.
--
-- Encryption is the platform's existing envelope scheme, unchanged: a per-row AES-256-GCM DEK
-- wrapped with AES-KW under KEY_ENCRYPTION_KEY (lib/crypto.ts) — the same trio of columns
-- user_api_keys, agent_credentials and coding_workspaces already use. No second scheme.
CREATE TABLE IF NOT EXISTS mcp_credentials (
  user_id        TEXT NOT NULL REFERENCES users(id),
  endpoint       TEXT NOT NULL,                    -- normalized, e.g. 'https://builder.example.com/mcp'
  auth_mode      TEXT NOT NULL DEFAULT 'bearer',   -- 'bearer' today; 'oauth' when #258/#180 land
  issuer         TEXT,                             -- authorization server, when the endpoint published one
  scopes         TEXT,                             -- space-delimited, when the issuer stated them
  expires_at     TEXT,                             -- ISO-8601; NULL = does not expire on us (a pasted bearer)
  key_ciphertext BLOB NOT NULL,                    -- AES-256-GCM ciphertext of the credential
  dek_wrapped    BLOB NOT NULL,                    -- per-row DEK wrapped under the master KEK
  iv             BLOB NOT NULL,
  account_label  TEXT,                             -- non-secret display hint, e.g. the account it belongs to
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT,
  PRIMARY KEY (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_mcp_credentials_user ON mcp_credentials(user_id, updated_at DESC);

-- ── Backfill: adopt the legacy provider-wide token ONLY where its owner is unambiguous ──────
--
-- A row in `user_api_keys` at provider 'mcp' records no endpoint, so in general nothing in the
-- database says which server it belongs to. There is exactly one case where the answer is a
-- fact rather than a guess: the user's grants (`instance_mcp_consent`) name exactly ONE distinct
-- endpoint. Then the token demonstrably belongs to that server, and adopting it keeps a working
-- setup working across this deploy.
--
-- Everything else is left alone ON PURPOSE. Picking one of several endpoints would be inventing
-- the very binding whose absence is the vulnerability, and guessing wrong sends the user's token
-- to the wrong server — the exact outcome this migration exists to prevent. Those users fail
-- closed with an actionable message and can bind the same credential from the console without
-- re-typing it (lib/mcp-credentials.ts adoptLegacyMcpCredential copies the ciphertext verbatim,
-- so no plaintext is handled to move it).
--
-- The ciphertext/DEK/IV are copied as-is: same KEK, same wrapping, so this is a pure relocation
-- and nothing is decrypted to perform it.
INSERT OR IGNORE INTO mcp_credentials
  (user_id, endpoint, auth_mode, key_ciphertext, dek_wrapped, iv, account_label, created_at, updated_at)
SELECT
  k.user_id,
  (SELECT MIN(c.endpoint) FROM instance_mcp_consent c WHERE c.user_id = k.user_id),
  'bearer',
  k.key_ciphertext,
  k.dek_wrapped,
  k.iv,
  k.account_label,
  k.created_at,
  datetime('now')
FROM user_api_keys k
WHERE k.provider = 'mcp'
  AND (SELECT COUNT(DISTINCT c.endpoint) FROM instance_mcp_consent c WHERE c.user_id = k.user_id) = 1;
