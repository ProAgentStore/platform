-- Durable dispatch receipts, separate from run health and host-owned approval (#886).
CREATE TABLE loop_start_receipts (
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'started', 'queued', 'not_started', 'unknown')),
  response_json TEXT,
  response_status INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, instance_id, request_id)
);
CREATE INDEX loop_start_receipts_instance ON loop_start_receipts(user_id, instance_id, created_at DESC);
