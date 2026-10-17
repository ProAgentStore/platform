-- Give the Repo Coders `github_read_file` and `github_tree` — reading a REMOTE repository (#1110).
--
-- A Repo Coder could read only its own local checkout (`repo_*`). It had no way to read a file in any
-- other repository its GitHub App installation covers — the blocked case in #1110 was the interns
-- app's `.github/workflows/*.yml` and a reusable workflow in `proappstore-online/proappstore`, read
-- from a Coder whose checkout is a different repo. Both tools shipped in cea45d55 (implemented and
-- tested, declared by no agent); this declares them. The owner chose "All Repo Coder agents" on the
-- run that asked (coder question 6c209c37, answered by a person, 2026-10-17).
--
-- Who gets them:
--
--   coder-repo   the Repo Coder — what the owner approved.
--   local-coder  0164 seeds it with EXACTLY coder-repo's capabilities, on the same coding driver,
--                and `lib/local-coder-seed.test.ts` pins the two equal ("if coder-repo gains a tool,
--                this fails and the new agent is updated on purpose rather than left one grant
--                behind"). It is the Repo Coder for a subscriber's own machine.
--
-- Not `tmux-coder` or `coder-lead`: neither is a Repo Coder, and the approval named Repo Coders.
--
-- Read tools — `mutates:false`, scope read, `untrustedOutput:true` — over the installation token the
-- other `github_*` reads already use: no new scope, grant, consent or App install. No re-subscribe:
-- capabilities are joined from the `agents` row at read time, so live instances see them on the next
-- tool-list resolution. The lists below are 0148's (and 0164's), plus the two names.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('["repo_tree","repo_read_file","repo_git","repo_remote","repo_find","repo_grep","github_list_issues","github_read_issue","github_list_issue_comments","github_create_issue","github_list_pulls","github_read_pull","github_workflow_runs","github_workflow_run_logs","github_comment_issue","github_update_issue","github_read_file","github_tree"]')
       ),
       updated_at = datetime('now')
 WHERE slug IN ('coder-repo', 'local-coder')
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
