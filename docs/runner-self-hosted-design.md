# Self-hosted GitHub Actions runners on pinned Coder machines — design (#1113)

**Status:** slice 1 shipped. The routing rules live in `workers/api/src/lib/runner-routing.ts`, with
tests in `workers/api/src/lib/runner-routing.test.ts`. **Nothing is enabled live:** no runner is
registered, no `PAGS_RUNNER` variable is written, and the GitHub App has no new permissions yet (the exact set to grant is in §1). Everything
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

### 1. GitHub App permissions (owner approval — approved 2026-10-19, #1207)
The App is **`proagentstore`** (id 4460892, owned by the ProAgentStore org,
https://github.com/apps/proagentstore). Its permissions are set in its GitHub settings, not in this
repo: no manifest or file here declares them, and a manifest only applies when an App is created.

Read from `GET /apps/proagentstore` on 2026-10-19, before the change:
`actions: read`, `contents: read`, `issues: write`, `members: read`, `metadata: read`.

The three to add, named as GitHub's "Permissions required for GitHub Apps" reference names them
(checked 2026-10-19), with the endpoints each one opens:

| Settings page label | API key | Level | Opens |
|---|---|---|---|
| Organization → **Self-hosted runners** | `organization_self_hosted_runners` | **write** | `POST /orgs/{org}/actions/runners/registration-token` (#1208), runner removal, `/orgs/{org}/actions/runner-groups/*` and their repo access (#1210) |
| Repository → **Variables** | `actions_variables` | **write** | `POST`/`PATCH /repos/{owner}/{repo}/actions/variables` — `PAGS_RUNNER` (#1212) |
| Organization → **Administration** | `organization_administration` | **read** | `GET /organizations/{org}/settings/billing/usage` — Actions minutes (#1212) |

`Administration: read` is the only App permission GitHub lists for the billing usage report. It also
reads other org settings; nothing here uses it for anything but usage.

Granting is two steps, both the owner's:
1. Change the App: https://github.com/organizations/ProAgentStore/settings/apps/proagentstore/permissions
   — set the three above and save.
2. Accept on every installation: GitHub asks each org the App is installed on to review the new
   permissions (Settings → GitHub Apps → proagentstore → *Review request*). Until an org accepts, its
   installation tokens keep the old permissions and every call below fails there with 403. The
   orgs that matter first are ProAgentStore and **proappstore-online** (the interns repo,
   `proappstore-online/interns`, #1215).

Until both are done, every step below would fail at GitHub. The installation-token path is
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
| Pin-scoped mutual exclusion holds | decision logic shipped (`isPinScoped`, pinned-node-only labels); the ordered reconciliation PLAN shipped (slice 2, `runner-reconcile.ts`: one group per repo, removals → variable → additions, stale queued runs cancelled, multi-machine and public-repo violations fixed and reported — the issue's acceptance tests pass against a simulated GitHub, checked after every step of a re-pin); executing it needs the App permissions (#1207) and groups (#1210, #1211) |
| By default all jobs run on GitHub-hosted | logic shipped; needs templates using `PAGS_RUNNER` (§8) |
| Auto-switch to self-hosted on low/exhausted minutes, and back | decision shipped; the variable writer and minutes reader are pending (§1, §6) |
| Offline self-hosted → GitHub-hosted when minutes remain, else alert | decision shipped (slice 2, `desiredRoute`); live minutes + delivery pending (#1212, #1213) |
| Pin registers the runner and adds repos; unpin/forget cleans up | pending (§2–§5) |
| Public repos rejected | guard shipped (`assertPrivateRepo`); not yet called live (§4) |
| Registration tokens never persisted | design (§2); pending |
| Health + routing visible; stuck-job watcher alerts | partly shipped (#1213). `actions_runner_status` now shows, for each runner on the machine, GitHub's view of it (`ci`: online, busy, labels, pin-scoped, routable) or why that could not be read (`ciNote`). The rules for per-repo routing mode (`routingModeView`) and the stuck-queued-job watcher (`stuckQueuedJobs`: re-route when the machine is offline and minutes remain, alert otherwise) are in `runner-ci-status.ts`, pure and tested. Not wired yet: they need org minutes (#1212) and a queued-run listing on the reconciliation cadence (#1211), and the `list_runner_nodes` / `instance_runner_node` surfaces do not show them |
| interns deploy end-to-end via self-hosted with OIDC | pending, PAS (§8) |
| Workflow templates updated | this repo's deploy and publish workflows shipped (#1214): every Linux deploy and publish job reads `fromJSON(vars.PAGS_RUNNER || '"ubuntu-24.04"')` (the fallback stays pinned, #1266), has `timeout-minutes`, and every workflow has a `concurrency` group; the macOS (TestFlight), Windows and Linux release-smoke jobs are not routed (the smoke tests need a clean GitHub-hosted image, #1152). Not checked: whether npm / the MCP registry accept an OIDC token from a self-hosted job, and this repo is public, which the design bars from self-hosted runners. The PAS `app-deploy.yml` and `template-app` / `template-marketplace` are other repos and still pending (§8) |
