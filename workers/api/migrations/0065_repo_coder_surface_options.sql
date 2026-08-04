-- Scope the Repo Coder's coding surface to what it actually is (#154 / surface options).
--
-- The Repo Coder was declared with a bare `surfaces:["coding"]`, which is an all-or-nothing flag:
-- it mounts the whole Coder UI and grants the whole Coder tool set. Two consequences, both wrong
-- for an agent that owns ONE repo and is driven by a Coder Lead:
--
--   1. It rendered add-repo and a multi-repo list it can never use. One agent, one repo, by
--      design — the Lead is what spans repos.
--   2. It carried send_to_cli / read_terminal, so its chat was a THIRD way to drive an engine,
--      alongside the Co-pilot and the Overseer. Those overlapping drive-paths are the thing
--      #154 exists to remove, and shipping a new agent with one re-created the problem the
--      decomposition was meant to solve.
--
-- `drive:false` removes only the CHAT tools. Its Coding tab still works and its Pilot still
-- drives the engine — neither goes through chat tools — so the agent loses no ability, only a
-- duplicate route to the same ability.
--
-- json_set rather than rewriting config: the seed in 0063 already ran in production, and this
-- must not clobber anything else an owner has since changed (settings, board columns).
UPDATE agents
SET config = json_set(
      config,
      '$.capabilities.surfaceOptions',
      json('{"coding":{"repos":"single","drive":false}}')
    ),
    updated_at = datetime('now')
WHERE slug = 'coder-repo'
  AND config IS NOT NULL
  AND json_valid(config);

-- Existing subscribed instances copy capabilities from the agent at read time
-- (agentCapabilities resolves from agents.config), so no per-instance backfill is needed.
