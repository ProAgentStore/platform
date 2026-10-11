-- #1020: automatic-update telemetry separates RECEIPT time from DECISION time.
--
-- `last_attempt_at` was stamped on every status report, and the runner re-sends its cached status
-- on every registration and heartbeat, so it advanced with no new registry check or controller
-- decision. These columns carry what the runner actually did and when, beside when we heard from it:
--   last_heartbeat_at  — when the last status report arrived (receipt only, never an attempt);
--   last_check_at      — the runner's own registry/work-check time;
--   last_decision_at   — the runner's own controller-decision time;
--   next_retry_due_at  — when the controller's next timer is due (a dead timer is visible as overdue);
--   blocker_class      — normalized reason it is waiting: idle_wait|active_sessions|observation_failure|unknown;
--   observations       — JSON, the last ≤5 paired work observations {success, sampled_at, source}.
-- Additive and nullable: an older runner sends none of them, and its rows keep reading as before.
ALTER TABLE machine_policies ADD COLUMN last_heartbeat_at INTEGER;
ALTER TABLE machine_policies ADD COLUMN last_check_at INTEGER;
ALTER TABLE machine_policies ADD COLUMN last_decision_at INTEGER;
ALTER TABLE machine_policies ADD COLUMN next_retry_due_at INTEGER;
ALTER TABLE machine_policies ADD COLUMN blocker_class TEXT;
ALTER TABLE machine_policies ADD COLUMN observations TEXT;
