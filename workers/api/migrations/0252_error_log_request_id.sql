-- Which REQUEST wrote an error row (#1135).
--
-- 0239 gave a row its instance and run; nothing said which HTTP request it was written inside, so an
-- API crash could not be joined to the call that caused it — or to that call's MCP outcome event and
-- trace rows. `logError` now stamps the id of the request it runs inside (`lib/request-context.ts`).
--
-- ── Why NOT part of the collapse identity
--
-- Unlike instance and run, a request id is a per-occurrence value: every request has its own. Keying
-- the collapse on it would never fold anything, which is #423's flood. So it is recorded the way the
-- context is (#538): `request_id` is the request that OPENED the row, `last_request_id` the one most
-- recently absorbed into it — both ends of a repeated row are joinable, and the request filter
-- matches either.
--
-- ── Legacy rows
--
-- NULL in both, not backfilled: no record says which request wrote them. Rows written outside any
-- request (a Durable Object, Workflow, cron or the spool's replay of one) are NULL too.
ALTER TABLE error_log ADD COLUMN request_id TEXT;
ALTER TABLE error_log ADD COLUMN last_request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_error_log_request_id ON error_log(request_id);
CREATE INDEX IF NOT EXISTS idx_error_log_last_request_id ON error_log(last_request_id);
