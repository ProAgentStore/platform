-- Per-application submission authorization (#973): the owner approves ONE job, and that approval —
-- not a global switch — is what lets the Runner submit it.
--
-- Before this, submitting required `autoSubmit.enabled` plus a daily cap (lib/local-apply/policy.ts
-- `evaluateSubmitGate`), so an owner who had approved a single lead on the board still got
-- `fill_and_review`. The two express different things: the global toggle is a standing policy over
-- jobs nobody has looked at, and this is a decision about one job the owner just read.
--
-- A table rather than a column on `job_applications`, for the reasons `local_apply_supervisor_directives`
-- (0188) is one: the constraints ARE the semantics, and they belong in the schema.
--
--   UNIQUE (application_id)                   one live authorization per application. "Single-use"
--                                             is not a convention a later writer can forget.
--   UNIQUE (application_id, idempotency_key)  a retried approval (a double-click, a replayed MCP
--                                             call, an outbox redelivery) returns the authorization
--                                             that exists instead of minting a second one.
--   consumed_at / consumed_run_id             spent at DISPATCH, bound to the run that received it.
--                                             A replay after that cannot produce a second submission.
--
-- The four `fingerprint_*` columns are what "it cannot be replayed after a material lead change"
-- means in practice. They are deliberately NOT `state_version`: that counter moves on the very next
-- legitimate transition (materials_ready → filling), so an authorization bound to it would invalidate
-- itself one step after being granted. What must not change underneath an approval is the WORK the
-- owner approved — the lead revision and the exact artifacts — so the fingerprint is those, and
-- re-tailoring (which writes new artifact digests) invalidates the authorization by construction.
--
-- `approved_state_version` is kept as the audit of what the owner saw, which the issue asks for, and
-- is not used as the validity test.
CREATE TABLE IF NOT EXISTS job_application_submit_authorizations (
  id                     TEXT PRIMARY KEY,
  application_id         TEXT NOT NULL,
  -- The Tailor instance the application belongs to; the Runner is resolved at dispatch.
  instance_id            TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  user_id                TEXT NOT NULL REFERENCES users(id),
  -- Who approved it. 'owner' today; a named actor stays expressible without a migration.
  approved_by            TEXT NOT NULL,
  approved_at            INTEGER NOT NULL,
  -- The application state the owner was looking at when they approved (audit, not the validity test).
  approved_state_version INTEGER NOT NULL,
  approved_status        TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL,
  -- The material facts the approval was given for; a change to any of them invalidates it.
  fingerprint_lead_version   INTEGER,
  fingerprint_profile        TEXT,
  fingerprint_resume_sha     TEXT,
  fingerprint_cover_sha      TEXT,
  consumed_at            INTEGER,
  consumed_run_id        TEXT,
  revoked_at             INTEGER,
  revoked_reason         TEXT,
  UNIQUE (application_id),
  UNIQUE (application_id, idempotency_key)
);

-- "Does this application carry a usable authorization right now?" — read on every submit-gate
-- evaluation, which the queue runs for every `materials_ready` card it renders.
CREATE INDEX IF NOT EXISTS idx_submit_auth_live
  ON job_application_submit_authorizations(application_id, consumed_at, revoked_at);

-- The owner's approvals, newest first: the audit a board card and a trace read from.
CREATE INDEX IF NOT EXISTS idx_submit_auth_owner
  ON job_application_submit_authorizations(user_id, approved_at DESC);
