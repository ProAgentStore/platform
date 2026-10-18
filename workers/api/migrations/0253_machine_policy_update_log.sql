-- #1151: the step-by-step update log a runner keeps locally (`packages/cli/src/bootstrap/update-log.ts`), its newest
-- ≤4000 characters, as the first registration after a restart uploads it. On 2026-10-17 three machines reported
-- `installing` and went silent, and nothing recorded which step of the update had died; this is where the next one
-- shows up on the machine's record. Additive and nullable: an older runner sends none and its row reads as before.
ALTER TABLE machine_policies ADD COLUMN update_log TEXT;
