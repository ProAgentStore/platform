-- Coder: declare the GitHub connector's issue tools as DATA (capabilities.tools) so the
-- co-pilot / Assistant chat can file + read GitHub issues DIRECTLY through the connector
-- framework — instead of delegating to the coding Engine (`drive_claude`) + the `gh` CLI (#130).
--
-- The tools already exist in the registry (lib/connectors/github.ts) and dispatch through
-- runRegistryTool (connectorClient → GitHub App installation token), which enforces the
-- per-instance grant + write-consent gate. This migration only makes them AVAILABLE to the
-- Coder agent's tool loop; no new auth, no raw tokens, no CLI.
--
-- Resolution (agent-do-tools `toolNamesFor`): a declared `tools` list is authoritative →
-- BASE + these three tools; the `coding` surface invariant (#119) still force-adds the
-- delegation tools (send_to_cli / read_terminal / list_coding_repos), so nothing the
-- orchestrator relies on is lost. github_create_issue is scope:"write" (consent-gated at
-- call time); github_list_issues / github_read_issue are reads (grant only).
--
-- We re-set the FULL capabilities object (as 0022 did) so the JSON stays a single source of
-- truth. Idempotent: re-running re-sets the same value; a no-op where the agent is absent.

UPDATE agents
SET config = json_set(
  COALESCE(NULLIF(config, ''), '{}'),
  '$.capabilities',
  json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","tools":["github_create_issue","github_list_issues","github_read_issue"]}')
)
WHERE slug = 'coder';
