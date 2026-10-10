-- #1010: an owner may deliberately deliver ONE reviewed Tailor material set across an otherwise
-- paused Tailor → Runner edge.  This is a receipt for that exception, not a switch that resumes
-- the connection or a copy of the owner's documents (the event contains handles and hashes only).
CREATE TABLE IF NOT EXISTS application_material_transfers (
  id                              TEXT PRIMARY KEY,
  user_id                         TEXT NOT NULL REFERENCES users(id),
  source_application_id           TEXT NOT NULL REFERENCES job_applications(id),
  source_tailor_instance_id       TEXT NOT NULL REFERENCES agent_instances(id),
  destination_runner_instance_id  TEXT NOT NULL REFERENCES agent_instances(id),
  connection_id                   TEXT NOT NULL REFERENCES agent_connections(id),
  source_state_version            INTEGER NOT NULL,
  resume_sha256                   TEXT NOT NULL,
  cover_letter_sha256             TEXT NOT NULL,
  idempotency_key                 TEXT NOT NULL,
  transfer_event_id               TEXT NOT NULL,
  event_payload                   TEXT NOT NULL,
  delivery_id                     TEXT,
  created_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_material_transfers_idempotency
  ON application_material_transfers(user_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_material_transfers_material
  ON application_material_transfers(user_id, source_application_id, source_state_version,
    resume_sha256, cover_letter_sha256, connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_material_transfers_event
  ON application_material_transfers(transfer_event_id);
