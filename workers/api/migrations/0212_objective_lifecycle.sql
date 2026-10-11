-- #1017: a durable, owner-scoped lifecycle for every objective, and the joins that make it readable.
--
-- Before this an owner could not tell started, cancelled, deduplicated, failed-admission and
-- still-pending objectives apart: the queue lists pending rows only, a start receipt keeps the state
-- it settled with (`queued` forever), and nothing recorded WHO caused a transition.
--
-- Attribution is what the platform can actually verify. `actor_uid` is the HMAC-verified session uid;
-- `client_claimed` is the client category the caller declared (`X-PAGS-Client`) and is labelled as a
-- claim — a session token does not prove which client sent it. A request key is never an identity.
-- Rows written before this migration carry neither, and read back as `unknown` legacy attribution.
ALTER TABLE loop_start_receipts ADD COLUMN actor_uid TEXT;
ALTER TABLE loop_start_receipts ADD COLUMN client_claimed TEXT;
ALTER TABLE instance_objective_queue ADD COLUMN request_id TEXT;
ALTER TABLE instance_objective_queue ADD COLUMN actor_uid TEXT;
ALTER TABLE instance_objective_queue ADD COLUMN client_claimed TEXT;
-- The run an objective became, linked back to the queue entry and the start request that produced it.
ALTER TABLE agent_loop_runs ADD COLUMN queue_entry_id TEXT;
ALTER TABLE agent_loop_runs ADD COLUMN request_id TEXT;

-- Append-only transition history. `seq` is the stable order (and the pagination cursor); every
-- correlation handle is nullable because a transition knows only the handles that exist by then.
-- No objective text, prompts or results are stored here — handles, the event, a bounded reason.
CREATE TABLE IF NOT EXISTS objective_lifecycle_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  request_id TEXT,
  queue_entry_id TEXT,
  run_id TEXT,
  session_id TEXT,
  event TEXT NOT NULL CHECK (event IN (
    'requested', 'request_replayed', 'started', 'queued', 'deduplicated', 'not_started', 'outcome_unknown',
    'admitted', 'deferred', 'admission_failed', 'cancelled', 'run_finished'
  )),
  reason TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'platform')),
  actor_uid TEXT,
  client_claimed TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objective_lifecycle_instance ON objective_lifecycle_events(user_id, instance_id, seq);
CREATE INDEX IF NOT EXISTS idx_objective_lifecycle_request ON objective_lifecycle_events(request_id);
CREATE INDEX IF NOT EXISTS idx_objective_lifecycle_entry ON objective_lifecycle_events(queue_entry_id);
CREATE INDEX IF NOT EXISTS idx_objective_lifecycle_run ON objective_lifecycle_events(run_id);
