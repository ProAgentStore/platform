-- The durable error log learns SEVERITY and REPETITION (#424, #423).
--
-- ── level
--
-- Not every failure is a bug, and the log had no way to say so, so two whole classes were simply
-- dropped:
--
--   • Transient infrastructure — a Durable Object reset because a deploy replaced its code, a
--     briefly-overloaded DO. `logUnhandled` returned BEFORE writing anything. That was right about
--     severity (the 503 the client gets is the correct answer and it self-heals) and wrong about
--     visibility: "how often does a deploy break a live request?" was unanswerable, and the one
--     occurrence we have on record exists only because a browser happened to report it from the
--     other side.
--   • The diagnostic 4xx — 402 (no API key connected), 403, 409, 429. A user repeatedly hitting a
--     rate limit generated no evidence anywhere.
--
-- Both are now written at 'warn' and excluded from error counts by filter, rather than dropped.
-- The ordinary 4xx (401/404) stay unlogged on purpose: on an SPA they are constant background
-- traffic and logging them would recreate the flood below at higher volume.
--
-- ── repeat_count / last_seen_at
--
-- The READ side has always aggregated identical signatures (`/v1/admin/errors/summary`); the write
-- side inserted a row per occurrence. #423 put 1809 rows in this table in 30 hours with exactly
-- ONE distinct message between them — ~97% of the log — and the log stopped working as a debugging
-- instrument: a search for voice failures returned four rows against a table that was one
-- repeating cron error. An identical failure inside a window now increments a counter on the row
-- already recording it.
--
-- The window is anchored on `created_at`, not on `last_seen_at`, so an ongoing failure produces a
-- new row each hour rather than one row updated forever. That keeps volume strictly bounded (24
-- rows/day/signature at worst) AND keeps a coarse timeline: you can still see when it started, and
-- whether it is still going, which a single perpetually-updated row would hide.
--
-- `last_seen_at` is backfilled from `created_at` so every existing row is already correct. Readers
-- order by it (falling back to `created_at`) so a signature that is still happening stays at the
-- top of the feed instead of sinking to where it first appeared.
ALTER TABLE error_log ADD COLUMN level TEXT NOT NULL DEFAULT 'error';
ALTER TABLE error_log ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE error_log ADD COLUMN last_seen_at TEXT;

UPDATE error_log SET last_seen_at = created_at WHERE last_seen_at IS NULL;

-- The collapse lookup is "this exact signature, in this source, recently". Source + recency is
-- what narrows it; the message equality is then checked over a handful of rows. Not indexed on
-- `message` — it is up to 2000 characters and the table is bounded by a 30-day retention sweep.
CREATE INDEX IF NOT EXISTS idx_error_log_source_time ON error_log(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_last_seen ON error_log(last_seen_at DESC);
