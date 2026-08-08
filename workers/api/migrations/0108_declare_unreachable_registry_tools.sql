-- The tools the platform provides and nobody could call (#444).
--
-- Three tools have shipped complete-and-unreachable in four days (#415's pull tools, #279's
-- `transfer_conversation`, `delete_record`), each fixed one migration at a time with nothing added
-- that would catch the fourth. #444 added the guard — `lib/tool-reachability.test.ts` — and the
-- guard's first run named six more that were already live. This is the migration that closes them.
--
-- The mechanism, once more, because it is what makes this silent: `capabilities.tools` is an
-- AUTHORITATIVE allowlist. `toolNamesFor` (agent-do-tools.ts) REPLACES the per-surface default with
-- the declared list rather than adding to it, so a connector tool no agent names is a tool no agent
-- has. Nothing errors. `GET /v1/instances/:id/tools` reports `not_declared` on a page nobody has
-- open, and the agent — having no tool for the request — answers conversationally.
--
-- Measured against production before writing this (`GET /v1/agents/my/agents`, 39 agents), so each
-- object below is the CURRENT live declaration with names appended and nothing else changed:
--
--   coder-lead   ["list_subordinates","subordinate_status","delegate_goal","check_delegation",
--                 "github_list_issues","github_read_issue","github_list_pulls","github_read_pull",
--                 "transfer_conversation"]                                        (0063→0067→0101→0107)
--   coder-repo   ["repo_tree","repo_read_file","repo_git","repo_remote","github_list_issues",
--                 "github_read_issue","github_create_issue","github_list_pulls","github_read_pull"]
--                                                                                 (0063→0065→0070→0101)
--   mcp-client   ["mcp_list_tools","mcp_call_tool"]                               (no migration — see below)
--
-- Every added name is `scope:"read"` EXCEPT `set_direction`, which is `scope:"write"` and therefore
-- already behind the per-instance write-consent gate (#90) the Lead opted into for `delegate_goal`.
-- No new consent surface, no new code path, no new auth.
--
-- ── coder-lead += set_direction ──
-- #330 built `set_direction` FOR this agent: its whole design is "the agent may PROPOSE, only the
-- owner SETS", and the handler hardcodes `setBy:"agent"` with a comment explaining why it must
-- never be "user". The proposing half has never been callable. Worse, 0107 — written yesterday to
-- fix this exact class for `transfer_conversation` — re-set the Lead's ENTIRE `$.capabilities`
-- object and did not include it, which is the trap `coder2-parity.test.ts` guards for names it
-- already knows and cannot guard for a new one.
--
-- ── coder-repo += github_workflow_runs ──
-- It already answers "what is broken" from issues and pulls; workflow runs are the CI half of the
-- same question (#416/#405). `surfaceOptions` is restated verbatim: a whole-object set drops any
-- option it does not restate, and `{repos:"single",drive:false,copilot:false}` is what keeps the
-- Repo Coder to ONE chat (#209) — losing it silently gives it a second one.
--
-- ── mcp-client += the four MCP read tools ──
-- #263/#264 shipped resources and prompts into the MCP connector; `mcp-client` declares only
-- `mcp_list_tools` and `mcp_call_tool`, so half the MCP protocol is unreachable from the one agent
-- built to speak it. All four are reads.
--
-- STATED PLAINLY, because it is a real limitation and not a footnote: `mcp-client` exists ONLY as a
-- live D1 row. No migration seeds it (nor `local-repo-chat`, `lead-outreach-tj6qrr`,
-- `facebook-friend-confirmer` — #67). So on a FRESH database this statement matches nothing and the
-- four tools go back to being unreachable, and the guard will not notice, because the guard's
-- denominator is this file. Seeding those agents is #67's job; declaring them here is what fixes
-- production today. The alternative — leaving them out — required writing four dishonest reasons
-- into `UNREACHABLE_BY_DESIGN`, and the map is only worth having if every entry is true.
--
-- Shape follows 0101/0107 (which follow 0054): `json_set` re-setting the FULL `$.capabilities`
-- object so the JSON stays one source of truth, one UPDATE per slug, idempotent (re-running writes
-- the same value; a no-op where the agent is absent). Earlier migrations are deliberately NOT
-- edited — `check-migrations.mjs --require-history` fails a file whose DDL changes after the commit
-- that introduced it, and for the right reason: wrangler never re-runs an applied file.
--
-- No per-instance backfill: `capabilitiesForInstance` JOINs the `agents` row at READ time, so every
-- already-subscribed instance picks this up on its next turn. `MAX_DECLARED_TOOLS` is 40 and
-- truncates SILENTLY; the longest list here is 10.
--
-- NOT included, deliberately: `delete_record`, the three `browser_*`, the two `meta` and the two
-- `sheets_*` tools. Each is unreachable for a stated reason (opt-in destructive; BROWSER_TOOLS_
-- ENABLED and first-party; inert until Meta review; inert until the Sheets OAuth scope lands), and
-- each of those reasons is now written down in `UNREACHABLE_BY_DESIGN` rather than being an
-- accident that looks like one.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":[],"runtime":null,"workflow":null,"tools":["list_subordinates","subordinate_status","delegate_goal","check_delegation","github_list_issues","github_read_issue","github_list_pulls","github_read_pull","transfer_conversation","set_direction"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-lead'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","surfaceOptions":{"coding":{"repos":"single","drive":false,"copilot":false}},"tools":["repo_tree","repo_read_file","repo_git","repo_remote","github_list_issues","github_read_issue","github_create_issue","github_list_pulls","github_read_pull","github_workflow_runs"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":[],"runtime":null,"workflow":null,"tools":["mcp_list_tools","mcp_call_tool","mcp_list_resources","mcp_read_resource","mcp_list_prompts","mcp_get_prompt"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'mcp-client'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
