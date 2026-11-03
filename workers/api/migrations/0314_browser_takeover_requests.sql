-- A runner can ask for more than one handoff on one task. Bind each durable takeover
-- to that exact request, so a closed request cannot be reopened by a stale poll.
ALTER TABLE browser_takeovers ADD COLUMN runner_request_id TEXT;
CREATE UNIQUE INDEX browser_takeovers_runner_request
  ON browser_takeovers(instance_id, subject_kind, subject_id, runner_request_id)
  WHERE runner_request_id IS NOT NULL;
