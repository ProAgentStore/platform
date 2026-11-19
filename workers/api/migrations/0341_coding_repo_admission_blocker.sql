-- #1515: a repo-level admission blocker. A run stopped at its pre-flight (the dirty/behind sync gate, #801) is not a
-- verdict on its objective: every objective queued behind it meets the SAME blocker. The blocker is recorded on the repo
-- so the queue holds its place behind ONE actionable condition instead of starting — and failing — each entry in turn.
-- Cleared when the checkout is put right (a repair run, stash_checkout/discard_checkout, or a run that passes the gate).
ALTER TABLE coding_repos ADD COLUMN admission_blocker TEXT;
ALTER TABLE coding_repos ADD COLUMN admission_blocker_at INTEGER;
ALTER TABLE coding_repos ADD COLUMN admission_blocker_run_id TEXT;
