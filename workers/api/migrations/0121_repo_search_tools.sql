-- The two tools that let a Repo Coder FIND a file (#508).
--
-- The repo-local connector gave its agents four read tools — repo_tree, repo_read_file, repo_git,
-- repo_remote — and not one of them searched. No grep, no filename match, no content match:
-- `repo_grep`, `repo_search` and `repo_find` returned zero hits across the worker AND the runner.
-- So locating a file meant walking the tree by hand, and when the tree ran out the model guessed.
--
-- Measured, Heartfull (agent `coder-repo`) 2026-08-11 22:28, answering one question: 18 tool calls
-- in a single turn, FIVE of them repo_tree, and three failed reads — two of which passed a
-- DIRECTORY to repo_read_file. That is the tell. `repo_tree` clamps to four levels and, until this
-- change, set `truncated` only on its ENTRY cap, so a folder stopped by the DEPTH cap was emitted
-- as a leaf with nothing under it. The file the turn was actually about sits SEVEN segments down
-- (`admin/lib/features/events/ui/pages/event_form_dialog.dart`) and was not reachable from the root
-- in any number of calls that did not already know the answer.
--
-- `repo_find` searches file NAMES and paths, `repo_grep` searches file CONTENTS. Both are
-- `scope:"read"` on a connector whose `scopes.write` is `false`, so neither can be write-consented
-- into anything; both run on the machine the owner already runs `pags up` on, over the same relay
-- the existing four use; both are bounded by COUNT rather than by a byte slice, so a cut list says
-- "showing 50 of 812" instead of ending mid-line (which is how #503 happened).
--
-- ── Why a migration is not optional here
--
-- `capabilities.tools` is an AUTHORITATIVE allowlist: `toolNamesFor` REPLACES the per-surface
-- default with the declared list rather than adding to it. A connector tool no agent names is a
-- tool no agent has, and nothing errors — `GET /v1/instances/:id/tools` reports `not_declared` on a
-- page nobody has open and the agent, having no tool for the request, answers conversationally.
-- `lib/tool-reachability.test.ts` (#444) is what makes that loud, and it fails on this pair until
-- this file exists. That guard is the reason this migration was written before the tools shipped
-- rather than after somebody noticed they did nothing.
--
-- ── Which agents, and which deliberately not
--
--   coder-repo        the agent that produced the measurement. Its list is 0120's, verbatim, with
--                     the two names appended and nothing else changed.
--   local-repo-chat   the other repo-local agent (seeded 0066, declaration untouched since). Its
--                     whole purpose is "explain this codebase to me", which is the use that needs
--                     search most, and it has exactly the four tools that cannot do it.
--
--   coder             NOT included. Its declaration (0120) carries no repo_* tool at all — it
--                     reaches code through its Engine, not through this connector — so adding a
--                     search tool it has no companion tools for would be noise in its prompt.
--   coder-lead        NOT included, same reason: it delegates, it does not read checkouts.
--
-- ── A NEW RUNNER IS REQUIRED, and the cloud says so rather than failing opaquely
--
-- These tools call `POST /coding/search`, which ships inside the published CLI
-- (`@proagentstore/cli`). A machine on an older release 404s that path, and `repo-local.ts` turns
-- that 404 into "this machine's runner is too old — it needs CLI 0.4.49 or newer, run
-- `npm i -g @proagentstore/cli`" rather than surfacing a raw `Runner /coding/search → 404`. The
-- declarations below are therefore safe to apply before every machine has upgraded: an old runner
-- gets an actionable sentence, not a broken tool. Same pattern as `SWITCH_BRANCH_MIN_CLI` (#322).
--
-- ── Shape
--
-- Follows 0101/0107/0108/0119/0120 (which follow 0054): `json_set` re-setting the FULL
-- `$.capabilities` object so the JSON stays one source of truth, one UPDATE per slug, idempotent
-- (re-running writes the same value; a no-op where the agent is absent). Earlier migrations are
-- deliberately NOT edited — `check-migrations.mjs --require-history` fails a file whose DDL changes
-- after the commit that introduced it, and wrangler never re-runs an applied file.
--
-- `surfaceOptions` is restated verbatim for coder-repo: a whole-object set drops any option it does
-- not restate, and `{repos:"single",drive:false,copilot:false}` is what keeps a Repo Coder to ONE
-- chat (#209). 0108 wrote that warning down after 0107 lost `set_direction` exactly this way.
--
-- No per-instance backfill and no re-subscribe: `capabilitiesForInstance` JOINs the `agents` row at
-- READ time, so every already-subscribed instance picks these up on its next turn.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","surfaceOptions":{"coding":{"repos":"single","drive":false,"copilot":false}},"tools":["repo_tree","repo_read_file","repo_git","repo_remote","repo_find","repo_grep","github_list_issues","github_read_issue","github_create_issue","github_list_pulls","github_read_pull","github_workflow_runs","github_comment_issue","github_update_issue"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":[],"runtime":"coding","workflow":null,"tools":["repo_tree","repo_read_file","repo_git","repo_remote","repo_find","repo_grep"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'local-repo-chat'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
