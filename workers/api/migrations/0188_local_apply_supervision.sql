-- Cloud supervision for local application runs (#968).
--
-- The runner pauses at a named checkpoint and PAGS records that receipt before a cloud brain (or
-- the owner) decides what may happen next.  A directive is deliberately a separate, immutable
-- row: retries can deliver the same decision to a restarted relay without ever choosing again.
-- `schema_version` is part of both records so a future checkpoint shape is rejected rather than
-- silently interpreted as version 1.

CREATE TABLE IF NOT EXISTS local_apply_supervisor_checkpoints (
  run_id          TEXT NOT NULL REFERENCES local_apply_runs(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  checkpoint_id   TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  -- Bounded runner-derived decision evidence; never page snapshots, CLI prose or form values.
  facts           TEXT NOT NULL,
  runner_seq      INTEGER NOT NULL,
  received_at     INTEGER NOT NULL,
  PRIMARY KEY (run_id, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_local_apply_supervisor_checkpoints_instance
  ON local_apply_supervisor_checkpoints(instance_id, user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS local_apply_supervisor_directives (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  checkpoint_id    TEXT NOT NULL,
  instance_id      TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id),
  schema_version   INTEGER NOT NULL,
  idempotency_key  TEXT NOT NULL,
  directive        TEXT NOT NULL CHECK (directive IN ('continue', 'request_review', 'stop')),
  created_at       INTEGER NOT NULL,
  delivery_attempted_at INTEGER,
  delivered_at     INTEGER,
  FOREIGN KEY (run_id, checkpoint_id)
    REFERENCES local_apply_supervisor_checkpoints(run_id, checkpoint_id) ON DELETE CASCADE,
  UNIQUE (run_id, checkpoint_id),
  UNIQUE (run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_local_apply_supervisor_directives_delivery
  ON local_apply_supervisor_directives(run_id, delivered_at, created_at);
