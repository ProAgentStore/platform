-- #1191: push crash-loop, sign-in-expiry and resource warnings to the owner, and say when a silent machine is back.
--
-- #1162 told the owner when a machine went silent. The other things a machine's own reports already say stayed pull-only:
-- a crash-looping runner or a rolled-back release, a sign-in about to lapse, CPU / memory / disk pressure. `notifyMachineWarnings`
-- (lib/machine-warnings.ts) raises each through the same mutable `machine` notification type, once per EPISODE:
--   kind          crash_loop | rollback | sign_in | cpu | memory | disk
--   episode_key   what identifies this episode — the sign-in's expiry date, the rolled-back release and its time, "on" for a level
--   active        1 while the signal holds; cleared (0) when a tick finds it gone, so its return is a new episode
--   notified_at   the last push — a signal that flaps is not a stream: a new episode is held back for REPEAT_MS after it
CREATE TABLE machine_warning_alerts (
  user_id     TEXT NOT NULL,
  machine_key TEXT NOT NULL,
  kind        TEXT NOT NULL,
  episode_key TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  notified_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, machine_key, kind)
);

-- "Machine back online" (#1191 asked to decide; wanted: a silence alert that is never followed by an all-clear leaves the owner
-- unsure). Set when the machine reports again after the silence it was told about; a new silence clears it.
ALTER TABLE machine_silence_alerts ADD COLUMN resolved_at INTEGER;
