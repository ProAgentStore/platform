-- Durable delivery for the agent-to-agent pump (lib/connections.ts).
--
-- Before this, deliverEvent ran INLINE inside the emitting pipeline's sink step, best-effort:
-- if the target's action threw — the builder MCP down, the model rate-limited, a Worker
-- hiccup — the event was logged and lost. In a chain (lead → site → outreach) that meant a
-- lead silently fell out partway with nothing anywhere saying so. At-most-once delivery is
-- the wrong guarantee for business-critical work.
--
-- This table is the outbox. Every delivery is PERSISTED before it is attempted, so a crash
-- mid-step can't lose it; failures are retried with backoff by the per-minute cron; and a
-- delivery that exhausts its attempts becomes a visible dead-letter the owner can replay
-- instead of a silent gap.
--
-- `idempotency_key` is what makes retries safe. The consumer side of a chain does expensive,
-- irreversible work (creating a site, spending model tokens), so a retry must not be able to
-- do it twice. The key is (connection, emitting run, payload) — a retry of the same emission
-- collides and is ignored, while a deliberate RE-RUN of the pipeline is a new intent and gets
-- through.
--
-- `trace_id` carries the emitting run's id into the target's run. Choreography's known
-- weakness is that no single place shows the end-to-end flow; threading the id means
-- /v1/instances/:id/trace can tell the whole lead → site → outreach story as one thing.

CREATE TABLE agent_connection_deliveries (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  target_instance_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  config TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  trace_id TEXT,
  -- pending → delivered | dead (attempts exhausted). No 'failed' state: a failure that can
  -- still be retried stays pending with next_attempt_at set, so the sweep query is one index.
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The sweep's only query: pending work that is due.
CREATE INDEX idx_conn_deliveries_due ON agent_connection_deliveries(status, next_attempt_at);
-- The owner-facing list (what got delivered / what is stuck).
CREATE INDEX idx_conn_deliveries_user ON agent_connection_deliveries(user_id, created_at);
-- Per-chain debugging: everything one emitting run set off.
CREATE INDEX idx_conn_deliveries_trace ON agent_connection_deliveries(trace_id);
