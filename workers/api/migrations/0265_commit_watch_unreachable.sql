-- #1246: a repo the commit-close watch cannot reach is recorded once and backed off.
--
-- 45,980 error occurrences in 30 days, ~40k of them this sweep re-declining the same repos every
-- tick: vibecodeqa/* and freemarketingstore-online/platform have no GitHub App installation,
-- proagentstore-online/platform names an org that does not exist (the repo is ProAgentStore/platform),
-- proappstore-online/chess-academy moved to ChessClubs-online/chess-clubs, and serge-ivo/stores-workspace
-- is private and outside the installation. None of that changes between ticks.
--
-- `commit_watch_unreachable` is why (logged when it first appears or changes, never on a retry), the
-- `_repo` column is the binding it was true for — a repo re-pointed at another slug is tried at once —
-- and `commit_watch_retry_at` is when the sweep may look again.
ALTER TABLE coding_repos ADD COLUMN commit_watch_unreachable TEXT;
ALTER TABLE coding_repos ADD COLUMN commit_watch_unreachable_repo TEXT;
ALTER TABLE coding_repos ADD COLUMN commit_watch_retry_at TEXT;
