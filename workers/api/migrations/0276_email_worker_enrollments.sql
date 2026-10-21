-- #1277: secure enrollment of a worker-backed mail connection from MCP.
--
-- The bridge bearer secret is typed by the OWNER into the console's existing secure-input page and never passes
-- through a prompt, a tool argument or a tool result. An enrollment binds that secure-input request (the opaque
-- handle) to the one connection it may create, so completing it cannot be pointed at a different endpoint/account
-- than the owner was shown. The secret itself lives only in secure_input_requests (envelope-encrypted, one-shot).
--
--   id                the secure_input_requests id (the same opaque handle the console link carries)
--   outcome           NULL = open; 'connected' | 'probe_failed' | 'expired'  (metadata only)
--   failure_class     the adapter's failure class on a probe that did not succeed (auth|protocol|bridge_unavailable|...)
CREATE TABLE IF NOT EXISTS email_worker_enrollments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  account_label TEXT,
  outcome TEXT,
  failure_class TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_worker_enrollments_user ON email_worker_enrollments (user_id, instance_id);
