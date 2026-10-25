-- #1192: a coding engine runs as the same OS user as `pags up`, so a session stored in ~/.config/proagentstore is one the engine
-- can read. A file cannot be made unreadable to it; what can be changed is what the file is WORTH. A "runner-only" device sign-in
-- carries `scope: runner`: it works for the routes a runner itself calls (list its agents, register, heartbeat, relay tokens,
-- crash reports, its watchdog) and is refused everywhere else — billing, agents, secrets, the account. It is a device credential
-- (#1184), so it is also one machine's and revocable on its own.
--
--   device_authorizations.requested_scope   what the machine asked for (`pags login --device --runner-only`); shown on the approval page
--   device_authorizations.scope             what the owner approved: NULL = full session, 'runner' = runner-only
--   device_credentials.scope                carried onto the credential, so a renewal keeps it
ALTER TABLE device_authorizations ADD COLUMN requested_scope TEXT;
ALTER TABLE device_authorizations ADD COLUMN scope TEXT;
ALTER TABLE device_credentials ADD COLUMN scope TEXT;
