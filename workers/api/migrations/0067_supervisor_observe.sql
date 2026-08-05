-- A supervisor observes its subordinates (#205).
--
-- Two unrelated-looking changes, both in service of one thing: letting a Lead answer "what is each
-- of my agents doing?" from its own read instead of DELEGATING A RUN to find out.
--
-- 1. `last_progress_at` — the only queryable staleness signal. `agent_loop_runs.status` sits at
--    'running' forever when a Workflow dies mid-step, so "running" alone cannot distinguish working
--    from dead. Both workflows have code defenses (a catch that force-closes, the no-runner path)
--    but neither survives an isolate death, and neither is something a reader can ask about.
--    Written by `recordIteration`, which AgentLoopWorkflow already calls per iteration — so this
--    starts working for generic loops immediately. The Pilot starts reporting in #206.
--
-- 2. The `coder-lead` template gains `subordinate_status`. `capabilities.tools` is an authoritative
--    allowlist (agent-do-tools `toolNamesFor`), so a tool the template does not declare is invisible
--    to the agent no matter that the registry provides it.
--
-- json_set, not a config rewrite: 0063 already ran in production and an owner may have changed
-- other fields since. No per-instance backfill either — `agentCapabilities` resolves from
-- `agents.config` at READ time, so every already-subscribed Lead picks this up on its next turn.

ALTER TABLE agent_loop_runs ADD COLUMN last_progress_at INTEGER;

UPDATE agents
SET config = json_set(
      config,
      '$.capabilities.tools',
      json('["list_subordinates","subordinate_status","delegate_goal","check_delegation","github_list_issues","github_read_issue"]')
    ),
    updated_at = datetime('now')
WHERE slug = 'coder-lead' AND config IS NOT NULL AND json_valid(config);
