# #1113 follow-ups — ready to file

Slice 1 (the routing rules, `workers/api/src/lib/runner-routing.ts`) shipped. Each item below is the
remaining scope of #1113, written to be filed as its own issue. Design: [`../runner-self-hosted-design.md`](../runner-self-hosted-design.md).

1. **GitHub App: grant self-hosted-runner, Actions-variable and billing-read permissions (owner approval)** —
   org "Self-hosted runners: write", repo "Variables: write" and Actions billing read, on every org the
   App is installed on. Blocks 2–6. Refs #1113.
2. **Mint runner registration tokens server-side; deliver over the relay, never store** —
   `POST /orgs/{org}/actions/runners/registration-token` through the installation token, pushed to the
   machine's `pags up`, with a test that no token reaches D1/KV/logs/traces. Refs #1113.
3. **pags daemon: install/remove the actions/runner service (macOS/Linux `config.sh` + `svc.sh`, Windows `config.cmd --runasservice`) (owner approval)** —
   labels `pags` and `pags-<node>`, one runner per machine per org, separate OS user where possible,
   prerequisite check (node/pnpm, AWS CLI) reported. Refs #1113.
4. **Per-machine runner groups with pin-scoped, private-only repo access** —
   group `pags-<node>`, `visibility: selected`, access list = repos pinned to that machine;
   `assertPrivateRepo` on add plus a periodic re-check. Refs #1113.
5. **Pin lifecycle + reconciliation loop** — pin adds, re-pin is ordered (remove old → set `PAGS_RUNNER` → add new) and cancels
   or re-dispatches runs queued on the old label; unpin/forget deregisters; an idempotent cron fixes drift
   and alerts on any repo reachable by more than one machine's runner; `runner_node_forget_preflight`
   lists the runners it would remove. Refs #1113.
6. **Minutes-aware routing: read org Actions usage, write `PAGS_RUNNER` from `selectRunnerLabel`, flip back on reset** —
   uses billing usage where readable and #1112's `minutes_exhausted` run evidence otherwise; every flip
   traced and notified; offline machine → GitHub-hosted if minutes remain, else queue and alert. Refs #1113.
7. **Runner health, routing mode and a stuck-queued-job watcher in machine status** —
   `list_runner_nodes` / `instance_runner_node` show runner online/busy/version/labels/last job; per-org
   routing mode and minutes; the watcher alerts or re-routes a job queued past N minutes. Refs #1113.
8. **(PAS) Workflow templates use `vars.PAGS_RUNNER`, `timeout-minutes` and `concurrency`; confirm OIDC deploy accepts self-hosted jobs** —
   template-app / template-marketplace; `authorizeDeployOidc` checks repository + ref, not
   `runner_environment`. Refs #1113.
9. **(PAS) interns deploy end-to-end through the self-hosted route with OIDC** —
   lands in `s3://pas-apps/apps/interns/`; the acceptance run for the whole feature. Refs #1113.
