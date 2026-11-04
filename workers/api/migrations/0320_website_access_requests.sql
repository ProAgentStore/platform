-- Website questions bind an immutable exact hostname to one owner's agent and originating pause.
CREATE TABLE website_access_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('local_apply_run', 'local_browser_run', 'runtime_task', 'connector')),
  subject_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  pause_key TEXT NOT NULL,
  subject_link TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
  answer_nonce TEXT,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  decided_at INTEGER
);
CREATE INDEX website_access_requests_owner ON website_access_requests(user_id, instance_id, created_at, id);
CREATE UNIQUE INDEX website_access_request_pending_host ON website_access_requests(user_id, instance_id, hostname) WHERE status = 'pending';

-- Remember both choices. Revoking removes this row, never reopens the old question.
CREATE TABLE website_access_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny')),
  request_id TEXT NOT NULL REFERENCES website_access_requests(id) ON DELETE CASCADE,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, instance_id, hostname)
);
