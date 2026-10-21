-- Worker-backed email connector (#1269): a customer-owned HTTPS Worker stands in for a
-- Google mailbox when there is none to OAuth against (FreeAppStore mail is Cloudflare Email
-- Routing + a Worker, not Gmail). The owner pastes a bearer secret for THEIR worker instead of
-- signing in anywhere, so this is bearer credential storage, never OAuth.
--
-- SHAPE MIRRORS mcp_credentials (#1267), not user_api_keys, for the reason recorded there: the
-- "provider" dimension here is a user-supplied endpoint (which worker), not a fixed id, so a
-- single `(user_id, provider)` vault slot would let a credential meant for one worker reach
-- whichever worker a later call happened to name. `account_id` joins the key for the same
-- reason it does on mcp_credentials: one worker endpoint may be connected more than once (e.g.
-- two mailboxes behind one Worker), and '' is the reserved "the only account on this endpoint"
-- id so a single connection needs no choice recorded anywhere.
--
-- `webhook_token` is a SEPARATE high-entropy capability token (like agent_triggers.secret_token)
-- that the owner configures into their own Worker as the inbound delivery URL. It is
-- deliberately not the bearer secret: the secret authenticates PAGS→Worker calls and must never
-- appear in a URL (logs, browser history, a copy-pasted Slack message); the webhook token
-- authenticates Worker→PAGS calls and IS a URL on purpose, exactly like a trigger's webhook.
-- UNIQUE because the inbound route looks a connection up BY it, with no other credential.
CREATE TABLE IF NOT EXISTS email_worker_connections (
  user_id             TEXT NOT NULL REFERENCES users(id),
  endpoint            TEXT NOT NULL,
  account_id          TEXT NOT NULL DEFAULT '',
  secret_ciphertext   BLOB NOT NULL,
  secret_dek_wrapped  BLOB NOT NULL,
  secret_iv           BLOB NOT NULL,
  account_label       TEXT,
  -- Recorded from the adapter's own `/v1/identity` response at connect/test time (#1269 AC1) —
  -- never asserted by the owner, so the console can show what the Worker actually claims to speak.
  contract_version    TEXT,
  webhook_token       TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, endpoint, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_worker_connections_webhook_token
  ON email_worker_connections(webhook_token);

CREATE INDEX IF NOT EXISTS idx_email_worker_connections_user
  ON email_worker_connections(user_id, updated_at DESC);

-- Inbound-event dedupe (#1269 AC5): the adapter's OWN event id, scoped to the connection it
-- arrived on. A Worker retrying a delivery (its own backoff, or a double-send bug) must not
-- produce two audit receipts or fire anything twice; `INSERT OR IGNORE` on this key is the whole
-- de-dup, and the row carries nothing but the id — the audit receipt itself lives in
-- agent_events, written alongside.
CREATE TABLE IF NOT EXISTS email_worker_inbound_events (
  user_id              TEXT NOT NULL REFERENCES users(id),
  endpoint             TEXT NOT NULL,
  account_id           TEXT NOT NULL DEFAULT '',
  provider_event_id    TEXT NOT NULL,
  received_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, endpoint, account_id, provider_event_id)
);
