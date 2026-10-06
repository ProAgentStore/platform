-- The owner's review of each finding a local browser research run returned (#946).
--
-- A run's findings are candidates, not records: the owner saves or skips each one, and only a saved
-- finding is written to the instance collection the run's policy names. #947 asks for a duplicate
-- to be surfaced BEFORE that write, so "this is already in your collection" is a decision state of
-- its own. JSON keyed by the finding's index in `result.findings`:
--   {"3": {"decision": "saved"|"skipped"|"duplicate", "recordId"?, "duplicateOf"?, "collection"?, "at"}}
ALTER TABLE local_browser_runs ADD COLUMN finding_reviews TEXT;
