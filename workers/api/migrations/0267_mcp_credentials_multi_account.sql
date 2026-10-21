-- Labelled accounts per MCP endpoint (#1267).
--
-- THE GAP THIS CLOSES. `mcp_credentials` has been `PRIMARY KEY (user_id, endpoint)` since 0083,
-- which closed the credential-disclosure bug (one 'mcp' vault slot shared by every endpoint) but
-- left exactly the limit 0135 fixed for `user_api_keys` at the SAME time last touched this file:
-- one credential per endpoint, full stop. An owner who wants to connect one MCP server as two
-- different accounts (Hiring Comms as admin@freeappstore.online, a second agent as another
-- account) cannot — storing the second overwrites the first, silently, because `ON CONFLICT
-- (user_id, endpoint) DO UPDATE` is exactly as destructive to a second account as it was
-- protective against a different endpoint.
--
-- THE FIX IS THE SAME SHAPE AS 0135, ONE COLUMN OVER. `account_id` joins the primary key, exactly
-- as it joined `user_api_keys`'s. SQLite cannot alter a primary key in place, so this is the same
-- rebuild: create, copy, drop, rename. Nothing is re-encrypted — the four ciphertext columns
-- (access token + refresh token, each with its own wrapped DEK and IV) are copied byte-for-byte,
-- so this migration never needs KEY_ENCRYPTION_KEY and cannot invalidate a stored credential.
--
-- THE DEFAULT ID IS '', not a generated one, for the reason 0135 gives: '' is the reserved
-- "unnamed account" identifier every caller that has not been made account-aware still asks for.
-- Every row that exists today backfills to account_id = '', so AC4 ("existing single credentials
-- keep working after the migration") is true by construction — the primary key widens but every
-- existing lookup at (user_id, endpoint, '') still finds its row.
CREATE TABLE mcp_credentials_new (
  user_id             TEXT NOT NULL REFERENCES users(id),
  endpoint            TEXT NOT NULL,
  -- '' = the unnamed default account. Non-empty = an id the owner chose when connecting a second
  -- (or later) account on the same endpoint — there is no provider-issued identity to promote the
  -- way Google's mailbox address was for 0135, since a generic MCP server states no identity.
  account_id          TEXT NOT NULL DEFAULT '',
  auth_mode           TEXT NOT NULL DEFAULT 'bearer',
  issuer              TEXT,
  scopes              TEXT,
  expires_at          TEXT,
  key_ciphertext      BLOB NOT NULL,
  dek_wrapped         BLOB NOT NULL,
  iv                  BLOB NOT NULL,
  account_label       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at        TEXT,
  token_endpoint      TEXT,
  refresh_ciphertext  BLOB,
  refresh_dek_wrapped BLOB,
  refresh_iv          BLOB,
  PRIMARY KEY (user_id, endpoint, account_id)
);

INSERT INTO mcp_credentials_new (
  user_id, endpoint, account_id, auth_mode, issuer, scopes, expires_at,
  key_ciphertext, dek_wrapped, iv, account_label, created_at, updated_at, last_used_at,
  token_endpoint, refresh_ciphertext, refresh_dek_wrapped, refresh_iv
)
SELECT
  user_id, endpoint, '', auth_mode, issuer, scopes, expires_at,
  key_ciphertext, dek_wrapped, iv, account_label, created_at, updated_at, last_used_at,
  token_endpoint, refresh_ciphertext, refresh_dek_wrapped, refresh_iv
FROM mcp_credentials;

DROP TABLE mcp_credentials;
ALTER TABLE mcp_credentials_new RENAME TO mcp_credentials;

CREATE INDEX IF NOT EXISTS idx_mcp_credentials_user ON mcp_credentials(user_id, updated_at DESC);
-- Listing every account on one endpoint is now a real query (the console's account list, the
-- resolver's ambiguity check) rather than a point lookup, so it gets its own index.
CREATE INDEX IF NOT EXISTS idx_mcp_credentials_endpoint ON mcp_credentials(user_id, endpoint);

-- The in-flight OAuth flow needs to carry WHICH account it is authorizing, so `completeFlow` can
-- save the credential under the account the owner chose when starting the flow rather than always
-- the unnamed default. No primary-key change here: a flow is looked up by its own id, never by
-- account, so a plain ALTER COLUMN is enough.
ALTER TABLE mcp_oauth_flows ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
