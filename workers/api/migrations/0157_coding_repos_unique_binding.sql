-- One instance, one binding per repository — #829.
--
-- WHAT WAS WRONG. Nothing stopped `POST /coding/repos` (and so `coding_repo_add`) from binding the
-- same repository to an instance twice, and `detect-github` from giving a local-folder row the
-- GitHub identity a clone row on the same instance already had. Two rows for one repo is never a
-- configuration anyone wants: sessions resolve to one of them, and the other is stale by
-- construction. Both reported occurrences had one row `ready` with a live session and a twin
-- stuck in `cloning` or pointing at an empty folder — and `coding_loop_start` picked the twin and
-- refused to run while the working binding sat next to it.
--
-- WHAT THIS IS NOT. It does not limit an instance to one repo. Several DISTINCT repos on one
-- instance is supported; only the same repo twice is refused.
--
-- WHAT THIS ADDS. Two partial unique indexes: (instance, GitHub owner/repo) — case-insensitive,
-- because GitHub is — and (instance, local folder). The route checks first and answers 409 naming
-- the existing binding; these indexes close the race two concurrent adds would otherwise win.
-- Non-GitHub remotes are guarded in the route only (provider + slug, else clone URL): `clone_url`
-- is not an identity an index can hold, since https and ssh spell one repo two ways.
--
-- THE DUPLICATES ALREADY IN PRODUCTION. Measured 2026-09-23, before this ran: 42 rows, two
-- duplicated GitHub pairs (`FreeAgentStore/mcp` on 00b91906…, both rows `cloning`, no sessions;
-- `proappstore-online/parents-clubs` on 3cbb1d1d…, one `ready` with 6 sessions, its twin `cloning`
-- with none), no duplicated folders. The index cannot be created over them, so they are removed
-- first — and the removal is deliberately narrow:
--
--   · a row is deleted only if NOTHING hangs off it: no coding_sessions (and so no timeline), no
--     instance_objective_queue entry. There is no history to lose on a row that was never used.
--   · it is deleted only if a sibling for the same repo SURVIVES: one that is used, or, among
--     unused rows, the oldest. Every group therefore keeps exactly one row, whatever order the
--     DELETE visits them in.
--   · two rows for one repo that BOTH carry sessions are not resolved here. Choosing between two
--     histories is an owner's call, so the index creation below fails and stops the deploy loudly
--     instead of guessing. None exist today.

DELETE FROM coding_repos
WHERE github_repo IS NOT NULL AND github_repo <> ''
  AND NOT EXISTS (SELECT 1 FROM coding_sessions s WHERE s.repo_id = coding_repos.id)
  AND NOT EXISTS (SELECT 1 FROM instance_objective_queue q WHERE q.repo_id = coding_repos.id)
  AND EXISTS (
    SELECT 1 FROM coding_repos keep
    WHERE keep.instance_id = coding_repos.instance_id
      AND keep.id <> coding_repos.id
      AND lower(keep.github_repo) = lower(coding_repos.github_repo)
      AND (
        EXISTS (SELECT 1 FROM coding_sessions s2 WHERE s2.repo_id = keep.id)
        OR EXISTS (SELECT 1 FROM instance_objective_queue q2 WHERE q2.repo_id = keep.id)
        OR keep.created_at < coding_repos.created_at
        OR (keep.created_at = coding_repos.created_at AND keep.id < coding_repos.id)
      )
  );

DELETE FROM coding_repos
WHERE workdir IS NOT NULL AND workdir <> ''
  AND NOT EXISTS (SELECT 1 FROM coding_sessions s WHERE s.repo_id = coding_repos.id)
  AND NOT EXISTS (SELECT 1 FROM instance_objective_queue q WHERE q.repo_id = coding_repos.id)
  AND EXISTS (
    SELECT 1 FROM coding_repos keep
    WHERE keep.instance_id = coding_repos.instance_id
      AND keep.id <> coding_repos.id
      AND keep.workdir = coding_repos.workdir
      AND (
        EXISTS (SELECT 1 FROM coding_sessions s2 WHERE s2.repo_id = keep.id)
        OR EXISTS (SELECT 1 FROM instance_objective_queue q2 WHERE q2.repo_id = keep.id)
        OR keep.created_at < coding_repos.created_at
        OR (keep.created_at = coding_repos.created_at AND keep.id < coding_repos.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_repos_unique_github
  ON coding_repos(instance_id, github_repo COLLATE NOCASE)
  WHERE github_repo IS NOT NULL AND github_repo <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_repos_unique_workdir
  ON coding_repos(instance_id, workdir)
  WHERE workdir IS NOT NULL AND workdir <> '';
