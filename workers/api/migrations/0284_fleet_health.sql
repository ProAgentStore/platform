-- #1320: fleet visibility without a manual check. A machine that stops reporting its capabilities, falls behind the
-- latest release, fails an update or restarts in a loop raises ONE alert per episode, and clears it when it recovers.
CREATE TABLE IF NOT EXISTS fleet_alerts (
  user_id    TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('capability_missing', 'capability_stale', 'version_drift', 'update_failed', 'crash_loop')),
  detail     TEXT NOT NULL,
  raised_at  INTEGER NOT NULL,
  cleared_at INTEGER,
  PRIMARY KEY (user_id, machine_id, kind, raised_at)
);
CREATE INDEX IF NOT EXISTS idx_fleet_alerts_open ON fleet_alerts(user_id, machine_id, kind, cleared_at);

-- The newest published CLI release the platform has seen, and when it first saw it: drift is measured from there, not from
-- the moment a machine happened to check, so a release published a minute ago is not a fleet failure.
CREATE TABLE IF NOT EXISTS fleet_release_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
