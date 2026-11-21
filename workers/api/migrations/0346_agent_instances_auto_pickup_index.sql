-- #1683: sweepAutoPickup full-scanned agent_instances, parsing every config blob each run. This partial index holds only
-- the instances with auto-pickup on, so the sweep reads that handful. The WHERE text must stay identical to the
-- sweep query arm in lib/auto-pickup.ts, or the planner will not use the index.
CREATE INDEX IF NOT EXISTS idx_agent_instances_auto_pickup ON agent_instances(id)
  WHERE status = 'active' AND json_extract(config, '$.autoPickup.enabled') = 1;
