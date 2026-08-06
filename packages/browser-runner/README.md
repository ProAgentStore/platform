# ProAgentStore Browser Runtime

Internal ProAgentStore browser runtime for ProAgentStore agents.

The PAGS brain stays in the hosted control plane. The browser runtime runs on the user's machine and exposes local capabilities such as Playwright, screenshots, downloads, file upload paths, and approval-gated actions.

```text
PAGS control plane -> ProAgentStore browser runtime -> local Playwright browser
```

This package is private in the monorepo. Users install `@proagentstore/cli`; the CLI bundles this runtime and starts it with `pags runner start`.

```bash
pnpm --filter @proagentstore/browser-runner dev -- --port 49171
```

The runtime listens on `127.0.0.1` by default. The CLI normally starts it through `pags up` / `pags runner connect`, registers it with PAGS, and exposes it only through the outbound WebSocket relay. PAGS includes `Authorization: Bearer <token>` and `X-PAGS-Instance-Id` on proxied task calls.

```bash
pags runner connect "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --headless
```

`runner connect` starts the browser runtime, registers each supplied instance, opens an outbound relay socket for each one, and keeps the runtime process alive. There is no Cloudflare Tunnel / cloudflared mode in the current CLI.

```bash
pags runner start --port 49171 --token "$PAGS_RUNNER_TOKEN" --instance-id "$PAGS_INSTANCE_ID"
```

Local CLI calls to an instance-bound runtime need the same instance id:

```bash
pags runner status --token "$PAGS_RUNNER_TOKEN" --instance-id "$PAGS_INSTANCE_ID"
```

Register the browser runtime manually when you are running it yourself:

```bash
pags runner register "$PAGS_INSTANCE_ID" \
  --endpoint-url "http://127.0.0.1:49171" \
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

Task types exposed by the current runner include:

- `echo`: smoke-test task.
- `browser.open`: opens a URL in a persistent Playwright profile.
- `job.apply_agent`: workflow-driven job-application task.
- `coding.session`: coding runtime session.

The runner is intentionally generic. Job-application behavior should be implemented as an adapter on top of this protocol rather than inside the core runner.
