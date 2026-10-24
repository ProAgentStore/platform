CREATE TABLE release_note_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  workflows_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reason TEXT,
  permalink TEXT,
  UNIQUE(instance_id, sha, grant_id)
);
CREATE INDEX idx_release_note_queue_due ON release_note_queue(status, created_at);
