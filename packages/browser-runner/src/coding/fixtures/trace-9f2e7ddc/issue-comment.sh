cd /Users/serge/.config/proagentstore/browser-runner/repos/repo_2b2657fb-31e5-48a4-99f3-147fffde0925; gh issue comment 872 --repo ProAgentStore/platform --body-file - <<'EOF'
Fixed in 91d10dfa (on `main`).

**Cause:** the act record carries the whole command line, and `repoSlugsInCommand` scanned all of it, including the heredoc commit message. `https://mcp.proappstore.online/mcp/apps/crm` matched the "https remote" pattern and was read as the repository `mcp/apps`.

**Fix** (`workers/api/src/lib/repo-write-scope.ts`): a new `remoteWriteText` keeps only the remote write itself, and the guard reads repositories from that text alone.
- Heredoc bodies are dropped.
- Only the command segments that perform a remote write are kept: `git push`, `gh pr create`/`merge`, `gh release create`, `gh repo delete`, and `gh api` with a mutating method.

**Acceptance criteria**
- A push to an unregistered https or ssh remote, `--repo` naming another repository, a dry-run push to one, or a `gh api … -X POST` on another repository is still refused and recorded.
- A push to a named remote (`origin`) names no repository and is still treated as unknown.

**Limitation:** `cd <another checkout> && git push origin main` stays undetectable.
EOF
