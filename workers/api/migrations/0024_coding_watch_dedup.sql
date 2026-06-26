-- Dedupe the per-message "watcher" workflow so a session can't fire several push
-- notifications for one completion. Every ➤ send spawns a durable watcher; only
-- the LATEST one should notify. We stamp each session with the id of its most
-- recent watcher; a watcher checks this before notifying and bows out if a newer
-- send has superseded it.
ALTER TABLE coding_sessions ADD COLUMN watch_workflow_id TEXT;
