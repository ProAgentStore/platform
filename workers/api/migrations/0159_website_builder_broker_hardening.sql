-- #841 follow-up: a local subscription worker is a bearer of one short-lived,
-- draft-only capability. These columns make its FWS session, noindex precondition
-- and revocation state server facts rather than assertions in terminal output.
ALTER TABLE website_builder_jobs ADD COLUMN token_expires_at TEXT;
ALTER TABLE website_builder_jobs ADD COLUMN token_revoked_at TEXT;
ALTER TABLE website_builder_jobs ADD COLUMN fws_session_id TEXT;
ALTER TABLE website_builder_jobs ADD COLUMN create_started_at TEXT;
ALTER TABLE website_builder_jobs ADD COLUMN noindex_confirmed INTEGER NOT NULL DEFAULT 0;

-- The PAGS broker records provenance beside the exact FWS output. The result is
-- still treated as remote/untrusted content when shown to a model; this field only
-- establishes that it was obtained through the consented endpoint rather than pasted
-- by the local CLI.
ALTER TABLE website_builder_job_calls ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
