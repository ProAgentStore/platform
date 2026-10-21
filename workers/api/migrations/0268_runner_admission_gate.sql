-- The runner admission gate (#1264): reject a new coding session on an overloaded machine
-- instead of accepting it and going silent (#913).
--
-- `gate_state` is the hysteresis the gate carries between heartbeats — written by
-- `updateGateState` (lib/runner-admission-gate.ts) on every heartbeat, read by `coding_loop_start`
-- before it opens a new session, and surfaced by list_runner_nodes. NULL (every existing row, and
-- a node whose first heartbeat has not landed yet) reads as "accepting": nothing is ever rejected
-- on the strength of an absent sample.
--
-- `gate_thresholds` is a per-node override of the defaults in runner-admission-gate.ts — a PARTIAL
-- JSON object, merged over the defaults field by field, so setting one threshold does not require
-- restating the rest. NULL = the defaults apply as they are.
--
-- Both are scoped to (instance_id, user_id, runner_node), the same grain `resources` already is:
-- a machine serving two instances gets one row — and one override, one gate state — per instance,
-- which is the existing tradeoff this column lives beside, not a new one.
ALTER TABLE instance_runtime_nodes ADD COLUMN gate_state TEXT;
ALTER TABLE instance_runtime_nodes ADD COLUMN gate_thresholds TEXT;

-- The objective queue's retry clock for a DEFERRED (not failed) start (#1264).
--
-- `defer_reason` names WHY an entry is waiting — until now `stop_reason` carried a free-text
-- sentence and nothing else, so a sweep could not select "the entries waiting on an overloaded
-- machine" without parsing prose. NULL on every entry that was never deferred, and on every
-- deferral before this migration.
--
-- `next_retry_at` is WHEN a deferred entry may be tried again, ms epoch. NULL means "eligible the
-- moment something drains the queue" — the existing behaviour for `busy` / `recovery_required` /
-- `runner_offline`, all of which are woken by an EVENT (a run finishing, a relay reconnecting) and
-- must not gain an invented delay here. Only `runner_overloaded` sets it, because nothing it waits
-- for is an event — the machine recovers on its own clock, which only a timed retry can catch.
-- `objective-queue.ts`'s `requeueEntry` is the only writer.
ALTER TABLE instance_objective_queue ADD COLUMN defer_reason TEXT;
ALTER TABLE instance_objective_queue ADD COLUMN next_retry_at INTEGER;
