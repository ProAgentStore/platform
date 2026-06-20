# ProAgentStore Browser Runner

Local capability runner for ProAgentStore agents.

The PAGS brain stays in the hosted control plane. This process runs on the user's machine and exposes local capabilities such as Playwright, screenshots, downloads, file upload paths, and approval-gated actions.

```bash
pnpm --filter @proagentstore/browser-runner dev -- --port 49171
```

The runner listens on `127.0.0.1` by default. Use `--token` and `--instance-id` when exposing it through Cloudflare Tunnel. PAGS includes `Authorization: Bearer <token>` and `X-PAGS-Instance-Id` on proxied task calls.

```bash
pags-browser-runner --port 49171 --token "$PAGS_RUNNER_TOKEN" --instance-id "$PAGS_INSTANCE_ID"
```

Local CLI calls to an instance-bound runner need the same instance id:

```bash
pags runner status --token "$PAGS_RUNNER_TOKEN" --instance-id "$PAGS_INSTANCE_ID"
```

Register the runner with PAGS after exposing it through a stable tunnel:

```bash
pags runner register "$PAGS_INSTANCE_ID" \
  --endpoint-url "$PAGS_RUNNER_ENDPOINT" \
  --runner-token "$PAGS_RUNNER_TOKEN" \
  --pags-token "$PAGS_TOKEN" \
  --probe
pags runner runtime "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --probe
pags runner run "$PAGS_INSTANCE_ID" --type echo --input '{"ok":true}' --pags-token "$PAGS_TOKEN"
```

## Test Job Fixture

Use the local fixture instead of real job boards while building resume upload and final-submit automation.

```bash
pnpm --filter @proagentstore/browser-runner dev:test-job-server -- --port 49210
```

The fixture serves:

```text
GET  http://127.0.0.1:49210/jobs/software-engineer
POST http://127.0.0.1:49210/apply
GET  http://127.0.0.1:49210/success/:id
GET  http://127.0.0.1:49210/submissions
```

The application form accepts standard candidate details, a resume file, and a cover note, then redirects to a success page.

Initial protocol:

```text
GET  /health
GET  /capabilities
GET  /sessions
POST /sessions
POST /tasks
GET  /tasks/:id
POST /tasks/:id/approve
POST /tasks/:id/cancel
GET  /events
```

Task types in this first version:

- `echo`: smoke-test task.
- `browser.open`: opens a URL in a persistent Playwright profile.

The runner is intentionally generic. Job-application behavior should be implemented as an adapter on top of this protocol rather than inside the core runner.
