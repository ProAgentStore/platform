-- #1157: `pags login --device` — sign a machine in from any other device (RFC 8628 device authorization).
--
-- The machine starts a request and shows a short user code; the owner, signed in on a phone or laptop, approves it
-- at /console/device; the machine's poll then receives one session, once. Only the HASH of the device code is
-- stored (it is the machine's bearer for this exchange), so a read of this table cannot complete a sign-in.
--   status: pending → approved → consumed (the session was handed to the machine), or pending → denied.
CREATE TABLE device_authorizations (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  -- What the approval page shows the owner, so a code someone else started is recognisable as not theirs.
  client_node TEXT,
  client_ip TEXT,
  client_country TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  decided_at INTEGER
);
CREATE INDEX idx_device_authorizations_expires ON device_authorizations (expires_at);
