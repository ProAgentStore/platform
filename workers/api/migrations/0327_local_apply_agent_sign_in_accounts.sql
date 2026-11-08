-- #1619: an Application Runner sign-in that has no saved login may register the account or reset its password.
--
-- `pending_credential_id` is the vault row holding the generated password, stored (provisional) BEFORE the agent types it,
-- so a password the site may have accepted is never lost; it is confirmed only when the agent reports the account signed in.
-- `replaces_credential_id` is the confirmed vault row for the same host that the pending password replaces (a reset).
-- `new_password_at` claims the one new password per run. `link_*` mirror the emailed-code columns for a reset or
-- verification link: when it was asked for and which Gmail message carried it. Ids and times only, never a value.
ALTER TABLE local_apply_agent_sign_ins ADD COLUMN new_password_at INTEGER;
ALTER TABLE local_apply_agent_sign_ins ADD COLUMN pending_credential_id TEXT;
ALTER TABLE local_apply_agent_sign_ins ADD COLUMN replaces_credential_id TEXT;
ALTER TABLE local_apply_agent_sign_ins ADD COLUMN link_requested_at INTEGER;
ALTER TABLE local_apply_agent_sign_ins ADD COLUMN link_message_id TEXT;
