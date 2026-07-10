-- Persistent per-message translation/transliteration cache. Glosses were
-- recomputed on every page load (visible pop-in + repeated AI cost) and only
-- the last few messages were auto-translated. Keyed by content hash so edits/
-- re-sends re-translate; scoped per instance + target + transliterate mode.

CREATE TABLE IF NOT EXISTS message_gloss (
	instance_id TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	target TEXT NOT NULL,
	transliterate INTEGER NOT NULL DEFAULT 0,
	translation TEXT NOT NULL,
	transliteration TEXT,
	pairs TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (instance_id, content_hash, target, transliterate)
);
