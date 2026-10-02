-- Default-branch CI/deploy health for a coding instance's repos (#903).
--
-- `ci_health` is the stored verdict (JSON, lib/repo-ci-health.ts `RepoCiHealth`) the status routes
-- serve without spending GitHub quota; `ci_alerted` maps workflow path → the failing run the owner
-- was told about, cleared when that workflow goes green, so one red streak notifies once;
-- `ci_checked_at` is the sweep's rotation key, separate from the deploy watcher's.
ALTER TABLE coding_repos ADD COLUMN ci_health TEXT;
ALTER TABLE coding_repos ADD COLUMN ci_alerted TEXT;
ALTER TABLE coding_repos ADD COLUMN ci_checked_at TEXT;
