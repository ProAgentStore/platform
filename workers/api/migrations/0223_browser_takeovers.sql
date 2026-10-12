-- #1031: a takeover is a DURABLE record before any remote control is shown.
--
-- A runner's human-takeover session lived only in the runner's memory and the console's proxy: nothing
-- recorded that a person had been asked, had opened it, had handed it back, or had never come. This is
-- that record, one row per request, owner-scoped. It deliberately holds NO page URL, frame, cookie,
-- token, session or page content — only ids, a closed vocabulary and times. The runner remains the only
-- place a page lives.
--
-- States: requested → active (opened) → resumed (handed back to the run); requested|active → ended
-- (declined, or the run finished) | expired (nobody came before expires_at; the per-minute cron).
-- requested → resumed is allowed too: an owner may fix things at the machine itself and resume.
CREATE TABLE IF NOT EXISTS browser_takeovers (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL REFERENCES agent_instances(id),
  agent_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  -- What is waiting on a person: a local browser run, a runner task, or an owner's own request.
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('local_browser_run', 'runtime_task', 'manual')),
  subject_id    TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('requested', 'active', 'resumed', 'ended', 'expired')),
  reason        TEXT NOT NULL CHECK (reason IN ('login_required', 'captcha', 'consent_required', 'access_blocked', 'paywall', 'write_affordance', 'manual')),
  -- The owner's takeover preference when it was requested (#1031 allowMobile): may it be answered from a phone.
  mobile_allowed INTEGER NOT NULL DEFAULT 1,
  -- Closed vocabulary, why it ended: declined | run_finished | resumed_at_machine | expired.
  end_reason    TEXT,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  activated_at  INTEGER,
  ended_at      INTEGER,
  updated_at    INTEGER NOT NULL
);
-- One LIVE takeover per subject: a repeated request joins it instead of asking twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_takeovers_live
  ON browser_takeovers(instance_id, subject_kind, subject_id) WHERE state IN ('requested', 'active');
CREATE INDEX IF NOT EXISTS idx_browser_takeovers_owner
  ON browser_takeovers(user_id, instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_takeovers_expiry
  ON browser_takeovers(state, expires_at);
