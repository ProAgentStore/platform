cd /Users/serge/.config/proagentstore/browser-runner/repos/repo_2b2657fb-31e5-48a4-99f3-147fffde0925; git fetch origin 2>&1 | tail -1; echo "upstream since start:"; git log --oneline HEAD..origin/main; git add -A && git commit -q -F - <<'EOF'
fix(coding): the repo-scope guard judges the remote write, not the commit message (#872)

A CRM run registered for proappstore-online/crm added CRM files and
pushed `origin main`, and was halted with act.out_of_scope for writing
to "mcp/apps": the act record carries the whole command line, and
repoSlugsInCommand scanned all of it - including the heredoc commit
message, whose https://mcp.proappstore.online/mcp/apps/crm matched the
https-remote position.

- remoteWriteText(command): drop heredoc bodies, keep only the segments
  that perform a remote write (git push, gh pr create/merge, gh release
  create, gh repo delete, gh api with a mutating method), and strip gh's
  prose-flag values (--title/--body/--subject/--notes and short forms;
  gh only - git push takes no prose, and its -n is --dry-run).

Closes #872

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --oneline -1; git push "https://x-access-token:$(gh auth token)@github.com/ProAgentStore/platform.git" main 2>&1 | tail -1; gh issue view 872 --repo ProAgentStore/platform --json state,stateReason --jq '"\(.state) \(.stateReason)"'
