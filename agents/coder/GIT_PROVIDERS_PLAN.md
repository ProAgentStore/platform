# Coder Git Providers Plan

## Decision

Keep one core Repo Coder implementation. Do not fork the runtime into separate GitHub, GitLab, and Bitbucket coders.

Add provider-specific connector/auth/import/build/issue layers underneath the existing coding surface and `CODING_SESSION` workflow. Provider-branded catalog agents can exist later as presets, but they should be data wrappers over the same Coder implementation.

## Why

The hands are already mostly git-provider-neutral:

- The local runner can work in an existing checkout.
- The runner clone path is generic `git clone`.
- The coding session workflow drives a CLI inside a directory, not inside GitHub.

The GitHub coupling is around hosted platform services:

- GitHub App auth and repo import.
- `coding_repos.github_repo` as the hosted identity.
- GitHub Issues mode.
- GitHub Actions build/deployment status.
- UI copy and panels that say GitHub.

Duplicating Coder per provider would copy the hard part: session lifecycle, runner binding, terminal streaming, AI loop, task cards, engine auth, and repo state. The better split is one Coder core with provider adapters.

## Goals

- Let Repo Coder work cleanly with GitHub, GitLab, Bitbucket, and local-only repositories.
- Preserve existing GitHub behavior and data.
- Keep local-path workflows first-class, including private repos that the user's machine can already access.
- Make hosted issues and build status optional per provider.
- Keep provider write actions behind per-instance connector consent.

## Non-Goals

- Do not implement self-hosted GitLab or Bitbucket Server in the first pass.
- Do not replace the coding runtime or `CODING_SESSION` workflow.
- Do not upload private repository contents to platform storage.
- Do not require users to connect a hosted provider when a local checkout is enough.

## Current State

### Provider-Neutral

- `coding_repos.clone_url` can hold any Git clone URL.
- `coding_repos.workdir` can point at any local checkout.
- `packages/browser-runner/src/coding/tmux.ts` uses generic `git clone`.
- The AI coding loop operates on terminal snapshots and user objectives, not GitHub APIs.

### GitHub-Specific

- Repo identity is stored in `coding_repos.github_repo`.
- Add-repo UI treats `owner/repo` as GitHub and builds `https://github.com/${ownerRepo}.git`.
- Local remote detection only parses `github.com`.
- Issues mode reads GitHub Issues only.
- Build status reads GitHub Actions only.
- GitHub App install/import routes live under `/v1/github`.
- Repo title helpers prefer `githubRepo`.

## Proposed Data Model

Add provider-neutral fields to `coding_repos`:

- `provider TEXT NOT NULL DEFAULT 'local'`
- `repo_slug TEXT`
- `web_url TEXT`
- `default_branch TEXT`

Provider values:

- `local`
- `github`
- `gitlab`
- `bitbucket`

Keep `github_repo` for compatibility during migration. For GitHub repos:

- `provider = 'github'`
- `repo_slug = github_repo`
- `github_repo` remains populated until all reads are migrated.

Later, after callers use `provider` and `repo_slug`, `github_repo` can become legacy-only.

## Connector Design

### GitHub

Keep the existing `github` connector and GitHub App auth.

Map existing tools into the provider abstraction:

- issues: `github_list_issues`, `github_read_issue`, `github_create_issue`
- builds: `github_workflow_runs`
- import: existing `/v1/github/installations/*`

### GitLab

Add a `gitlab` connector using OAuth or user token auth.

First tool set:

- `gitlab_list_projects`
- `gitlab_list_issues`
- `gitlab_read_issue`
- `gitlab_create_issue`
- `gitlab_pipeline_runs`

Initial auth choice:

- Prefer OAuth2 if GitLab app credentials are configured.
- Allow user API token fallback through the vault for faster self-use and private group repos.

### Bitbucket

Add a `bitbucket` connector after GitLab lands.

First tool set:

