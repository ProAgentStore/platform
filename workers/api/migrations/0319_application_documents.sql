-- Exact owner-scoped Files receipts; document bytes remain in the instance's R2 Files store.
CREATE TABLE application_documents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  tailoring_run_id TEXT NOT NULL REFERENCES local_artifact_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('resume', 'cover_letter', 'profile', 'answers')),
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, instance_id, application_id, tailoring_run_id, role)
);

-- One poll persists a producing run at a time; a crashed worker's claim expires.
CREATE TABLE application_document_leases (
  tailoring_run_id TEXT PRIMARY KEY REFERENCES local_artifact_runs(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
