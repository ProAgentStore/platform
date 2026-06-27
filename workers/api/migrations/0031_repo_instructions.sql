-- Per-repo special instructions: injected into the co-pilot prompt when
-- chatting about this repo and into the Overseer's per-repo context.
ALTER TABLE coding_repos ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
