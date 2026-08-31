-- Give Coder agents a direct read path for GitHub issue comments.
--
-- `github_read_issue` returns the issue body and a COMMENTS COUNT, not the discussion itself.
-- That kept the common "read the ticket and the thread before acting" workflow on the expensive
-- path: spend a coding run on `gh issue view --comments`, which needs the owner's machine, a repo
-- checkout and a CLI credential for a read the GitHub App can perform directly.
--
-- The connector half is `github_list_issue_comments`: read-only, GitHub-App auth, paginated, and
-- `untrustedOutput:true` like the existing issue/PR reads. This file is the other half: declared
-- tools are an authoritative allowlist, so a registry tool no agent names is a tool no agent has.
--
-- Who gets it:
--
--   coder-repo  the normal single-repo Coder; it already reads and mutates GitHub issues.
--   coder       the legacy hardcoded Coder; keep parity with its issue reads.
--   coder-lead  it triages/delegates from issues, and comments often carry the actual decision.
--   tmux-coder  seeded to hold the Coder GitHub set; this keeps that set current.
--
-- No write consent changes: this is a read tool. No re-subscribe: capabilities are joined from the
-- `agents` row at read time, so live instances see it on the next tool-list resolution.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('["repo_tree","repo_read_file","repo_git","repo_remote","repo_find","repo_grep","github_list_issues","github_read_issue","github_list_issue_comments","github_create_issue","github_list_pulls","github_read_pull","github_workflow_runs","github_comment_issue","github_update_issue"]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('["github_create_issue","github_list_issues","github_read_issue","github_list_issue_comments","github_list_pulls","github_read_pull","github_comment_issue","github_update_issue"]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('["list_subordinates","subordinate_status","delegate_goal","check_delegation","github_list_issues","github_read_issue","github_list_issue_comments","github_list_pulls","github_read_pull","transfer_conversation","set_direction","github_create_issue","github_comment_issue"]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-lead'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('["repo_tree","repo_read_file","repo_git","repo_remote","repo_find","repo_grep","tmux_list_sessions","tmux_capture_pane","tmux_run_command","tmux_send_keys","tmux_send_message","tmux_new_session","tmux_kill_session","github_list_issues","github_read_issue","github_list_issue_comments","github_list_pulls","github_read_pull","github_workflow_runs","github_create_issue","github_comment_issue","github_update_issue"]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'tmux-coder'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
