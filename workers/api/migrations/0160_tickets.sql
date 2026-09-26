-- First-class tickets (#757, slice 1+2). A board card was only ever a read-time grouping of
-- runtime-task rows (`jobKeyForTask`), so no ticket existed before a run and the ticket->run relation
-- was a Map built on every read. These two tables make both facts durable; the board's read model
-- (`BoardItemView`) is unchanged and the grouping stays as the fallback for cards never promoted.
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  -- The board card this ticket IS. Unique per instance: promoting the same card twice returns the
  -- same ticket, and two concurrent promotions cannot mint two.
  job_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL CHECK (created_by IN ('human', 'agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tickets_instance_job ON tickets(instance_id, job_key);
CREATE INDEX idx_tickets_user ON tickets(user_id, instance_id);

-- A ticket's runs, stored. `status`/`updated_at` are the run's last observed state, so an attempt
-- survives its runtime row being cleared or aged out of the board window.
CREATE TABLE ticket_runs (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  attached_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, task_id)
);
CREATE INDEX idx_ticket_runs_instance ON ticket_runs(instance_id, user_id);
