-- Several accounts of the same kind, per user (#715).
--
-- THE CONSTRAINT THIS REMOVES. `user_api_keys` has been `PRIMARY KEY (user_id, provider)` since
-- 0003, when it held nothing but AI provider keys — and for those, one row per provider is
-- correct: you have one Anthropic key. Gmail, Drive, WorkDrive and Sheets later reused the table
-- because the row shape fit, and inherited a uniqueness constraint nobody chose for them. A
-- person has several mailboxes; which one an agent speaks as is the whole question.
--
-- THIS IS THE THIRD TIME. The same root cause has been worked around twice already, each time
-- with a bespoke table rather than a fix here:
--
--   * `github_installations` (0020) — UNIQUE(user_id, installation_id), many labelled accounts,
--     selectable per repo. It got the shape right because App installations could not use this
--     table at all.
--   * `mcp_credentials` (0083) — and that one closed a SECURITY bug, not an ergonomics gap. One
--     'mcp' slot per user was shared by every endpoint the user ever named, so "a token issued
--     by server A was therefore sent, verbatim, to server B the moment a pipeline step or an
--     agent reading untrusted text pointed at B."
--
-- Two escapes and a credential disclosure is enough evidence that the vault, not each caller,
-- is the thing to fix.
--
-- ── The change ──────────────────────────────────────────────────────────────
-- `account_id` joins the primary key. SQLite cannot alter a primary key in place, so this is a
-- table rebuild: create, copy, drop, rename. No index to recreate (there never was one).
--
-- NOTHING IS RE-ENCRYPTED. The three ciphertext columns are copied byte-for-byte. This migration
-- never needs KEY_ENCRYPTION_KEY and cannot invalidate a stored credential.
--
-- ── Why the backfill uses account_label ─────────────────────────────────────
-- `account_id` is the PROVIDER's own identifier for the account — for Google, the mailbox
-- address — not a surrogate key. That makes reconnecting the same mailbox an UPDATE of the same
-- row rather than a duplicate, which a random id could not guarantee.
--
-- 0035 already records that address in `account_label` for every connection made since, so the
-- backfill promotes it and existing Gmail/Drive connections arrive already correctly identified.
-- A row with no label (an AI provider key, or a connection older than 0035) backfills to '',
-- which is the reserved id meaning "the account's one unnamed credential" — exactly what every
-- caller that has not been made account-aware still asks for, so those keep working untouched.

CREATE TABLE user_api_keys_new (
  user_id        TEXT NOT NULL,
  provider       TEXT NOT NULL,
  -- '' = the unnamed default credential. Non-empty = the provider's own id for the account.
  account_id     TEXT NOT NULL DEFAULT '',
  key_ciphertext BLOB NOT NULL,
  dek_wrapped    BLOB NOT NULL,
  iv             BLOB NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT,
  account_label  TEXT,
  granted_scopes TEXT,
  PRIMARY KEY (user_id, provider, account_id)
);

INSERT INTO user_api_keys_new (
  user_id, provider, account_id, key_ciphertext, dek_wrapped, iv,
  created_at, last_used_at, account_label, granted_scopes
)
SELECT
  user_id,
  provider,
  -- Promote the recorded address to the id. TRIM guards a label that is present but blank;
  -- COALESCE guards NULL. Both land on '', the unnamed-default id.
  COALESCE(NULLIF(TRIM(account_label), ''), ''),
  key_ciphertext, dek_wrapped, iv,
  created_at, last_used_at, account_label, granted_scopes
FROM user_api_keys;

DROP TABLE user_api_keys;
ALTER TABLE user_api_keys_new RENAME TO user_api_keys;

-- Listing a user's accounts for one provider is now a real query rather than a point lookup,
-- and it runs on the connect page and on every instance settings load.
CREATE INDEX IF NOT EXISTS idx_user_api_keys_provider ON user_api_keys(user_id, provider);
