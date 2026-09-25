-- Durable state for local-Claude/Codex Website Builder runs (#841). The runner is replaceable;
-- PAGS retains the evidence and is the only service that can hand off deployment.
CREATE TABLE site_builder_runtime_runs (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')),
  status TEXT NOT NULL CHECK (status IN ('drafting', 'paused', 'awaiting_review', 'approved', 'cancelled', 'failed')),
  evidence TEXT NOT NULL,
  refinement_count INTEGER NOT NULL DEFAULT 0 CHECK (refinement_count >= 0 AND refinement_count <= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_site_builder_runtime_runs_instance ON site_builder_runtime_runs(instance_id, updated_at DESC);
CREATE INDEX idx_site_builder_runtime_runs_user ON site_builder_runtime_runs(user_id, updated_at DESC);

-- The generic Settings tab renders these declared fields. Cloud is the backwards-compatible
-- default; selecting runtime never changes the cloud pipeline definition.
UPDATE agents
SET config = json_set(
  CASE WHEN json_valid(config) THEN config ELSE '{}' END,
  '$.settingsSchema',
  json('[
    {"id":"mcp_url","label":"Website-builder MCP endpoint","type":"text","description":"The Streamable-HTTP MCP server that builds the sites.","default":""},
    {"id":"template_slug","label":"Designer template","type":"text","description":"Which template new sites start from.","default":""},
    {"id":"photo_limit","label":"Photos per site","type":"number","description":"How many Google listing photos to pull into the gallery.","default":4},
    {"id":"site_builder_mode","label":"Website Builder mode","type":"select","description":"Cloud uses the existing PAGS pipeline. Runtime asks your local Claude or Codex CLI to author and visually QA the draft.","default":"cloud","options":[{"value":"cloud","label":"Cloud pipeline"},{"value":"runtime","label":"Local runtime"}]},
    {"id":"site_builder_engine","label":"Runtime authoring engine","type":"select","description":"Used only in Local runtime mode. The CLI stays signed in with your own subscription.","default":"claude","options":[{"value":"claude","label":"Claude Code"},{"value":"codex","label":"Codex"}]}
  ]')
)
WHERE slug = 'site-builder';