- `bitbucket_list_repositories`
- `bitbucket_list_issues`
- `bitbucket_read_issue`
- `bitbucket_create_issue`
- `bitbucket_pipeline_runs`

Initial auth choice:

- OAuth2 or app password via vault.

## API Plan

### Repo Add

Update `POST /v1/instances/:instanceId/coding/repos` to accept:

```json
{
  "provider": "gitlab",
  "repoSlug": "group/project",
  "cloneUrl": "https://gitlab.com/group/project.git",
  "branch": "main"
}
```

Rules:

- Local path stays provider `local`.
- Full clone URLs should parse known hosts:
  - `github.com`
  - `gitlab.com`
  - `bitbucket.org`
- `owner/repo` without provider remains GitHub for backward compatibility.
- New UI should send explicit provider for non-GitHub slugs.

### Remote Detection

Replace `/detect-github` with a provider-neutral endpoint:

- `POST /coding/repos/:repoId/detect-remote`

Return:

```json
{
  "provider": "gitlab",
  "repoSlug": "group/project",
  "cloneUrl": "git@gitlab.com:group/project.git",
  "webUrl": "https://gitlab.com/group/project"
}
```

Keep `/detect-github` as a compatibility wrapper.

### Issues

Replace GitHub-only issue routes with provider-neutral routes:

- `GET /coding/repos/:repoId/issues`
- `GET /coding/repos/:repoId/issues/:number`
- `GET /coding/repos/:repoId/next-issue`

Internally dispatch by `repo.provider`.

If the provider has no issue connector configured, return `available:false` or a clear 400 with setup guidance.

### Builds

Rename the concept in API responses from deployments/GitHub Actions to builds/pipelines.

Keep existing endpoints for compatibility:

- `/deployment`
- `/deployments`
- `/builds`

Internally dispatch:

- GitHub -> Actions
- GitLab -> Pipelines
- Bitbucket -> Pipelines
- Local -> unavailable

## Console Plan

### Add Repo

Replace the single text heuristic with a provider-aware add form:

- Provider segmented control: Local, GitHub, GitLab, Bitbucket
- For Local: path input
- For hosted provider: repo slug or clone URL
- Optional branch

Backwards-compatible paste behavior:

- `/path` or `~` -> local
- `github.com` -> GitHub
- `gitlab.com` -> GitLab
- `bitbucket.org` -> Bitbucket
- `owner/repo` -> GitHub unless provider selected

### Repo Identity

Replace `githubRepo` UI assumptions with:

- `provider`
- `repoSlug`
- `webUrl`
- local display name fallback

Badges:

- `local`
- `GitHub`
- `GitLab`
- `Bitbucket`

### Issues Mode

Show Issues mode only when the selected repo provider has issue support and is connected.

Copy should say:

- "Issues" for provider-neutral UI.
- Provider-specific setup messages when unavailable.

### Builds Panel

Rename user-facing labels:

- "Builds" or "Pipelines"
- Do not say GitHub Actions unless the repo provider is GitHub.

## Agent Catalog Plan

Keep `Repo Coder` as the canonical implementation.

Optionally publish provider presets:

- GitHub Repo Coder
- GitLab Repo Coder
- Bitbucket Repo Coder

These presets should differ only in:

- Name/description/welcome copy.
- Default provider setting.
- Declared connector tools.

They should all use:

```json
{
  "surfaces": ["coding"],
  "runtime": "coding",
  "workflow": "CODING_SESSION"
}
```

## Migration Plan

1. Add nullable provider-neutral columns.
2. Backfill existing rows:
   - if `github_repo` is present, set `provider = 'github'` and `repo_slug = github_repo`
   - if `workdir` is present and no `github_repo`, set `provider = 'local'`
   - otherwise infer from `clone_url` where possible
3. Update read mappers to expose both old and new fields.
4. Update routes to write new fields while preserving `github_repo`.
5. Update console to use new fields.
6. Update tests and docs.
7. Later cleanup: stop requiring `github_repo` outside compatibility paths.

