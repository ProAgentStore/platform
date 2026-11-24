-- #1697: owner-scoped triage for the "Needs you" inbox (#1640). Keyed to the specific coder question or parked run
-- (`coder_question:<id>` / `run_parked:<runId>`), so a new question in the same session starts New. Triage is only the
-- owner's own bookkeeping: it never answers, resumes or expires anything, and the item stays in the inbox.
CREATE TABLE IF NOT EXISTS inbox_triage (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'discussed', 'deferred')),
  needs_computer INTEGER NOT NULL DEFAULT 0,
  defer_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
