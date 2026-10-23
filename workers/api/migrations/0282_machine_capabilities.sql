-- #1312: what each machine can actually do, so work is never routed to one that cannot run it.
--
-- One bounded record per MACHINE (the stable machine id, not the hostname), written from the runner's
-- registration and refreshed when its hash changes. `raw_json` is the validated, size-capped record the
-- runner sent (names, versions and probe results only: no paths, usernames, environment or secrets); the
-- columns beside it are the facts selection and the console read without parsing it.
CREATE TABLE IF NOT EXISTS machine_capabilities (
  machine_id         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  detected_at        TEXT NOT NULL,
  os_name            TEXT NOT NULL,
  os_version         TEXT NOT NULL,
  arch               TEXT NOT NULL,
  cpu_count          INTEGER,
  memory_gb          REAL,
  disk_gb            REAL,
  playwright_version TEXT,
  browser_probe_results TEXT,
  ios_support        INTEGER NOT NULL DEFAULT 0,
  android_support    INTEGER NOT NULL DEFAULT 0,
  docker_support     INTEGER NOT NULL DEFAULT 0,
  node_version       TEXT,
  runtime_inventory  TEXT,
  capability_hash    TEXT NOT NULL,
  raw_json           TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_machine_capabilities_user ON machine_capabilities(user_id);

-- Every change to the record, with what changed: a laptop whose WebKit stopped launching after an OS update
-- leaves the fact and the moment, not just the latest state. Kept per machine, newest first, pruned by the writer.
CREATE TABLE IF NOT EXISTS machine_capability_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  changed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  capability_hash TEXT NOT NULL,
  diff_json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_machine_capability_history_machine ON machine_capability_history(machine_id, id DESC);
