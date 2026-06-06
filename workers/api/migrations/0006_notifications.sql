-- Notifications: track events for creators (subscriptions, usage milestones)
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,          -- subscribe, milestone, system
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  agent_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notifications_user ON notifications(user_id, read, created_at);
