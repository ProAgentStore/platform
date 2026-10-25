-- #1348: the append-only receipt trail behind release_note_queue. Every claim, outcome, owner retry
-- and reconciliation is a row here; nothing is ever updated or deleted, so "was SHA X announced to
-- channel Y?" has one answer that logs, MCP and the console all read.
-- `idempotency_key` is unique: a replayed owner request finds the attempt it already made.
-- `status` on release_note_queue is free text; 'abandoned' (the owner gave up an uncertain send) is new.
CREATE TABLE release_note_attempts (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('send','retry','reconcile_delivered','reconcile_abandoned','reconcile_retry')),
  outcome TEXT NOT NULL,
  reason TEXT,
  permalink TEXT,
  evidence_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_release_note_attempts_owner ON release_note_attempts(user_id, instance_id, created_at, id);
CREATE INDEX idx_release_note_attempts_queue ON release_note_attempts(queue_id, created_at, id);

CREATE TRIGGER release_note_attempts_no_update
BEFORE UPDATE ON release_note_attempts
BEGIN
  SELECT RAISE(ABORT, 'release_note_attempts is append-only');
END;

CREATE TRIGGER release_note_attempts_no_delete
BEFORE DELETE ON release_note_attempts
BEGIN
  SELECT RAISE(ABORT, 'release_note_attempts is append-only');
END;
