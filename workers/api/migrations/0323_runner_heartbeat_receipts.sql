-- Server receipt evidence only: absent buckets do not establish host/process downtime.
CREATE TABLE runner_heartbeat_receipts (
  user_id TEXT NOT NULL,
  machine_key TEXT NOT NULL,
  bucket_at INTEGER NOT NULL,
  receipts INTEGER NOT NULL,
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, machine_key, bucket_at)
);
CREATE INDEX runner_heartbeat_receipts_retention ON runner_heartbeat_receipts(user_id, bucket_at);
