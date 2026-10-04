-- Secure input request storage for ephemeral secrets / one-time handoff (#906)
--
-- Stores opaque secure-input requests that agents can create and inject (to tmux/stdin/env)
-- without the secret value ever being returned to the model, chat transcript, or tool results.
--
-- Secrets are envelope-encrypted (KEY_ENCRYPTION_KEY); the plaintext exists only briefly
-- in memory during one-shot consumption and is never logged, returned by any API route, or
-- visible in the console. Metadata audit only: who requested, when, status, success/failure.

CREATE TABLE secure_input_requests (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- ('pending': waiting for user input; 'ready': input received, encrypted, waiting to inject;
  --  'consumed': successfully injected and deleted; 'expired': TTL elapsed)
  label TEXT NOT NULL,
  purpose TEXT,
  destination_scope TEXT NOT NULL,
  -- Where this secret will be injected: 'tmux', 'env', 'stdin', 'file' (determines permissions/cleanup)
  secret_ciphertext BLOB,
  -- Encrypted secret value; NULL until user provides input. Must be deleted immediately after consume.
  dek_wrapped BLOB,
  iv BLOB,
  one_shot BOOLEAN NOT NULL DEFAULT 1,
  -- If 1: secret is atomically consumed exactly once, then deleted. If 0: reusable (future feature).
  expires_at TEXT NOT NULL,
  -- SQL format (e.g., '2026-10-04 12:34:56') for purge predicate: datetime('now').
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT,
  FOREIGN KEY (instance_id) REFERENCES agents (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_secure_input_instance ON secure_input_requests (instance_id, user_id);
CREATE INDEX idx_secure_input_expires ON secure_input_requests (expires_at);
CREATE INDEX idx_secure_input_status ON secure_input_requests (status);
