-- In-session feedback: what the OWNER said was wrong, anchored to the turn it is about (#514).
--
-- WHY ITS OWN TABLE, and not the three obvious homes.
--
--   * not vectors  — a feedback list must be complete and exact. "The three complaints I made
--     about this agent" is a SELECT, not a top-k similarity search.
--   * not memory   — memoryPrompt is injected on EVERY turn (agent-think.ts), so a growing
--     complaint log becomes a growing per-turn token cost. Worse, memory STEERS: an agent that
--     reads "you got this wrong" every turn apologises instead of working (#226, #495).
--   * not agent_events — that table prunes opportunistically at 14 days (lib/events.ts) and its
--     own docstring says "a debugging aid, not an archive". Feedback IS the archive: the request
--     was "later, when we improve it". It also has no mutable column, correctly, and feedback has
--     a life cycle (open → triaged → filed → dismissed) and a link to what it became.
--
-- Modelled on error_log (0034: owner-scoped, its own read route) and board_items (0036: persist
-- only what the automation cannot know — here, what the human thought).
--
-- POINTERS **AND** SNAPSHOTS, deliberately. A pointer alone dangles: clearing the chat deletes
-- every message and its R2 audio (agent-do.ts), delete-turn (#342) removes a span, and the trace
-- self-prunes at 14 days. A snapshot alone loses the tool calls, which is what #503/#504 were
-- actually built from. Keep both: the read surface renders the snapshot and offers the trace link,
-- which degrades honestly when the trace is gone.
--
-- NO RETENTION SWEEP ON THIS TABLE. Do not add one by symmetry with error_log/agent_events — the
-- whole point is that it outlives them.
CREATE TABLE IF NOT EXISTS agent_feedback (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,             -- ms epoch: ordering, and the join axis to agent_events.ts
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  user_id       TEXT NOT NULL,
  instance_id   TEXT NOT NULL,
  author        TEXT NOT NULL DEFAULT 'user', -- 'user' (console affordance) | 'agent' (record_feedback)
  surface       TEXT NOT NULL,                -- 'chat' | 'coding' | 'board' | 'apply' | 'other'
  sentiment     TEXT,                         -- 'bad' | 'good' | NULL
  body          TEXT NOT NULL,                -- what the owner said

  -- POINTERS: full fidelity while the referents live
  trace_id      TEXT,                         -- agent_events.trace_id for this turn (#514 step 1)
  message_id    TEXT,                         -- AgentMessage.id in the instance DO
  session_id    TEXT,                         -- coding_sessions.id
  timeline_seq  INTEGER,                      -- coding_timeline.seq (0023 — a stable PK)

  -- SNAPSHOT: survives Clear chat, delete-turn (#342) and the 14-day trace prune
  target_role   TEXT,                         -- 'assistant' | 'user' | 'system'
  target_text   TEXT,                         -- the message complained about
  target_at     TEXT,                         -- its createdAt
  prompt_text   TEXT,                         -- the PRECEDING user turn (#505's evidence)
  context       TEXT,                         -- JSON: {agentSlug, model, audioKey, dictation, …}

  -- TRIAGE
  status        TEXT NOT NULL DEFAULT 'open', -- open | triaged | filed | dismissed
  issue_url     TEXT,                         -- what it became; #506's github_create_issue closes the loop here
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_ts     ON agent_feedback(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_instance_ts ON agent_feedback(instance_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_trace       ON agent_feedback(trace_id);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_status      ON agent_feedback(user_id, status, ts DESC);
