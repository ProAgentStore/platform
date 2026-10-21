-- #1265: per-machine runner cleanup mode (gentle | harsh) and its per-behaviour switches.
--
-- Cleanup is a property of the MACHINE, not of an agent or a session, so it lives on the per-machine row
-- that already carries the Auto-update policy (`machine_policies`, keyed by the stable machine id): it
-- survives offline periods, reconnects and hostname aliases, and the heartbeat already reads it every 30s.
--
--   cleanup_mode       'gentle' (the default for every existing and new machine) or 'harsh'. Gentle touches only
--                      what the runner can prove it started; harsh also sweeps orphans and prunes caches.
--   cleanup_overrides  JSON {behaviour: boolean}. The mode sets the six switches' defaults; an entry here
--                      overrides one for this machine. Changing the mode clears it (the master toggle resets the
--                      checkboxes) unless the same request sets overrides.
--   cleanup_report     the runner's own last status (mode in force, leftovers found and NOT touched, load and disk
--                      warnings, its last pass) as it reported it on the heartbeat. Telemetry, never an instruction.
--   cleanup_now_*      an owner's "clean now": the request time, and the request time the machine reports having
--                      FINISHED. The platform keeps asking on every heartbeat until the two agree.
ALTER TABLE machine_policies ADD COLUMN cleanup_mode TEXT NOT NULL DEFAULT 'gentle' CHECK (cleanup_mode IN ('gentle', 'harsh'));
ALTER TABLE machine_policies ADD COLUMN cleanup_overrides TEXT NOT NULL DEFAULT '{}';
ALTER TABLE machine_policies ADD COLUMN cleanup_report TEXT;
ALTER TABLE machine_policies ADD COLUMN cleanup_report_at INTEGER;
ALTER TABLE machine_policies ADD COLUMN cleanup_now_requested_at INTEGER;
ALTER TABLE machine_policies ADD COLUMN cleanup_now_done_at INTEGER;
