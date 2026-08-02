-- Link a real GitHub username to any account so GitHub-App org-install verification can
-- check membership. Google sign-in stores the EMAIL in github_login (migration 0049), which
-- is not a valid GitHub login — so a Google-authenticated user could never bind a GitHub App
-- installation. `linked_github_login` is set by the /v1/auth/github/link flow onto the CURRENT
-- account (no account switch); the App verifier prefers it over github_login.
ALTER TABLE users ADD COLUMN linked_github_login TEXT;
