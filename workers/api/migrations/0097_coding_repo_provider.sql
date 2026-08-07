-- Provider-neutral repo identity for the Coder (#221, phase 1).
--
-- `github_repo` was the only hosted identity a repo could have, so a GitLab or Bitbucket repo
-- could only be stored by leaving it empty — which made it indistinguishable from a local
-- checkout. The console then badged it "local", the issues route told the owner it "isn't
-- connected to GitHub", and nothing could tell a clone credential where it was allowed to go.
--
--   provider   which host this repo lives on: local | github | gitlab | bitbucket | other.
--              'other' is a real git remote on a host PAGS has no integration for (self-managed
--              GitLab, Gitea, an internal mirror). Calling that 'local' would be the same lie
--              this migration exists to stop.
--   repo_slug  the hosted coordinate, provider-neutral. `owner/name` everywhere except GitLab,
--              whose namespaces nest (`group/subgroup/project`) — which is exactly why the
--              GitHub-shaped `owner/repo` column could not be generalised in place.
--   web_url    where a human opens it. Derived at add time; GitHub rows have none yet and the
--              console falls back to the slug, so this is additive rather than a backfill.
--
-- `github_repo` is DELIBERATELY left populated and still written for GitHub repos. Every GitHub
-- reader (issues, Actions/builds, deploy watch, the supervisor's repo coordinates, voice
-- vocabulary) keeps reading it byte-for-byte, so this migration cannot regress the one provider
-- that works today. Retiring it is a later, separate decision.
ALTER TABLE coding_repos ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE coding_repos ADD COLUMN repo_slug TEXT;
ALTER TABLE coding_repos ADD COLUMN web_url TEXT;

-- Backfill, most specific first. A row carrying `github_repo` IS a GitHub repo — that is the
-- only thing the column could ever have meant.
UPDATE coding_repos
   SET provider = 'github',
       repo_slug = github_repo,
       web_url = 'https://github.com/' || github_repo
 WHERE github_repo IS NOT NULL AND github_repo <> '';

-- Rows with only a clone URL: infer from the host. These are the repos that were already being
-- mis-reported as local, so this is the half of the backfill that changes what a user sees.
UPDATE coding_repos
   SET provider = CASE
         WHEN clone_url LIKE '%github.com%' THEN 'github'
         WHEN clone_url LIKE '%gitlab.com%' THEN 'gitlab'
         WHEN clone_url LIKE '%bitbucket.org%' THEN 'bitbucket'
         ELSE 'other'
       END
 WHERE (github_repo IS NULL OR github_repo = '')
   AND clone_url IS NOT NULL AND clone_url <> '';
