-- One binding per GitHub repo per instance (#829).
--
-- Two rows on one instance pointing at the same `owner/repo` are never two repos: one is a stale
-- handle on the other. Production had two such pairs (a never-cloned local path beside a ready
-- clone), and `coding_loop_start` resolved to the stale one and refused to run. The route guards
-- in routes/coding-repos.ts (add, and detect-github) refuse with a 409; this index is the backstop
-- for anything that reaches the table another way, including two adds racing past the check.
--
-- GitHub names are case-insensitive, so the key is `lower(github_repo)`. Partial: local and
-- non-GitHub rows carry no `github_repo` and any number of them may coexist.
--
-- Any pair still in the table would make CREATE UNIQUE INDEX fail and block the deploy, and the
-- table could not be read from where this was written. So a surviving duplicate is DEMOTED first,
-- not deleted: its `github_repo` is cleared, and the row — with its sessions, timeline and
-- instructions — stays for the owner to remove. The binding kept is the one that works: a `ready`
-- clone first, then the most recently updated, then the lowest id so the choice is deterministic.
UPDATE coding_repos
   SET github_repo = NULL,
       updated_at = datetime('now')
 WHERE github_repo IS NOT NULL AND github_repo <> ''
   AND EXISTS (
     SELECT 1 FROM coding_repos keep
      WHERE keep.instance_id = coding_repos.instance_id
        AND lower(keep.github_repo) = lower(coding_repos.github_repo)
        AND keep.id <> coding_repos.id
        AND (
          (keep.clone_status = 'ready') > (coding_repos.clone_status = 'ready')
          OR ((keep.clone_status = 'ready') = (coding_repos.clone_status = 'ready')
              AND (keep.updated_at > coding_repos.updated_at
                   OR (keep.updated_at = coding_repos.updated_at AND keep.id < coding_repos.id)))
        )
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_repos_instance_github
  ON coding_repos (instance_id, lower(github_repo))
  WHERE github_repo IS NOT NULL AND github_repo <> '';
