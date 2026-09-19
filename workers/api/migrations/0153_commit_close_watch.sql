-- The commit-close watcher's watermark (#816).
--
-- #816 asks the platform to scan commits landing on a repo's default branch for closing keywords
-- (Fixes/Closes/Resolves + an issue number) and close the named issue over the GitHub API,
-- "mirroring what GitHub already does for merged PRs, applied instead to direct pushes".
--
-- READ THIS BEFORE BUILDING ON IT: the premise is false, and the columns below fund a sweep whose
-- expected yield is zero. GitHub's native auto-close DOES fire on a direct push to the default
-- branch, with no pull request anywhere. Verified 2026-09-19 against the two repos #816 names,
-- every commit on `main` with zero associated PRs (`GET /commits/{sha}/pulls` -> 0):
--
--   proappstore-online/chess-academy e9d065c2  "…(closes #151)"       -> closed #151, commit_id set
--   proappstore-online/chess-academy 603527c0  body "Closes #141"     -> closed #141, commit_id set
--   ProAgentStore/platform           b47cf05e  "…(closes #808)"       -> closed #808, commit_id set
--   proappstore-online/chess-academy 47e9e2b8  "…(#124)"  bare ref    -> `referenced` only
--   proappstore-online/chess-academy e81a1179  "feat(#125):" bare ref -> `referenced` only
--
-- Keyword -> closed by commit. No keyword -> referenced. GitHub behaved as documented in all five.
-- So by the time this sweep reads a commit, GitHub has already closed what the commit named, and
-- the sweep's own decision will be `already-closed`. It is built anyway because #816 was
-- reaffirmed after that finding was filed on the issue; the reasoning is recorded here and in
-- `lib/commit-close-watch.ts` so nobody has to re-derive it.
--
--   last_scanned_commit_sha  the newest default-branch commit this repo's sweep has scanned. NULL
--                            means never scanned, which seeds silently and closes NOTHING — the
--                            same first-sight rule `deploy-watch` learned in #359. Without it the
--                            first sweep after deploy would walk historical commits and close
--                            issues a human deliberately left open.
--   last_scanned_commit_at   the `committer.date` that sha was taken from. This is what makes the
--                            watermark ORDERED rather than merely an identity (#708's lesson,
--                            one table over): GitHub occasionally answers an identical request
--                            with an old snapshot, and an equality-only watermark treats an older
--                            page as news and rolls itself backwards. NULL means UNKNOWN, which
--                            must mean "allow, then record" — never "block".
--   last_commit_scan_at      the rotation key. The sweep is bounded per tick and takes the
--                            oldest-checked repos first, so this is stamped on EVERY outcome
--                            including the ones that do nothing; leaving it unset would pin the
--                            batch to the same repos forever.
--
-- No index beyond the rotation one: the other two columns are read as part of the row the
-- rotation ORDER BY already selects, never searched on.
ALTER TABLE coding_repos ADD COLUMN last_scanned_commit_sha TEXT;
ALTER TABLE coding_repos ADD COLUMN last_scanned_commit_at TEXT;
ALTER TABLE coding_repos ADD COLUMN last_commit_scan_at TEXT;

CREATE INDEX IF NOT EXISTS idx_coding_repos_commit_scan
  ON coding_repos(last_commit_scan_at)
  WHERE github_repo IS NOT NULL AND github_repo <> '';
