-- #1147: whether the machine can roll an automatic update back. Under the bootstrap stub a release is installed beside the
-- running one and falls back if it fails; a runner started any other way updates in place with `npm i -g`. The runner
-- reports which it is: 1 = rollback available, 0 = updates in place (a broken release is only undone by the in-place
-- restore of the previous version), NULL = never said (an older runner, or one running from a source checkout).
ALTER TABLE machine_policies ADD COLUMN rollback_available INTEGER;
