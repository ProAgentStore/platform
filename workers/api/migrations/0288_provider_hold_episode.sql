-- #1344: a hold remembers when its episode began and which model the provider refused.
--
-- `failed_at` is rewritten by every failure, including the hold's own failed probes, so the 7-day give-up measured from it
-- never arrived: a refused key was probed every 6 hours for ever. `first_failed_at` is set when an episode opens and kept
-- while it stays open. `model` is the model the refused request named, so the probe checks the same one: a model-specific
-- 403 used to pass a probe on the default model, clear the hold, and fail again.
ALTER TABLE provider_account_holds ADD COLUMN first_failed_at INTEGER;
ALTER TABLE provider_account_holds ADD COLUMN model TEXT;
UPDATE provider_account_holds SET first_failed_at = failed_at WHERE first_failed_at IS NULL;
