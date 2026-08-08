-- The Coders can read pull requests (#415).
--
-- #401 shipped `github_list_pulls` + `github_read_pull` into the GitHub connector registry
-- (lib/connectors/github.ts, both `scope:"read"`, handlers wired) and shipped the console's
-- Pulls panel with them. The panel works. The TOOLS were reachable by nobody: `capabilities.tools`
-- is an AUTHORITATIVE allowlist (agent-do-tools `toolNamesFor` — a declared list replaces the
-- per-surface default rather than adding to it), and not one agent on the platform declared
-- either name. Measured in production: `GET /v1/instances/:id/tools` on a Repo Coder reported
-- `"allowed": false, "reason": "not_declared"` for both. Ask a Repo Coder "what PRs are open?"
-- and it declines, or reaches for the terminal — the overlapping drive-path #154 exists to remove.
--
-- That gap is the cost of two correct decisions meeting: an authoritative allowlist is exactly
-- what makes a third-party creator's tool scope safe (#58), and adding a tool to the registry is
-- the normal way to add one. Nothing joins them, so a registry addition is inert until a migration
-- says otherwise. This is that migration; it adds NO code path, NO auth and NO new grant — the
-- tools are reads, so no write-consent surface changes.
--
-- REJECTED, and worth recording: auto-granting every read-scoped tool of a connector to any agent
-- that already declares a sibling from it. That inverts what the allowlist is for — every existing
-- agent would silently widen whenever a connector gained a tool, and it would have handed
-- `github_workflow_runs` to agents that never asked for it.
--
-- Shape follows 0054: `json_set` re-setting the FULL `$.capabilities` object so the JSON stays a
-- single source of truth rather than accreting one path-set per decision, one UPDATE per slug,
-- idempotent (re-running writes the same value; a no-op where the agent is absent). Each object
-- below is the CURRENT effective declaration read off the last migration that wrote it, with the
-- two names appended — nothing else changes:
--
--   coder-repo  0063 seed -> 0065 (surfaceOptions repos/drive) -> 0070 (copilot:false + tools)
--   coder-lead  0063 seed -> 0067 (subordinate_status)
--   coder       0022      -> 0054 (the three issue tools)
--
-- 0054/0065/0067/0070 are deliberately NOT edited: `check-migrations.mjs --require-history` fails
-- a migration whose DDL changes after the commit that introduced it, and for the right reason —
-- wrangler never re-runs an applied file, so an in-place edit reaches production not at all while
-- a fresh database gets the new text.
--
-- `coder-lead` IS INCLUDED, and that is the one judgement call here rather than a plain gap fix
-- (#415 flagged it as the owner's). A Lead reads issues to decide what to delegate; one that can
-- see pull requests can notice "that is already open in #412" before it spends an Engine on it.
-- It widens what the Lead READS and nothing else. To reverse: drop the two names from the
-- `coder-lead` statement below in a new migration — the other two slugs are independent.
--
-- `repo-chat` is deliberately NOT included. Its declared set is knowledge-only by design
-- (migration 0050, the first agent built "the creator way"); giving it connector tools is a
-- product decision, not a fix for this.
--
-- Per-instance backfill is not needed: `capabilitiesForInstance` (lib/agent-capabilities.ts) JOINs
-- the `agents` row at READ time, so every already-subscribed instance picks this up on its next
-- turn. `MAX_DECLARED_TOOLS` is 40; the longest list here is 9.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","surfaceOptions":{"coding":{"repos":"single","drive":false,"copilot":false}},"tools":["repo_tree","repo_read_file","repo_git","repo_remote","github_list_issues","github_read_issue","github_create_issue","github_list_pulls","github_read_pull"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":[],"runtime":null,"workflow":null,"tools":["list_subordinates","subordinate_status","delegate_goal","check_delegation","github_list_issues","github_read_issue","github_list_pulls","github_read_pull"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-lead'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","tools":["github_create_issue","github_list_issues","github_read_issue","github_list_pulls","github_read_pull"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
