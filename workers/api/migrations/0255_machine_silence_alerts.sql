-- #1162: tell the owner when a runner machine goes silent.
--
-- On 2026-10-17/18 three machines were dark for hours and the owner found out by looking: the only
-- sweep that noticed a silent machine (mid-update, `failSilentUpdates`) wrote an error_log row, which
-- nobody is pushed. `notifySilentMachines` (lib/machine-silence.ts) now sends one notification per
-- SILENCE: a machine's key and the `last_seen_at` it went quiet at. A machine that reports again and
-- goes quiet later has a different `last_seen_at`, so it is told about again; the same silence never is.
--   machine_key: the stable machine id when the runner sends one, else its hostname (`runner_node`).
CREATE TABLE machine_silence_alerts (
  user_id TEXT NOT NULL,
  machine_key TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  notified_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, machine_key)
);
