-- One active coding session per repo. Two would share the repo's single working
-- directory → concurrent edits + git index races. The POST /sessions route already
-- reuses the live one, but sessions created before that (or via a race) left
-- duplicates. End the extras (keep the most recent per repo), then enforce it at
-- the DB level so no code path or race can ever create a second.
UPDATE coding_sessions
   SET status = 'ended', ended_at = datetime('now'), updated_at = datetime('now')
 WHERE status = 'active'
   AND rowid NOT IN (SELECT MAX(rowid) FROM coding_sessions WHERE status = 'active' GROUP BY repo_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_sessions_one_active
    ON coding_sessions(repo_id) WHERE status = 'active';
