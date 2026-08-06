-- Server-side deploy notifications (#6).
--
-- The console polls GitHub Actions for the deploy badge, but only while it is open — so the one
-- moment you actually want to know ("is it green yet?") is the moment you closed the tab. The
-- cron sweep in lib/deploy-watch.ts needs two pieces of state per repo:
--
--   last_deploy_run_id      the watermark. A run is notified once, ever. NULL means "never
--                           looked", which the sweep treats as first sight: it records the id
--                           silently and speaks only for the NEXT run. Without that, the first
--                           sweep after deploy would push every user a notification about a
--                           build that finished days ago.
--   last_deploy_checked_at  the rotation key. The sweep is bounded (GitHub is rate-limited per
--                           installation and this runs every minute), so it takes the least
--                           recently checked repos. Stamped on every check, including the ones
--                           that notified nothing — otherwise the batch would pin to the same
--                           repos and starve the tail.
ALTER TABLE coding_repos ADD COLUMN last_deploy_run_id TEXT;
ALTER TABLE coding_repos ADD COLUMN last_deploy_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_coding_repos_deploy_watch
  ON coding_repos(last_deploy_checked_at)
  WHERE github_repo IS NOT NULL;
