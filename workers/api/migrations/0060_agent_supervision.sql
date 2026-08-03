-- The supervision graph (#183) — who supervises whom, as configured data.
--
-- Coder's Overseer → Pilot → Engine hierarchy is correct but lives INSIDE the agent: the
-- delegation target was a repo id, the coordinator is a route, and depth is fixed at 2 by
-- construction. Nothing anywhere records who supervises whom, so supervision cannot be
-- configured, inspected, or reused — every future agent needing a coordinator would rebuild
-- the Overseer.
--
-- This is deliberately NOT `agent_connections` (0056). That table is choreography: a producer
-- emits a FACT and does not know its consumers. Supervision is the other edge — a supervisor
-- NAMES a subordinate, hands it a goal, and a result comes back that the supervisor is
-- accountable for. Folding the two together would lose the return path and the accountability,
-- which are the whole point. They share the DELIVERY substrate (the 0058 outbox), not the shape.
--
-- Rules enforced in lib/supervision-graph.ts at WIRING time, when the human is present: no
-- self-edge, no cycles, one supervisor per subordinate, and caps on depth and fan-out. A cycle
-- here is not a hypothetical — it is an unbounded delegation loop that spends real money.

CREATE TABLE IF NOT EXISTS agent_supervision (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,          -- owner; BOTH instances are theirs
  supervisor_instance_id   TEXT NOT NULL,          -- delegates goals downward
  subordinate_instance_id  TEXT NOT NULL,          -- executes with ITS OWN tools + consent (#185)
  enabled                  INTEGER NOT NULL DEFAULT 1,
  config                   TEXT,                   -- JSON: label, per-edge budget defaults (#184)
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One supervisor per subordinate, enforced in the schema and not only in application code:
-- two managers for one worker makes "who is accountable for this result" and "whose budget
-- paid for it" unanswerable, and leaves the escalation ladder (#157) with no single parent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_supervision_subordinate
  ON agent_supervision(subordinate_instance_id);

-- "Who do I delegate to?" — the hot read, on every supervisor turn.
CREATE INDEX IF NOT EXISTS idx_supervision_supervisor
  ON agent_supervision(supervisor_instance_id, enabled);

-- The owner's whole graph, which is what cycle/depth validation loads before adding an edge.
CREATE INDEX IF NOT EXISTS idx_supervision_user
  ON agent_supervision(user_id, created_at DESC);
