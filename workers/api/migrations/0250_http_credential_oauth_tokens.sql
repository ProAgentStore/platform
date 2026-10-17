-- OAuth2 tokens for HTTP credential profiles (#1124 — part 2 of epic #1122).
--
-- An oauth2_client_credentials or oauth2_authorization_code profile keeps its CLIENT secret in
-- http_credential_profiles.secret_*; the tokens it is issued live here, one row per profile, and every
-- token is envelope-encrypted exactly like the profile secret (encryptKey, KEY_ENCRYPTION_KEY). The
-- access token is a credential too, so it is not stored in the clear even though it expires.
--
--   access_expires_at   epoch ms, or NULL when the provider gave no expires_in.
--   refresh_*           authorization_code only: the refresh token the consent leg (or a refresh that
--                       rotated it) was issued; NULL for client_credentials, which needs none.
--
-- Deleting a profile deletes its tokens (ON DELETE CASCADE, and http-profiles.ts deletes them
-- explicitly too, because D1 does not enforce foreign keys unless the session turns them on).
CREATE TABLE IF NOT EXISTS http_credential_oauth_tokens (
  profile_id TEXT PRIMARY KEY REFERENCES http_credential_profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_ciphertext BLOB,
  access_dek BLOB,
  access_iv BLOB,
  access_expires_at INTEGER,
  refresh_ciphertext BLOB,
  refresh_dek BLOB,
  refresh_iv BLOB,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
