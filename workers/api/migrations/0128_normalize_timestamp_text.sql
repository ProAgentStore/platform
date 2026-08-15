-- Normalise the TEXT timestamp columns that are compared against `datetime('now')` (#634, #657).
--
-- SQLite compares TEXT bytewise. `' '` is 0x20 and `'T'` is 0x54, so for two stamps on the same
-- date an ISO-8601 string always sorts ABOVE a `datetime('now')` one, whatever the clock said:
--
--   sqlite> SELECT '2026-08-15T00:00:01.000Z' > '2026-08-15 22:38:19';  -- 1
--
-- Three columns had writers in both formats, which makes them two disjoint blocks rather than one
-- ordering:
--
--   • instance_runtime_tasks.updated_at (#634) — eleven `datetime('now')` writers against three
--     ISO ones. `recentWorkForInstances` returns EIGHT cards per subordinate, so a supervisor's
--     eight were whichever block won the byte comparison; the escalation card that says "a
--     supervised agent needs a decision" lost its slot to any runner task mirrored earlier the
--     same day. The apply/browse single-flight claims compare the same column against a bound
--     cutoff, so they were reading the mixed column too.
--   • instance_runtime_task_events.created_at — one ISO writer today, so it is not broken; it is
--     converted with the others because its ONLY writer now emits the column format, and leaving
--     the old rows behind is what would make it mixed.
--   • mcp_input_requests.expires_at / mcp_oauth_flows.expires_at (#657) — written ISO and purged
--     with `expires_at <= datetime('now')`, a predicate that stays false for the whole UTC day the
--     row expires on. Encrypted call arguments (30-minute TTL) and a PKCE verifier (10-minute TTL)
--     outlived their stated retention by up to ~24 h.
--
-- The code fix alone converges within a day, because the surviving ISO rows age out. This makes it
-- immediate: the window where an old ISO row still outranks a new one is exactly the window a
-- supervisor would be reading the wrong eight cards in.
--
-- `substr(x, 1, 19)` drops the fractional seconds and the `Z`; `replace(…, 'T', ' ')` gives the
-- separator `datetime('now')` uses. Guarded by a LIKE that only matches the ISO shape, so a row
-- already in the column format is untouched and re-running is a no-op.

UPDATE instance_runtime_tasks
   SET updated_at = replace(substr(updated_at, 1, 19), 'T', ' ')
 WHERE updated_at LIKE '____-__-__T%';

UPDATE instance_runtime_tasks
   SET created_at = replace(substr(created_at, 1, 19), 'T', ' ')
 WHERE created_at LIKE '____-__-__T%';

UPDATE instance_runtime_task_events
   SET created_at = replace(substr(created_at, 1, 19), 'T', ' ')
 WHERE created_at LIKE '____-__-__T%';

UPDATE mcp_input_requests
   SET expires_at = replace(substr(expires_at, 1, 19), 'T', ' ')
 WHERE expires_at LIKE '____-__-__T%';

UPDATE mcp_oauth_flows
   SET expires_at = replace(substr(expires_at, 1, 19), 'T', ' ')
 WHERE expires_at LIKE '____-__-__T%';
