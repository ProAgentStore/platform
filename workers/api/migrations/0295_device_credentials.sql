-- #1184: runner sign-ins that are per machine, revocable, and of a lifetime the owner chooses.
--
-- A device sign-in (`pags login --device`, #1157) minted the same fixed 30-day, full-account session every browser login
-- gets: nothing said which machine held it, it could not be withdrawn without ending every session of the account, and its
-- length was not the owner's. Now each approved device gets a credential row; the session carries its id (`did`), every
-- request from it is checked against the row, and the owner can list the machines and revoke one.
--
--   users.runner_session_days             the owner's default for NEW device credentials: 30, 90 or 180 (NULL = 30)
--   device_authorizations.lifetime_days   the length chosen on the approval page for THIS request (NULL = the owner's default)
--   device_credentials                    one row per approved machine; revoked_at set = the sign-in stops working at once
ALTER TABLE users ADD COLUMN runner_session_days INTEGER;
ALTER TABLE device_authorizations ADD COLUMN lifetime_days INTEGER;

CREATE TABLE device_credentials (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  node              TEXT,
  lifetime_days     INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  last_refreshed_at INTEGER,
  revoked_at        INTEGER
);
CREATE INDEX idx_device_credentials_user ON device_credentials(user_id, revoked_at);
