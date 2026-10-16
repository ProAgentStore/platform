-- #1077: a run parked on a question RELEASES its checkout so other work runs while it waits.
--   checkout_released_at → when it let go (ms). While set, the run is not an owner of its repo
--                          (`repoOwners` and every "one run at a time" gate skip it) and its session
--                          is `suspended`, keeping its card and its engine resume key.
--   checkout_snapshot    → the exact commit id its uncommitted work was saved as, on the runner's
--                          `refs/pags/parked/<run_id>` (null when the tree was clean). Restored by
--                          that id when the run takes the checkout back on resume.
-- Both cleared when the run re-acquires its checkout. Nothing is pushed.
ALTER TABLE agent_loop_runs ADD COLUMN checkout_released_at INTEGER;
ALTER TABLE agent_loop_runs ADD COLUMN checkout_snapshot TEXT;
