-- Explicit, owner-selected Instance Files inputs for Application Tailor (#1004).
--
-- This is deliberately separate from `agent_instances.config.applicationTailor`: selection is
-- auditable, owner-scoped state rather than an inferred filename or a mutable local-path setting.
-- The file identity and the File metadata observed at selection time are retained, but no source
-- content, R2 key, or download URL is copied into D1.

CREATE TABLE IF NOT EXISTS application_tailor_uploaded_sources (
  instance_id              TEXT NOT NULL REFERENCES agent_instances(id),
  user_id                  TEXT NOT NULL REFERENCES users(id),
  role                     TEXT NOT NULL CHECK (role IN ('resume', 'profile')),
  file_id                  TEXT NOT NULL,
  file_name                TEXT NOT NULL,
  mime_type                TEXT NOT NULL,
  file_size                INTEGER NOT NULL,
  extraction_status        TEXT,
  extracted_text_length    INTEGER,
  indexed_text_length      INTEGER,
  text_truncated           INTEGER NOT NULL DEFAULT 0,
  extraction_error         TEXT,
  file_created_at          TEXT NOT NULL,
  file_updated_at          TEXT NOT NULL,
  selected_at              INTEGER NOT NULL,
  PRIMARY KEY (instance_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_tailor_uploaded_source_file
  ON application_tailor_uploaded_sources(instance_id, user_id, file_id);
