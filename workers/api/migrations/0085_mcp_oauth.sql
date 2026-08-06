-- DCR + PKCE OAuth for user-named MCP endpoints (issues #180, #258).
--
-- WHAT WAS MISSING. #286 (migration 0083) gave credential MATERIAL a home keyed on the
-- normalized endpoint; nothing could FILL it except a human pasting a bearer token. Every modern
-- MCP server is a public OAuth client: PKCE S256, `token_endpoint_auth_method: "none"`, and a
-- client registered at runtime (RFC 7591) because the operator has never heard of the server the
-- subscriber just named. So there was no value that could go in a manifest's `secretRef`, and the
-- platform's answer to its first user-named endpoint was the one thing those servers document as
-- "do not do": ask the user to paste an access token.
--
-- WHY NOW, WHEN THIS WAS DEFERRED. It was deferred because the only verified target advertised
-- `grant_types_supported: ["authorization_code"]` — no refresh grant, so a completed flow bought a
-- credential that dies every 24h and cannot drive a cron-fired chain. That reasoning was about
-- THAT server. Our own MCP server (mcp.proagentstore.online, workers-oauth-provider) advertises
-- `["authorization_code","refresh_token"]`, S256, and a `/register` endpoint that issues a public
-- client — i.e. `unattendedFromGrantTypes` classifies it `refresh`, the class #181 says is safe to
-- wire. Verified live against the deployed metadata before this migration was written.
--
-- THREE PIECES, AND WHY EACH IS SEPARATE FROM THE OTHERS ─────────────────────────────────────

-- 1. The client registration (RFC 7591), cached per (user, authorization server).
--
-- A `client_id` is only meaningful at the server that ISSUED it, so the cache key is the issuer,
-- not the resource: two MCP endpoints fronted by one authorization server correctly share one
-- registration, and a registration can never be replayed at a server that never minted it. Per
-- USER rather than per deployment because a registration is the thing a server can rate-limit,
-- revoke, or attribute — one account's revoked client must not disable everyone else's.
--
-- The secret is nullable ON PURPOSE: a public client has none, which is the case this whole
-- feature exists for. When a server does return one it is envelope-encrypted like everything
-- else (AES-256-GCM DEK wrapped with AES-KW under KEY_ENCRYPTION_KEY, lib/crypto.ts) — no second
-- scheme, and no reveal route, because a client secret has no client-side use.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  user_id           TEXT NOT NULL REFERENCES users(id),
  issuer            TEXT NOT NULL,   -- authorization server origin, exactly as discovered
  client_id         TEXT NOT NULL,
  redirect_uri      TEXT NOT NULL,   -- what we registered; the token exchange must repeat it
  secret_ciphertext BLOB,            -- NULL for a public client (the normal case)
  secret_dek_wrapped BLOB,
  secret_iv         BLOB,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, issuer)
);

-- 2. The in-flight authorization, one row per started flow.
--
-- The PKCE verifier CANNOT live in the signed `state`: state travels through the authorization
-- server's URL bar, and a verifier the server can read is a verifier that proves nothing. So the
-- state carries only a random flow id (plus its pins) and the secret half stays here, encrypted.
--
-- Everything the callback needs to complete the exchange is recorded HERE, at start time, from
-- metadata we discovered ourselves: token endpoint, client id, redirect uri, the resource. The
-- callback reads none of it from its own query string. That is what makes a callback — which is
-- unauthenticated by construction, arriving as a top-level navigation from a party we do not
-- control — unable to redirect the exchange at a server of the caller's choosing.
--
-- Rows are single-use (claimed with a DELETE … RETURNING) and expire; a flow left unfinished is
-- garbage collected by the same claim path plus the per-minute cron's sweep.
CREATE TABLE IF NOT EXISTS mcp_oauth_flows (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  endpoint           TEXT NOT NULL,  -- the normalized MCP resource this flow is FOR
  issuer             TEXT NOT NULL,
  token_endpoint     TEXT NOT NULL,
  client_id          TEXT NOT NULL,
  redirect_uri       TEXT NOT NULL,
  scope              TEXT,
  verifier_ciphertext BLOB NOT NULL,
  verifier_dek_wrapped BLOB NOT NULL,
  verifier_iv        BLOB NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_flows_expiry ON mcp_oauth_flows(expires_at);

-- 3. What an OAuth credential needs that a pasted bearer did not.
--
-- `mcp_credentials` already carries auth_mode/issuer/scopes/expires_at (0083 added them for
-- exactly this). Two things were still missing, and without them an expiring credential is a
-- credential that dies:
--
--   • the refresh token — a SECOND envelope in the same row rather than a second table, because
--     it belongs to the same (user, endpoint) fact and must be deleted with it. Same scheme,
--     separate DEK: the access token is handed to `Authorization` headers constantly and the
--     refresh token never leaves the refresh call, so they do not share a key.
--   • the token endpoint — so a 3am refresh is one POST rather than a re-run of the whole
--     discovery chain against a server that may be down for an unrelated reason.
ALTER TABLE mcp_credentials ADD COLUMN token_endpoint TEXT;
ALTER TABLE mcp_credentials ADD COLUMN refresh_ciphertext BLOB;
ALTER TABLE mcp_credentials ADD COLUMN refresh_dek_wrapped BLOB;
ALTER TABLE mcp_credentials ADD COLUMN refresh_iv BLOB;
