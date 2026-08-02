-- One-time authorization codes for the MCP OAuth callback (#25).
-- The MCP login used to hand the raw session token back in a URL query param (?session=),
-- where it leaks to Cloudflare request logs, Referer headers, and browser history. Instead we
-- redirect with a single-use ?code=, and the MCP worker exchanges it server-to-server for the
-- session. We store only the code's HASH (read access to this table yields nothing usable),
-- the session it maps to, and a short expiry. Rows are deleted on exchange (single-use).
CREATE TABLE IF NOT EXISTS mcp_auth_codes (
	code_hash TEXT PRIMARY KEY,
	session TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_auth_codes_expiry ON mcp_auth_codes(expires_at);
