-- Give Coder agents the log TEXT of a GitHub Actions job, not only its status (#781).
--
-- `github_workflow_runs` answers "did CI go red" and stops there: status, conclusion, branch, url.
-- Diagnosing WHY meant a human opening the run in a browser and pasting the failing step's output
-- into chat. `github_workflow_run_logs` reads it directly over the same installation token (listing
-- runs and downloading logs are the same Actions read permission), picks the failed job, and
-- windows the end of its log the way `repo_read_file` windows a file.
--
-- Who gets it — every agent that already holds `github_workflow_runs`, and nobody else:
--
--   coder-repo  the normal single-repo Coder; it watches its own repo's CI after a push.
--   tmux-coder  seeded to hold the Coder GitHub set; this keeps that set current.
--
-- `coder` (legacy) and `coder-lead` do not declare `github_workflow_runs`, so a log reader without
-- the run lister would be a tool with no way to learn a run id. Parity is kept per agent.
--
-- Read tool, `untrustedOutput:true`: no write consent changes. No re-subscribe: capabilities are
-- joined from the `agents` row at read time, so live instances see it on the next tool-list
-- resolution. The lists below are 0145's, plus the one name.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('["repo_tree","repo_read_file","repo_git","repo_remote","repo_find","repo_grep","github_list_issues","github_read_issue","github_list_issue_comments","github_create_issue","github_list_pulls","github_read_pull","github_workflow_runs","github_workflow_run_logs","github_comment_issue","github_update_issue"]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('["repo_tree","repo_read_file","repo_git","repo_remote","repo_find","repo_grep","tmux_list_sessions","tmux_capture_pane","tmux_run_command","tmux_send_keys","tmux_send_message","tmux_new_session","tmux_kill_session","github_list_issues","github_read_issue","github_list_issue_comments","github_list_pulls","github_read_pull","github_workflow_runs","github_workflow_run_logs","github_create_issue","github_comment_issue","github_update_issue"]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'tmux-coder'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
