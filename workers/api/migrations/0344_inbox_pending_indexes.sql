-- #1640: the "Needs you" inbox (GET /v1/inbox) asks every owner-waiting source "what is pending for this user".
-- Each source had only instance- or status-led indexes, so the answer meant reading the user's whole history of that
-- table on every poll (the nav badge polls). These are PARTIAL indexes holding only the rows that are waiting on a
-- person right now - a handful per owner - so the inbox, its count and the badge read no history.
CREATE INDEX IF NOT EXISTS idx_inbox_secure_input ON secure_input_requests(user_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_website_access ON website_access_requests(user_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_permission ON instance_permission_requests(user_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_takeover ON browser_takeovers(user_id, created_at) WHERE state IN ('requested', 'active');
CREATE INDEX IF NOT EXISTS idx_inbox_mcp_input ON mcp_input_requests(user_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_coder_question ON coder_questions(user_id, asked_at) WHERE state IN ('waiting_human', 'escalated');
CREATE INDEX IF NOT EXISTS idx_inbox_approval ON account_change_requests(user_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_task ON instance_runtime_tasks(user_id, updated_at) WHERE status IN ('needs_human', 'needs_approval');
CREATE INDEX IF NOT EXISTS idx_inbox_application ON job_applications(user_id, updated_at) WHERE status = 'awaiting_review';
