# Self-hosted GitHub Actions runners on pinned Coder machines — design (#1113)

**Status:** slice 1 shipped. The routing rules live in `workers/api/src/lib/runner-routing.ts`, with
tests in `workers/api/src/lib/runner-routing.test.ts`. **Nothing is enabled live:** no runner is
registered, no `PAGS_RUNNER` variable is written, and the GitHub App has no new permissions. Everything
below that is marked *pending* needs either the owner's approval (new GitHub App permissions; software
installed on owner machines) or work in another repository (PAS). Follow-ups to file:
[`docs/issues/1113-followup.md`](issues/1113-followup.md).

## Goal

GitHub-hosted runners by default. A repo's jobs fall back to the self-hosted runner on the machine its
Coder is pinned to — and only that machine — when the org's Actions minutes are exhausted or low, and
switch back when they reset. Workflows route on one variable:

```yaml
runs-on: ${{ fromJSON(vars.PAGS_RUNNER || '"ubuntu-latest"') }}
```

## What slice 1 fixes in place (shipped)

`selectRunnerLabel({visibility, pinnedNode, minutes, failureReason, lowMinutesPercent})` decides the
route, and `getWorkflowRunnerDirective(repo, pinnedNode, …)` wraps it for one repo. Both are pure.

| Rule (#1113) | Where |
|---|---|
| GitHub-hosted (`ubuntu-latest`) by default | `selectRunnerLabel`, reason `default` |
| Self-hosted only when minutes are exhausted (`minutes.exhausted`), low (`usedPercent` ≥ 90 by default, configurable), or a run failed to start for billing | reasons `minutes_exhausted`, `minutes_low`, `run_not_started_for_billing` |
| The billing signal is #1112's classification, `minutes_exhausted`, and nothing weaker (`not_started` and unreadable annotations never trigger it) | `shouldFallbackToSelfHosted`, tested against the real `classifyStartFailure` / `runStartFailure` output |
| Pin-scoped: a self-hosted route is exactly `["self-hosted", "pags-<node>"]`, for the PINNED node only, never generic labels | `nodeRunnerLabel`, `isPinScoped` |
| Unpinned → GitHub-hosted | reason `not_pinned` |
| Public (or internal) repos never route self-hosted | reason `not_private`; `assertPrivateRepo` throws `PublicRepoError` for the runner-group writer |
| Labels are a deterministic slug of the canonical node name (`normalizeRunnerNode`); two names that slug the same are reported, not shared | `labelCollisions` |
| The route has no memory: minutes that read as fine again route back to GitHub-hosted | tested round-trip |

Acceptance criteria this slice satisfies **as decision logic only**: "`PAGS_RUNNER` never contains only
generic labels", "when unpinned, jobs run on GitHub-hosted only", "by default all jobs run on
GitHub-hosted", and "public repos are rejected" (the guard exists; nothing calls it live yet).

## Pending — the live loop

### 1. GitHub App permissions (owner approval)
Org **Self-hosted runners: write** (register/remove runners, manage runner groups and their repo access),
**Variables: write** on repos (`PAGS_RUNNER`), and **Administration/billing read** for Actions usage.
Granting these changes what the App can do in every org it is installed on (ProAgentStore, pas-apps…).
Until granted, every step below would fail at GitHub. The installation-token path is
`workers/api/src/lib/github-app.ts`.

### 2. Registration tokens — minted, pushed, never stored
`POST /orgs/{org}/actions/runners/registration-token` via the installation token, server-side, at the
moment the daemon needs it (1-hour expiry). Delivered over the existing runner relay to the machine's
`pags up` and never written to D1, KV, logs or traces. One runner **per machine per org**. Labels are
`pags` and `nodeRunnerLabel(node)`, from the canonical node name, never a hostname alias.

### 3. The installer in the pags daemon (owner approval: software on owner machines)
- **macOS/Linux:** download actions/runner, `config.sh --unattended --url <org> --token <t> --labels pags,pags-<node> --runnergroup pags-<node>`,
  then `svc.sh install && svc.sh start`. Ideally as a separate macOS user with no access to `~/dev`,
  keychains or the owner's logins.
- **Windows (Dell):** `config.cmd --runasservice`. Workflows must be OS-portable (`shell: bash`), or use per-OS labels.
- **Prerequisites** (node/pnpm, AWS CLI for `aws s3 sync`) checked and reported, not silently assumed.
- **Concurrency:** one job at a time per runner (the default for actions/runner); deploy workflows add `concurrency` groups.

### 4. Runner groups — pin-scoped access
One runner group per machine (`pags-<node>`), with `visibility: selected` and an access list of
**exactly the repos pinned to that machine**. Before adding a repo, `assertPrivateRepo` runs on GitHub's
current visibility, and a periodic re-check removes any repo that has since become public.

### 5. Lifecycle, tied to pinning (`workers/api/src/lib/runner-node-pin.ts`)
- **Pin** (`set_instance_runner_node`): ensure the runner exists on the target machine (install if
  missing), then add the Coder's repos to its group.
- **Re-pin — ordered:** (1) remove the repo from the old machine's group, (2) set `PAGS_RUNNER` to the new
  route, either `selectRunnerLabel` for the new node or GitHub-hosted, (3) only then add the repo to the
  new machine's group. Then cancel queued runs targeting the old label and re-dispatch them.
- **Unpin / forget:** remove the repos from the group. When a runner has no repos left, deregister it and
  uninstall the service. `runner_node_forget_preflight` lists the runners a forget would remove.
- **Reconciliation loop** (cron, idempotent): desired state (pins × repos × routing) against actual
  (runners, groups, access lists, variables). It fixes drift. Any repo reachable by more than one
  machine's runner is a **violation**: fixed at once and alerted.

### 6. Minutes and routing
- **Usage:** org Actions billing (minutes used vs. included, spending limit) on the reconciliation cadence → `MinutesState`.
- **Run evidence:** a run that #1112 classified `minutes_exhausted` (`runStartFailure` in
  `workers/api/src/lib/github-actions.ts`) feeds `failureReason`. This works even where the App cannot read billing.
