-- Per-repo launch links (dev / staging / production). Stored as JSON; the console
-- renders an open-in-new-tab icon for each one that's set, on both the repos list
-- and the open session, and shows nothing for the empty ones.
ALTER TABLE coding_repos ADD COLUMN urls TEXT;
