-- Optionally back a board card with a GitHub issue (#682).
--
-- A card can be linked to one issue by number. The number is the stable key (it never
-- changes for the life of the issue); the title/state/labels projection is a CACHE
-- fetched from GitHub and stored here so the board can render without a live GitHub
-- call. The cache is refreshed explicitly (POST /board/github-issues/refresh) or on
-- link. Both columns are nullable: absent = not linked to any issue.
--
-- The github_repo (owner/repo) lives in agent_instances.config.boardGithubRepo, not
-- here: it is a per-instance setting that applies to the whole board, not per-card.
ALTER TABLE board_items ADD COLUMN github_issue_number INTEGER;
ALTER TABLE board_items ADD COLUMN github_issue_cache  TEXT NOT NULL DEFAULT '';
