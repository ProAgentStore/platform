-- Per-account approval gate (#1268): major configuration changes wait for the owner's approval from the phone.
--
-- Three tables, none of which reuses `instance_permission_requests`: that row is an instance-scoped grant the owner
-- re-grants and then resumes, while this one is an ACCOUNT-scoped, exact stored request (method, path, body) that is
-- applied once, unchanged, if the target has not drifted and the request has not expired.

-- One row per account that has ever configured the gate. No row = off (behaviour unchanged).
CREATE TABLE account_approval_gate (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  enabled        INTEGER NOT NULL DEFAULT 0,
  -- JSON array of gated action ids (see lib/approval-gate.ts).
  actions        TEXT NOT NULL DEFAULT '[]',
  -- How long a pending request stays decidable. 24h by default; bounded by the route.
  expiry_seconds INTEGER NOT NULL DEFAULT 86400,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE account_change_requests (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  actor_user_id       TEXT NOT NULL,
  action              TEXT NOT NULL,
  target_description  TEXT NOT NULL DEFAULT '',
  method              TEXT NOT NULL,
  path                TEXT NOT NULL,
  -- JSON {c,d,i} (base64 ciphertext, wrapped DEK, iv) of the exact request body and the headers that change behaviour.
  -- Envelope-encrypted like every stored credential; never shown, only replayed.
  body_encrypted      TEXT NOT NULL,
  -- The redacted, human-readable change the owner is asked to approve (JSON). Secret-looking values are masked.
  diff_preview        TEXT NOT NULL DEFAULT '{}',
  -- SHA-256 of the target's state when the request was made; approval re-reads it and refuses on a mismatch.
  before_fingerprint  TEXT NOT NULL,
  -- SHA-256 of method + path + body: one pending request per exact change.
  request_fingerprint TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','denied','cancelled','applied','expired','failed')),
  expires_at          INTEGER NOT NULL,
  decided_by_device   TEXT,
  created_at          INTEGER NOT NULL,
  decided_at          INTEGER,
  -- Set by the single atomic claim that lets the stored change run; NULL means it never ran.
  applied_at          INTEGER,
  apply_status        INTEGER,
  apply_result        TEXT
);

CREATE UNIQUE INDEX idx_account_change_pending
  ON account_change_requests(user_id, request_fingerprint) WHERE status = 'pending';
CREATE INDEX idx_account_change_owner ON account_change_requests(user_id, created_at DESC);

-- Append-only audit: request, notification, decision (who, device), apply result.
CREATE TABLE account_change_events (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES account_change_requests(id),
  user_id    TEXT NOT NULL,
  event      TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_account_change_events_request ON account_change_events(request_id, created_at);
CREATE INDEX idx_account_change_events_owner ON account_change_events(user_id, created_at DESC);
