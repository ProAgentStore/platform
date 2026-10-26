-- #1057 slice 3: the HALT on a machine's native control. One row per (owner, machine) while halted; deleted on resume.
-- Set by the agent's own `native_halt` tool or by the owner; cleared ONLY by the owner (POST …/native-resume). While a row exists every
-- native act tool (launch, click, type, key, scroll, screenshot) is refused by the cloud before the runner is asked anything, and the
-- runner is told too (its own flag, so the stop holds even if the cloud later cannot be reached). `by` is 'agent' or 'owner'. The
-- reason is free text from the caller, clipped, and never screen content.
CREATE TABLE IF NOT EXISTS native_halts (
  user_id    TEXT NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL,
  halted_by  TEXT NOT NULL CHECK (halted_by IN ('agent', 'owner')),
  reason     TEXT,
  halted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, machine_id)
);
