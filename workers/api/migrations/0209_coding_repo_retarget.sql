-- #1012: a coding-repo binding has a stable GitHub identity as well as its mutable
-- owner/name coordinate. Retargeting updates the binding row IN PLACE, so sessions,
-- timelines, receipts and queued objectives keep pointing at the same id.
ALTER TABLE coding_repos ADD COLUMN github_repository_id INTEGER;
-- Seconds-resolution `updated_at` is not an optimistic lock. This counter changes only
-- through the retarget primitive and makes stale/concurrent retargets fail closed.
ALTER TABLE coding_repos ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE coding_repos ADD COLUMN last_retarget_audit_id TEXT;

-- A numeric GitHub repository id is immutable across a GitHub rename. Two bindings on one
-- instance must never claim the same canonical repository; local/non-GitHub bindings stay
-- unnumbered.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_repos_instance_github_repository_id
  ON coding_repos (instance_id, github_repository_id)
  WHERE github_repository_id IS NOT NULL;

-- Durable retarget history. `prepared` is written before the guarded update; the update and
-- the move to `applied` (or `conflicted`, when the guard refused) commit in ONE D1 batch. A
-- `prepared` row left by a crash is resolved to `conflicted` by the next attempt. `previous_*`
-- is the complete input of the reverse retarget; nothing here relabels history.
CREATE TABLE IF NOT EXISTS coding_repo_retarget_audits (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES coding_repos(id),
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  expected_binding_version INTEGER NOT NULL,
  previous_owner TEXT NOT NULL,
  previous_name TEXT NOT NULL,
  previous_clone_url TEXT,
  destination_owner TEXT NOT NULL,
  destination_name TEXT NOT NULL,
  github_repository_id INTEGER NOT NULL,
  resulting_binding_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'applied', 'conflicted')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_coding_repo_retarget_audits_repo
  ON coding_repo_retarget_audits(repo_id, created_at DESC);