- **Flip:** write `PAGS_RUNNER` with `directive.variableValue`. Every flip is logged (trace and owner
  notification) with its `reason`. It flips back when the next billing cycle starts or minutes are restored.
- **Offline machine while routed self-hosted:** if minutes remain, route GitHub-hosted. Otherwise queue
  and **alert the owner** — never queue silently. The RL laptop is skipped while offline and reconciled
  when it reconnects.

### 7. Observability
- Runner health (online, busy, version, labels, last job) on `list_runner_nodes` and `instance_runner_node`.
- Routing mode and minutes usage per org.
- A stuck-queued-job watcher: workflows set `timeout-minutes`, and the watcher alerts or re-routes a job queued longer than N minutes.

### 8. Other repositories (PAS)
- **OIDC deploy:** PAS's `authorizeDeployOidc` checks issuer, audience, signature, repository and
  `refs/heads/main`, not `runner_environment`. So a self-hosted job's OIDC token is accepted as it is.
  Workflows keep `permissions: id-token: write`. To verify there, not here.
- **Templates:** template-app / template-marketplace workflows adopt
  `runs-on: ${{ fromJSON(vars.PAGS_RUNNER || '"ubuntu-latest"') }}`, `timeout-minutes` and `concurrency`.
- **End-to-end:** the interns deploy succeeds through the self-hosted route with OIDC, landing in `s3://pas-apps/apps/interns/`.

## Acceptance criteria (#1113) — status

| Criterion | Status |
|---|---|
| Pin-scoped mutual exclusion holds | decision logic shipped (`isPinScoped`, pinned-node-only labels); enforcement needs groups (§4) + reconciliation (§5) |
| By default all jobs run on GitHub-hosted | logic shipped; needs templates using `PAGS_RUNNER` (§8) |
| Auto-switch to self-hosted on low/exhausted minutes, and back | decision shipped; the variable writer and minutes reader are pending (§1, §6) |
| Offline self-hosted → GitHub-hosted when minutes remain, else alert | pending (§6) |
| Pin registers the runner and adds repos; unpin/forget cleans up | pending (§2–§5) |
| Public repos rejected | guard shipped (`assertPrivateRepo`); not yet called live (§4) |
| Registration tokens never persisted | design (§2); pending |
| Health + routing visible; stuck-job watcher alerts | pending (§7) |
| interns deploy end-to-end via self-hosted with OIDC | pending, PAS (§8) |
| Workflow templates updated | pending, PAS (§8) |
