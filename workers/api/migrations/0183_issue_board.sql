-- #895: board cards that ARE the GitHub issues a coder works on.
--
-- The issue's identity lives on the TICKET (#757), not on the `board_items` display overlay: a ticket
-- exists before any run and outlives every run, and `agent_loop_runs.ticket_id` below joins runs to it.
-- One ticket per (instance, repo, issue), enforced by the partial unique index. Its `job_key` is
-- `issue:<repo_id>#<number>`, so `recordTicket`'s own (instance_id, job_key) uniqueness agrees.
--
--   repo_id       the `coding_repos` row the issue belongs to (owner/repo via `github_repo`).
--   issue_number  the GitHub issue number.
--   issue_cache   JSON {number,title,state,stateReason,labels,assignees,url,closedAt,updatedAt,summary},
--                 refreshed by the issue sync (lib/issue-sync.ts). The board reads ONLY this cache —
--                 it polls every 2.5s and must never call GitHub.
--   linked_by     how the link was made: `explicit` (a caller named the issue), `objective` (parsed
--                 from the run's objective text, so correctable), `manual` (a person linked a card),
--                 `sync` (the issue sync found an open issue no run had touched — the backlog).
ALTER TABLE tickets ADD COLUMN repo_id TEXT;
ALTER TABLE tickets ADD COLUMN issue_number INTEGER;
ALTER TABLE tickets ADD COLUMN issue_cache TEXT;
ALTER TABLE tickets ADD COLUMN linked_by TEXT CHECK (linked_by IS NULL OR linked_by IN ('explicit', 'objective', 'manual', 'sync'));
CREATE UNIQUE INDEX idx_tickets_issue ON tickets(instance_id, repo_id, issue_number) WHERE issue_number IS NOT NULL;

-- Which run worked on which ticket. Nullable: an ad-hoc objective that names no issue has no ticket.
ALTER TABLE agent_loop_runs ADD COLUMN ticket_id TEXT;
CREATE INDEX idx_agent_loop_runs_ticket ON agent_loop_runs(ticket_id) WHERE ticket_id IS NOT NULL;

-- Every closing reference a scanned default-branch commit made ("Closes #N"), recorded whether or not
-- the platform closed the issue itself — so a Done card can name the commit that closed it.
CREATE TABLE issue_closures (
  repo_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  sha TEXT NOT NULL,
  committed_at TEXT,
  source TEXT NOT NULL DEFAULT 'commit' CHECK (source IN ('commit', 'pr')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, issue_number, sha)
);

-- The #682 card → issue link kept its issue number but dropped the repo, so a multi-repo instance
-- could not refresh it. The repo is now stored per card (`owner/repo`).
ALTER TABLE board_items ADD COLUMN github_repo TEXT;

-- The issue sync's rotation key and watermark, per repo — the `commit-close` pattern (0153).
--   issues_synced_at     ms epoch of the last sync of this repo; oldest first, so a bounded batch rotates.
--   issues_synced_since  the newest `updated_at` already seen; the next sync asks GitHub `since` it.
ALTER TABLE coding_repos ADD COLUMN issues_synced_at INTEGER;
ALTER TABLE coding_repos ADD COLUMN issues_synced_since TEXT;
