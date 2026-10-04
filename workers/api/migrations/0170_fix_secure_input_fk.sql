-- Fix foreign key constraint on secure_input_requests.instance_id (#907)
--
-- The secure_input_requests table was created with:
--   FOREIGN KEY (instance_id) REFERENCES agents (id)
--
-- But secure_input_requests are created by agents on their INSTANCES (agent_instances),
-- not on the agent templates (agents). The route handler validates against agent_instances,
-- not agents, causing FK constraint violations.
--
-- Fix: Recreate the table with the correct FK:
--   FOREIGN KEY (instance_id) REFERENCES agent_instances (id)
--
-- SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we:
-- 1. Create a new table with the correct schema
-- 2. Copy data from the old table
-- 3. Drop the old table
-- 4. Rename the new table
-- 5. Recreate indexes

CREATE TABLE secure_input_requests_new (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  label TEXT NOT NULL,
  purpose TEXT,
  destination_scope TEXT NOT NULL,
  secret_ciphertext BLOB,
  dek_wrapped BLOB,
  iv BLOB,
  one_shot BOOLEAN NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT,
  FOREIGN KEY (instance_id) REFERENCES agent_instances (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Copy existing data to preserve any pending/ready/consumed requests
INSERT INTO secure_input_requests_new
SELECT id, instance_id, user_id, status, label, purpose, destination_scope, 
       secret_ciphertext, dek_wrapped, iv, one_shot, expires_at, created_at, updated_at, consumed_at
FROM secure_input_requests;

-- Drop the old table with the wrong FK
DROP TABLE secure_input_requests;

-- Rename the new table
ALTER TABLE secure_input_requests_new RENAME TO secure_input_requests;

-- Recreate indexes from migration 0169
CREATE INDEX idx_secure_input_instance ON secure_input_requests (instance_id, user_id);
CREATE INDEX idx_secure_input_expires ON secure_input_requests (expires_at);
CREATE INDEX idx_secure_input_status ON secure_input_requests (status);
