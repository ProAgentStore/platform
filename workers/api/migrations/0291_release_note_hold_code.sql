-- #1349: why a note was held for good. `status` 'held' is new (free text): the evidence for the note is
-- permanently incomplete or inconsistent (a range over 250 commits, more than 1,000 workflow runs, drifting
-- compare metadata, a pushed branch that is not the default branch). `hold_code` is the typed reason the owner
-- reads beside the human `reason`; it is NULL for every other status.
ALTER TABLE release_note_queue ADD COLUMN hold_code TEXT;
