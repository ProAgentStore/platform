-- #1670: a repository's checkout-isolation + publishing strategy, one of the three supported presets
-- (shared-direct | isolated-direct | isolated-pr). NULL = nothing chosen = shared/direct, exactly what every
-- existing repository does today: no row is backfilled and no direct-to-main repository changes workflow.
ALTER TABLE coding_repos ADD COLUMN strategy TEXT;
