-- #1270: native Cloudflare Email Sending + Email Routing on top of the worker-backed email connector
-- (#1269, 0270). A Cloudflare mail setup is a customer-account BRIDGE Worker that speaks the same
-- `email-worker/v1` contract; what is new is that Cloudflare separates three things a generic
-- worker conflates, and PAGS must not conflate them either:
--
--   * a SENDER      — an address Cloudflare Email Sending will send as (domain onboarded + verified);
--   * a ROUTE       — an address Email Routing accepts mail for and forwards/handles (inbound only);
--   * a REPLY identity — the sender an agent answers FROM.
--
-- A routed address is NOT a sender. `identity_snapshot` is what the bridge itself reported on its
-- last successful identity probe (never asserted by the owner); `approved_senders` is the owner's own
-- narrowing of it. A send is allowed only for an address in BOTH. Columns are nullable/defaulted so
-- every existing generic (#1269) connection keeps working with no sender policy at all.
ALTER TABLE email_worker_connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE email_worker_connections ADD COLUMN identity_snapshot TEXT;
ALTER TABLE email_worker_connections ADD COLUMN approved_senders TEXT NOT NULL DEFAULT '[]';
ALTER TABLE email_worker_connections ADD COLUMN reply_identity TEXT;
ALTER TABLE email_worker_connections ADD COLUMN last_probe_at TEXT;
ALTER TABLE email_worker_connections ADD COLUMN last_probe_ok INTEGER;
ALTER TABLE email_worker_connections ADD COLUMN last_failure_class TEXT;

-- Append-only receipts for the connector: every read, send, reply, inbound message, delivery outcome
-- and routing/bridge failure. Addresses (a sender, an original recipient) are recorded because the
-- issue asks for the ORIGINAL recipient and sender to be preserved; a message body, subject, secret
-- or adapter response text is never a column here, and nothing in the code path could add one.
--
-- UPDATE and DELETE abort, so the guarantee does not depend on every future caller behaving, and
-- nothing cascades from the connection: revoking a connection must not erase what it did.
--
-- Outbound idempotency is enforced HERE, not in memory: the partial unique index allows exactly one
-- accepted ('sent') receipt per (owner, endpoint, account, idempotency_key), so two racing retries
-- of one intent cannot both be recorded as the delivery. Inbound replay is the existing
-- email_worker_inbound_events primary key; a replay is recorded as a 'deduped' receipt.
CREATE TABLE IF NOT EXISTS email_worker_receipts (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  user_id             TEXT NOT NULL,
  instance_id         TEXT NOT NULL DEFAULT '',
  endpoint            TEXT NOT NULL DEFAULT '',
  account_id          TEXT NOT NULL DEFAULT '',
  kind                TEXT NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN ('ok', 'sent', 'failed', 'refused', 'deduped')),
  failure_class       TEXT,
  message_id          TEXT,
  thread_id           TEXT,
  provider_receipt_id TEXT,
  event_id            TEXT,
  from_address        TEXT,
  to_address          TEXT,
  idempotency_key     TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_worker_receipts_user ON email_worker_receipts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_worker_receipts_conn ON email_worker_receipts(user_id, endpoint, account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_worker_receipts_sent
  ON email_worker_receipts(user_id, endpoint, account_id, idempotency_key)
  WHERE outcome = 'sent' AND idempotency_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS email_worker_receipts_no_update
BEFORE UPDATE ON email_worker_receipts
BEGIN
  SELECT RAISE(ABORT, 'email_worker_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS email_worker_receipts_no_delete
BEFORE DELETE ON email_worker_receipts
BEGIN
  SELECT RAISE(ABORT, 'email_worker_receipts is append-only');
END;
