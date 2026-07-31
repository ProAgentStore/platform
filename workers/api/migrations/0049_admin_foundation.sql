-- Admin/operator portal foundation (epic: PAGS Admin Portal, issue #28).
--
-- 1. admin_audit_log: append-only record of every privileged operator action.
--    Handlers call recordAdminAction() (lib/admin.ts) after a successful mutation.
--    This closes the "no admin audit trail" gap PAS still has.
-- 2. Bootstrap the operator account as admin so the very first admin isn't a
--    chicken-and-egg problem. Idempotent: only touches a matching row that isn't
--    already admin. The ADMIN_ALLOWLIST env var is the break-glass fallback if no
--    row matches yet (see requireAdmin in lib/auth.ts).

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id TEXT NOT NULL,       -- who did it (session uid)
  action        TEXT NOT NULL,       -- e.g. 'user.suspend', 'agent.unpublish', 'platform_ai.toggle'
  target_type   TEXT,                -- 'user' | 'agent' | 'instance' | 'setting' | ...
  target_id     TEXT,                -- the affected row id
  detail        TEXT                 -- JSON: before/after, reason, params
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time  ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_type, target_id, created_at DESC);

-- Operator bootstrap. Google sign-in stores the email in github_login; the GitHub
-- OAuth login is 'serge-ivo'. Grant admin to whichever row exists.
UPDATE users
   SET roles = '["user","admin"]', updated_at = datetime('now')
 WHERE github_login IN ('serge.the.dev@gmail.com', 'serge-ivo')
   AND (roles IS NULL OR roles NOT LIKE '%admin%');
