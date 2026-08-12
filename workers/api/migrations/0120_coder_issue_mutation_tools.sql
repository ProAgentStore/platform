-- A Coder can follow up on the issue it opened (#507).
--
-- The GitHub connector had ONE write, `github_create_issue`. An agent could file a ticket and then
-- never touch it again — no comment, no close, no relabel, no assign, which is the entire list of
-- things that happen to a ticket after it exists. Verbatim from the owner's Chess coder 2
-- (instance bd43f4de, agent `coder-repo`), 2026-08-11 23:03:12:
--
--   owner — "…you assign the issue to me, if it needs my input."
--   agent — "On issue #16 — I can't assign issues to you via my tools (no write access to issue
--            assignment)."
--
-- The cost of the workaround is measured, not theoretical. `agent_trace` on Heartfull, 2026-08-11
-- 21:33:02: `start_work` → "Close GitHub issue #128 in HeartFull-online/platform with the comment:
-- 'Not in scope…'". Closing one issue with one sentence consumed a Pilot run and an Engine session
-- on the owner's machine, because `gh issue close` was the only route. The same detour appears on
-- PAS Coder (#85), FWS platform (#119) and Chess coder 2 in the same window. It is also a route
-- that needs a machine running `pags up`, an engine login and a checkout — which the Coder Lead
-- has none of, so for the Lead the capability did not exist at all.
--
-- The connector half ships in the same commit as this file, deliberately: `github_comment_issue`
-- and `github_update_issue` are declaration-only (no default grants a connector tool), so landing
-- the code without this migration is the #415/#444 class all over again — a complete registry tool
-- that nobody can call. `tool-reachability.test.ts` fails if they are ever separated.
--
-- ── Who gets what, and why it is not the same list ──
--
--   coder-repo  += github_comment_issue, github_update_issue
--   coder       += github_comment_issue, github_update_issue   (the legacy hardcoded Coder)
--   coder-lead  += github_comment_issue                        ONLY
--
-- The Lead gets the comment and not the update. A Lead that reports on work should be able to
-- leave the record on the ticket ("delegated to FWS, run 70fc6c23"); CLOSING is a claim that the
-- work is DONE, and the Lead only ever learns that second-hand from `check_delegation` — the field
-- it has already been observed over-trusting. The agent that did the work is the one that should
-- close the ticket. This is reversible in one name if the owner disagrees.
--
-- ── No new auth, no new consent surface, no new scope ──
--
-- All three writes ride the SAME GitHub-App installation token, which already carries
-- `issues: write` — that is what makes `github_create_issue` work today, and `POST
-- …/issues/{n}/comments` + `PATCH …/issues/{n}` need no more than it. They arrive gated by the
-- same per-instance write-consent check (#90) `github_create_issue` passes through; measured on
-- the Repo Coders, `github` write consent already reads `granted`, so this is live for them the
-- moment it lands. Access stays bounded by `installationTokenForOwner`: no agent can reach a repo
-- the owner's own installation does not already cover.
--
-- STATED PLAINLY, because #447's lesson is the relevant one: `github` has NO entry in
-- `CONNECTOR_CONSTRAINTS` (verified — the table holds exactly `terminal` and `tmux`), so there is
-- no per-agent argument ceiling on WHICH repo these tools may touch, and the constraint gate in
-- `runRegistryTool` is skipped entirely for this connector. That was already true of
-- `github_create_issue`; this migration widens what can be done to an issue without widening which
-- repos are reachable. A repo allowlist for `github` is a real and separate piece of work (a new
-- constraint vocabulary plus the console surface to narrow it) and is NOT smuggled in here.
--
-- ── Deliberately NOT included ──
--
-- PR merge/close: `github_list_pulls`'s own description records that the repo's merge policy
-- governs that, and issue state does not reopen the question. Issue deletion: irreversible, and
-- nothing has asked for it. `state_reason` (close as "not planned" vs "completed"): a real
-- refinement of the close the owner actually performed, but not asked for by #507, so it is left
-- for a ticket rather than added quietly.
--
-- Shape follows 0101/0107/0108/0119 (which follow 0054): `json_set` re-setting the FULL
-- `$.capabilities` object, one UPDATE per slug, idempotent (re-running writes the same value; a
-- no-op where the agent is absent). Each object below is the CURRENT effective declaration read off
-- the last migration that wrote it —
--
--   coder-repo  0063 seed -> 0065 -> 0070 -> 0101 -> 0108
--   coder       0022      -> 0054 -> 0101
--   coder-lead  0063 seed -> 0067 -> 0101 -> 0107 -> 0108 -> 0119
--
-- — with names appended and NOTHING else changed. Restating a whole object is how a sibling gets
-- dropped: 0107 lost `set_direction` doing exactly this, and `coder-repo`'s
-- `surfaceOptions.coding` is not in the tools array, so losing it would silently give the Repo
-- Coder a second way to drive its engine (#154/#209) with every tools assertion still passing. Both
-- are pinned in `coder2-parity.test.ts`. Earlier migrations are deliberately not edited —
-- `check-migrations.mjs --require-history` fails a file whose DDL changes after it shipped.
--
-- No per-instance backfill and no re-subscribe: `capabilitiesForInstance` JOINs the `agents` row at
-- READ time, so every already-subscribed Coder picks this up on its next turn.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","surfaceOptions":{"coding":{"repos":"single","drive":false,"copilot":false}},"tools":["repo_tree","repo_read_file","repo_git","repo_remote","github_list_issues","github_read_issue","github_create_issue","github_list_pulls","github_read_pull","github_workflow_runs","github_comment_issue","github_update_issue"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","tools":["github_create_issue","github_list_issues","github_read_issue","github_list_pulls","github_read_pull","github_comment_issue","github_update_issue"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":[],"runtime":null,"workflow":null,"tools":["list_subordinates","subordinate_status","delegate_goal","check_delegation","github_list_issues","github_read_issue","github_list_pulls","github_read_pull","transfer_conversation","set_direction","github_create_issue","github_comment_issue"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-lead'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
