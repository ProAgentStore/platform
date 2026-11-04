-- #1487: owner-scoped durable browser diagnostics, independent of a runner process lifetime.
CREATE TABLE browser_run_evidence (
 user_id TEXT NOT NULL, instance_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 coverage TEXT NOT NULL DEFAULT '{}', state TEXT, state_status TEXT NOT NULL DEFAULT 'not_collected',
 refreshed_at INTEGER, expires_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,instance_id,subject_kind,subject_id)
);
CREATE TABLE browser_run_calls (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id TEXT NOT NULL, instance_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 call_id TEXT NOT NULL, epoch TEXT, seq INTEGER NOT NULL, record TEXT NOT NULL,
 stored_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(user_id,instance_id,subject_kind,subject_id,call_id)
);
CREATE INDEX browser_run_calls_subject ON browser_run_calls(user_id,instance_id,subject_kind,subject_id,id);
CREATE INDEX browser_run_calls_expiry ON browser_run_calls(expires_at);
CREATE INDEX browser_run_evidence_expiry ON browser_run_evidence(expires_at);
