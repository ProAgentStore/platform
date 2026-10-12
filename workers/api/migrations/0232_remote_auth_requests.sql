-- #1005: a PAS remote sign-in request, relayed to PAGS by the owner's own machine.
--
-- Design A (owner decision, #1006): the PAS companion client on the machine creates the request at PAS
-- (`/v1/mcp/broker/v2`, PAS #355) and hands its NON-secret public details to the `pags` CLI on the same
-- machine, which relays them here with the owner's PAGS login. PAGS never holds a PAS credential and never
-- calls PAS: it stores what the machine reported, pushes the owner a same-origin link to this one request,
-- and its page sends the owner to PAS's own approval page in an external browser. States are the machine's
-- own reports of the PAS broker's states.
--
-- Immutable once written: the PAS request id, agent, machine, resource, scopes, approval URL and expiry —
-- a relay of the same PAS request with any other value is refused, never merged. No secret ever lands
-- here: no PAS token, code, verifier, proof or key (the approval URL is checked for credential-shaped
-- parameters before it is accepted).
CREATE TABLE IF NOT EXISTS remote_auth_requests (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  pas_request_id     TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  agent_label        TEXT NOT NULL,
  machine_id         TEXT NOT NULL,
  machine_label      TEXT NOT NULL,
  runner_node        TEXT,
  runner_machine_id  TEXT,
  resource           TEXT NOT NULL,
  scopes             TEXT NOT NULL DEFAULT '[]',
  approval_url       TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('pending', 'approving', 'approved_awaiting_machine', 'consumed', 'connected', 'denied', 'expired', 'cancelled', 'failed')),
  expires_at         INTEGER NOT NULL,
  last_reported_at   INTEGER NOT NULL,
  history            TEXT NOT NULL DEFAULT '[]',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_auth_requests_pas ON remote_auth_requests (user_id, pas_request_id);
CREATE INDEX IF NOT EXISTS idx_remote_auth_requests_user ON remote_auth_requests (user_id, created_at DESC);
