-- #1683 follow-up to 0346: an index over json_extract(config) makes every write to a matching row parse config, so one
-- malformed config blob would fail every INSERT or UPDATE of that row (and two migration tests that seed one did).
-- json_valid is checked first, so a malformed row is simply not indexed. The sweep query in lib/auto-pickup.ts carries
-- the same json_valid term, and the WHERE text here must stay identical to it or the planner will not use the index.
DROP INDEX IF EXISTS idx_agent_instances_auto_pickup;
CREATE INDEX IF NOT EXISTS idx_agent_instances_auto_pickup ON agent_instances(id)
  WHERE status = 'active' AND json_valid(config) AND json_extract(config, '$.autoPickup.enabled') = 1;
