-- Durable owner-scoped requests for a tool operation blocked by a missing per-instance permission (#1009).
--
-- This is intentionally separate from `instance_runtime_tasks`. A board card is a presentation of
-- work; a permission request is the security record that binds an owner, instance, exact control,
-- least requested scope, resource and immutable operation identity. The continuation payload is an
-- opaque reference/fingerprint owned by the permission-request service; no secret belongs in this
-- table's audit columns or event payloads.

CREATE TABLE instance_permission_requests (
  id                    TEXT PRIMARY KEY,
  instance_id           TEXT NOT NULL REFERENCES agent_instances(id),
  user_id               TEXT NOT NULL REFERENCES users(id),

  -- The control the owner must explicitly change, e.g. connector_consent / gmail_permission.
  control               TEXT NOT NULL,
  connector             TEXT,
  resource_id           TEXT,
  requested_scope       TEXT NOT NULL,
  current_scope         TEXT,

  -- Identity of exactly the work that was blocked. `continuation_ref` is opaque; the eventual
  -- dispatcher re-reads and verifies it before a single resume, rather than replaying prose.
  operation_kind        TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL,
  continuation_ref      TEXT NOT NULL,
  reason                TEXT NOT NULL DEFAULT '',

  -- pending | approved | claimed | denied | expired | revoked | cancelled | stale | resumed |
  -- failed | uncertain. States are checked by the service, not trusted from a UI client.
  status                TEXT NOT NULL DEFAULT 'pending',
  expires_at            TEXT NOT NULL,
  approved_at           TEXT,
  decided_at            TEXT,
  resumed_at            TEXT,
  resume_claimed_at     TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One active request for one exact blocked operation; repeated failures or notification taps must
-- reuse it. Terminal requests are deliberately excluded so a later, genuinely new operation can
-- ask again without overwriting the historical decision.
CREATE UNIQUE INDEX idx_permission_request_active_operation
  ON instance_permission_requests(instance_id, user_id, control, ifnull(connector, ''), ifnull(resource_id, ''), requested_scope, operation_fingerprint)
  WHERE status IN ('pending', 'approved', 'claimed');

CREATE INDEX idx_permission_request_owner_status
  ON instance_permission_requests(user_id, status, updated_at DESC);
CREATE INDEX idx_permission_request_instance_status
  ON instance_permission_requests(instance_id, status, updated_at DESC);
CREATE INDEX idx_permission_request_expiry
  ON instance_permission_requests(status, expires_at);

-- Append-only, non-secret lifecycle audit: request creation/reuse, push result, owner decision,
-- grant verification and continuation outcome. `detail` must contain identifiers/status only.
CREATE TABLE instance_permission_request_events (
  id                    TEXT PRIMARY KEY,
  request_id            TEXT NOT NULL REFERENCES instance_permission_requests(id),
  instance_id           TEXT NOT NULL REFERENCES agent_instances(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  event                 TEXT NOT NULL,
  detail                TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_permission_request_events_request
  ON instance_permission_request_events(request_id, created_at);
CREATE INDEX idx_permission_request_events_instance
  ON instance_permission_request_events(instance_id, created_at DESC);