## Implementation Phases

### Phase 1: Provider-Neutral Repo Identity

- Add migration for `provider`, `repo_slug`, `web_url`, `default_branch`.
- Update `CodingRepo` types in API and coder UI.
- Update `createRepo`, `toRepo`, list/get routes.
- Add parsing helpers for GitHub/GitLab/Bitbucket clone URLs.
- Add tests for parsing and migration behavior.

Acceptance:

- Existing GitHub repos still render and start sessions.
- Local repos still render and start sessions.
- GitLab/Bitbucket clone URLs can be added and cloned if credentials are available locally or embedded in the URL.

### Phase 2: UI Copy and Add Repo Flow

- Update add-repo UI to make provider explicit.
- Update repo title/badge helpers.
- Update settings modal labels.
- Replace GitHub-only copy where the feature is provider-neutral.

Acceptance:

- GitHub, GitLab, Bitbucket, and Local repos are distinguishable in the repo list.
- Adding `https://gitlab.com/group/project.git` does not create GitHub fields.
- Existing `owner/repo` input still creates GitHub repos.

### Phase 3: GitLab Connector

- Add GitLab auth route or token-vault provider.
- Add GitLab connector manifest/tools.
- Add provider dispatch for issue list/read/create.
- Add provider dispatch for pipeline runs.
- Add connector consent checks for write tools.

Acceptance:

- A GitLab-connected repo can list/read issues.
- With write consent, a GitLab-connected repo can create an issue.
- Pipelines show in the Builds panel when GitLab auth is configured.

### Phase 4: Bitbucket Connector

- Add Bitbucket auth/token provider.
- Add Bitbucket connector tools.
- Reuse the provider dispatch layer from GitLab.

Acceptance:

- A Bitbucket-connected repo can list/read/create issues where Bitbucket Issues are enabled.
- Pipelines show where Bitbucket Pipelines are enabled.

### Phase 5: Provider Preset Agents

- Decide whether presets are worth publishing after core support is stable.
- If yes, seed catalog agents with the same coding runtime but provider-specific copy and tools.

Acceptance:

- Preset agents do not fork code.
- Subscribing to a preset results in the same Coder UI with sensible provider defaults.

## Test Plan

Unit tests:

- Clone URL parsing for GitHub, GitLab, Bitbucket, SSH and HTTPS forms.
- Repo mapper compatibility for old `github_repo` rows.
- Provider dispatch for issues/builds.
- Connector write consent for GitLab/Bitbucket issue creation.

Integration tests:

- Add local path repo.
- Add GitHub `owner/repo`.
- Add GitLab clone URL.
- Add Bitbucket clone URL.
- Start a coding session for each repo type with mocked runner.
- Issues endpoint returns provider-specific unavailable errors when auth is missing.

E2E tests:

- Add repo UI provider picker.
- Repo list badges.
- Issues mode hidden/visible by provider capability.
- Builds panel labels and unavailable state.

Manual smoke:

- Local GitLab checkout with existing SSH auth.
- Public GitLab clone URL.
- Private GitLab clone URL with runner-local credentials.
- GitHub regression: issue mode and Actions still work.

## Security Notes

- Do not put provider tokens into workflow state.
- Keep clone credentials runner-side or short-lived.
- Preserve SSRF guards on cloud API calls.
- Treat repository file contents as untrusted data.
- Keep issue creation behind connector write consent.
- Avoid broad provider tokens when repo/project scoped tokens are possible.

## Open Questions

- Should GitLab auth be OAuth-first or token-first for the first release?
- Do we need GitLab self-managed support immediately, or only `gitlab.com`?
- Should Bitbucket support Workspace OAuth first, or app passwords first?
- Should build history storage become provider-neutral in the same migration, or stay GitHub-shaped until Phase 3?
- Should provider presets be published, or should the single Repo Coder be enough once the add flow is clear?
