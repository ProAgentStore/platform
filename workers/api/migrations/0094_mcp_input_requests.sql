-- Pending user-input requests for the outbound MCP connector (issue #264).
--
-- WHAT PAUSES HERE. A remote MCP server that needs something more from the person sends an
-- `elicitation/create` request instead of answering `tools/call`. This client is strictly
-- request/response over one POST, so it cannot answer that request in band — and the human takes
-- minutes, which no Worker request may wait for. So the call PAUSES: the ask is parsed, one row
-- lands here, the console renders it, and answering RETRIES the original call with the values
-- merged into the remote tool's arguments (lib/mcp-elicitation.ts explains why a retry rather than
-- an in-band answer, and what that costs).
--
-- WHY THE ARGUMENTS ARE ENCRYPTED. To retry a call we have to remember it, and the thing worth
-- remembering is `args` — the arbitrary input of an arbitrary remote tool, which is the most
-- PII-dense thing this connector ever touches. `agent_events` deliberately records argument KEY
-- NAMES and byte counts and never values (#265); a pending-call table holding those same values in
-- clear would quietly undo that rule and be the one place the connector finally writes a user's
-- data down. So the call payload is envelope-encrypted with the platform's existing scheme — a
-- per-row AES-256-GCM DEK wrapped with AES-KW under KEY_ENCRYPTION_KEY (lib/crypto.ts), the same
-- trio of columns user_api_keys, agent_credentials, coding_workspaces and mcp_credentials use. No
-- second scheme, and no plaintext column anyone can accidentally SELECT into a log.
--
-- THE ANSWER IS NOT STORED AT ALL. There is no column for it, on purpose. The user's values arrive
-- on the resume request, are validated, merged, dispatched, and the row is closed in that same
-- handler; the ciphertext is dropped at the same moment. An elicited value is more likely to be a
-- password than an ordinary argument is, so the shortest life it can have is the right one.
--
-- WHAT IS DELIBERATELY IN CLEAR. `message` and `schema_json` — the server's prompt and the field
-- NAMES/types it asked for. Both must be rendered to a human before anything is collected, so they
-- cannot be encrypted without decrypting them on every list. Neither carries a user value; the
-- message is run through redactText on the way in, because a server that echoes our Authorization
-- header into its prompt must not put it here.
--
-- NOT A SECOND HANDOFF MACHINE. The apply pipeline's ask-and-hold (browserHandoff/browserResume,
-- reason `needs_input`) solves this shape already, but it lives on the local browser-runner: its
-- pending state is held by a machine running `pags up`, and an outbound MCP call is CLOUD-ONLY —
-- a pipeline agent with no runner is exactly the caller that needs this. So the pattern is reused
-- (one pending record, a console surface, an answer route, a resume that re-enters the same guarded
-- path) and the storage is the one thing that could not be.
--
-- `endpoint` is the normalized form (scheme://host[:port]/path, lowercased, no trailing slash,
-- query and fragment dropped — lib/mcp-consent.ts normalizeMcpEndpoint), the SAME string consent
-- keys on, credentials key on and the trace records, so a resume re-checks the very grants the
-- original call was refused or allowed by, and no credential-bearing query string lands here.
CREATE TABLE IF NOT EXISTS mcp_input_requests (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL REFERENCES agent_instances(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  endpoint       TEXT NOT NULL,                    -- normalized MCP endpoint
  tool           TEXT NOT NULL,                    -- the remote tool whose call is paused
  trace_id       TEXT,                             -- the run this call belongs to, preserved across the resume
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | answered | cancelled | expired
  round          INTEGER NOT NULL DEFAULT 1,       -- which ask this is for one logical call (bounded)
  message        TEXT NOT NULL,                    -- the server's prompt, redacted, shown to the human
  schema_json    TEXT NOT NULL,                    -- parsed field list: names/types/labels, never values
  use_auth       INTEGER NOT NULL DEFAULT 1,       -- whether the paused call sent the endpoint's credential
  call_ciphertext BLOB,                            -- AES-256-GCM ciphertext of the paused call's arguments
  dek_wrapped    BLOB,                             -- per-row DEK wrapped under the master KEK
  iv             BLOB,
  expires_at     TEXT NOT NULL,                    -- ISO-8601; past this the answer is refused
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT
);

-- The console's list query: one instance's pending asks, newest first.
CREATE INDEX IF NOT EXISTS idx_mcp_input_requests_instance ON mcp_input_requests(instance_id, status, created_at DESC);
-- The sweeper's query: everything past its deadline, whoever owns it.
CREATE INDEX IF NOT EXISTS idx_mcp_input_requests_expiry ON mcp_input_requests(status, expires_at);
