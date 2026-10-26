-- #1379: a repo's folder is stored HOME-RELATIVE (`~/dev/stores/pas/apps/hiring`) and each machine expands it against its own home, so a
-- coder moved to a machine with another user name no longer fails on `/Users/<old user>/...`. These columns are the debugging trail of
-- that translation: the absolute path the LAST machine to start a session here resolved it to, the rule that produced it
-- (tilde | relative | foreign-home | absolute) and when. `workdir` stays the source of truth; these are only ever written from a runner's
-- answer and never read to decide anything.
ALTER TABLE coding_repos ADD COLUMN workdir_resolved TEXT;
ALTER TABLE coding_repos ADD COLUMN workdir_resolved_via TEXT;
ALTER TABLE coding_repos ADD COLUMN workdir_resolved_at TEXT;
