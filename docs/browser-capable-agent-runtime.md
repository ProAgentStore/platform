# FAGS Browser Runtime For PAGS Agents

ProAgentStore needs a runtime model for agents that can drive a real browser. That browser runtime is FAGS/FreeAgentStore, not PAGS. PAGS remains the marketplace, account, MCP, and orchestration control plane. FAGS owns the browser execution substrate.

Job application agents are the reference case: they need saved logins, interactive pages, captchas/manual checkpoints, files, and sometimes a long-lived browser session. That cannot be done correctly inside a plain Cloudflare Worker.

This document defines the architecture and tracks the first implementation slice.

Current implementation:

- `packages/browser-runner` provides the FAGS browser runtime with task state, events, bearer-token protection, and a persistent Playwright profile.
- `pags runner` controls the bundled FAGS runtime from the existing PAGS CLI.
- `workers/api` stores instance-scoped runtime registrations and proxies task/status/event calls to the registered runner.
- `workers/mcp` exposes runtime tools for registering a runner, probing status, running tasks, approving tasks, cancelling tasks, and reading events.
- The first brain placement target is `brainPlacement = "pags"`: PAGS owns the brain and FAGS acts as the browser capability/tool executor.
- Runtime identity is `runtimePlane = "fags"` and `runtime = "fags-browser-runtime"`.
- The shipped local connection mode is endpoint registration through Cloudflare Tunnel.
- The cheapest best-practice target is an outbound CLI worker that polls PAGS for approved tasks and posts events/results back, avoiding a public tunnel by default.
- Browser-resident FAGS-style brains remain a supported later placement, but are not the first PAGS implementation target.

## Plane Ownership Diagram

```text
┌─────────────────────────────┐
│ PAGS control plane           │
│ - marketplace/subscriptions  │
│ - MCP/API                    │
│ - task policy/approval/audit │
│ - user-owned AI credentials  │
└──────────────┬──────────────┘
               │ task envelope / runtime registration
               ▼
┌─────────────────────────────┐
│ FAGS browser runtime         │
│ - Playwright                 │
│ - browser profile/cookies    │
│ - local files/resume upload  │
│ - screenshots/events/results │
└──────────────┬──────────────┘
               │ browser actions
               ▼
┌─────────────────────────────┐
│ Real browser / job boards    │
└─────────────────────────────┘
```

## Decision Record: Where the Agent Brain Lives

Status: PAGS control plane + FAGS browser runtime shipped for tunnel mode. Outbound polling should be the next FAGS runtime protocol.

Decision owner: not finalized. This recommendation follows the PAS Agent Teams precedent: PAS runs the agent loop in our infrastructure, while user-owned keys can be used for billing. It still needs product/engineering approval for PAGS browser agents.

Recommendation for the first PAGS implementation: the agent brain and orchestration live in PAGS-hosted infrastructure. The browser runtime lives in FAGS and acts as the capability executor. FAGS can run either on the user's local machine or later on managed infrastructure. For the cheapest best-practice local mode, FAGS should connect outbound to PAGS and poll for work. Tunnels remain a shipped bootstrap/debug mode and named tunnels remain useful for advanced users.

That means:

- Local polling mode: PAGS queues task envelopes, the user-owned FAGS runtime polls outbound, executes tasks locally, and posts events/results back.
- Local tunnel mode: PAGS calls a registered user-owned FAGS runtime endpoint through Cloudflare Tunnel.
- Managed mode: PAGS assigns a managed FAGS runtime as the browser/tool executor.
- PAGS hosted services own orchestration, auth, billing, runtime assignment, task state, and audit trails.
- A plain Cloudflare Worker can coordinate and route, but it is not the process that runs Playwright.

PAGS remains the control plane and service owner. It stores the agent template, instance metadata, runtime assignment, task summaries, and audit events. It starts, stops, inspects, and bills tasks.

The assigned FAGS browser runtime owns the active browser loop:

```text
observe browser -> reason/plan -> act in browser -> evaluate result -> request user input/approval when needed
```

In managed mode, LLM calls originate from our runner/service path, following the PAS Agent Teams pattern. Billing can be platform-metered or BYO-key, but the loop is ours.

In local mode, LLM calls should go through PAGS first. A later browser-resident or local/BYO brain can be added as an explicit placement, but it is not the first PAGS implementation target.

For a text-only server agent, the brain can still run in a Cloudflare Worker. For any agent declaring `runtime.kind = "fags-browser-runtime"`, the first implementation routes task orchestration through PAGS and delegates browser actions to the registered FAGS runtime.

Why this recommendation exists:

- PAS already proves the pattern: run our own agent loop in our infrastructure, keep deterministic system stages separate, and meter/BYO keys as needed.
- Local polling mode is the cheapest default path: no public endpoint, no tunnel dependency, and no always-open WebSocket or Durable Object requirement.
- Managed mode remains the paid product path for reliability: always-on, supportable, auditable, and easier to secure.
- Browser state belongs with the browser process. The FAGS runtime can see DOM, screenshots, downloads, file picker state, and logged-in session directly.
- Local execution is useful for users who prefer not to pay for VM time or want maximum local control, and it exercises the same protocol before managed VM provisioning exists.

Alternatives considered:

- Brain in PAGS Worker/service, remote browser in FAGS. This is the first implementation direction; PAGS owns orchestration and FAGS executes browser capabilities.
- Brain in managed FAGS runtime. This can support a paid, reliable browser runtime later.
- Brain in local FAGS runtime. This is acceptable as a browser-resident/local/BYO brain option later, but not the first PAGS implementation target.

This is not a final business decision. It is the current technical recommendation because it lets PAGS ship a generic protocol now, keeps the agent brain connected to PAGS, and preserves managed VM and browser-resident placements for later.

## Goals

- Agents can declare that they need browser driving capability.
- A user can run FAGS/Playwright on their own machine through an outbound CLI connection to PAGS.
- A user can use Cloudflare Tunnel as a shipped bootstrap/debug mode or stable named endpoint.
- A user can later hire a managed FAGS browser runtime through ProAgentStore.
- Hosted PAGS remains the control plane for discovery, subscriptions, config, auth, logs, and MCP.
- Browser execution happens in a runtime environment that can actually run Playwright or equivalent browser automation.
- Sensitive user material such as resumes, cookies, profile data, and job-board sessions stays in the assigned browser runtime.

## Non-Goals

- Do not run Playwright inside Cloudflare Workers.
- Do not silently submit applications without an explicit user-controlled approval step.
- Do not require every PAGS agent to use this model. Most server-only agents can keep using Worker/Durable Object runtimes.
- Do not make local-machine runtime the default paid product path.

## Architecture

PAGS/FAGS should separate a browser-capable agent into three planes:

1. Control plane
2. Runtime plane
3. Browser execution plane

### Control Plane

Hosted by ProAgentStore.

Responsibilities:

- Agent registry and marketplace metadata.
- User subscription and instance records.
- MCP tools.
- Runtime capability negotiation.
- Runtime endpoint registration.
- Audit/event logs.
- Secrets references and policy, but not raw browser cookies or local files.
- Optional proxying to a registered runtime endpoint.

Current components that fit here:

- `workers/api`
- `workers/mcp`
- store/console UI
- agent metadata such as `agent.json`

### Runtime Plane

Runs agent-specific backend logic.

There are three runtime modes:

- `hosted-worker`: Cloudflare Worker, for agents that do not need browser automation.
- `fags-browser-runtime`: user-owned FAGS Node service with Playwright. Target default is outbound polling; current shipped mode uses Cloudflare Tunnel endpoint registration.
- `managed-fags-browser-runtime`: managed FAGS VM/container with Playwright.

For browser-capable agents, the runtime plane is FAGS: a managed or local Node process. Current tunnel mode exposes an HTTP API that PAGS and MCP call through a signed/tokenized task protocol. Target local polling mode should keep the HTTP API internal to the CLI and use PAGS cloud task queues as the public interface.

Required runtime endpoints:

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

Agent-specific endpoints can exist under:

```text
/agent/*
```

PAGS proxied runtime calls include:

```text
Authorization: Bearer <registered-runner-token>
X-PAGS-Instance-Id: <subscribed-instance-id>
X-PAGS-Runtime-Placement: local|managed
```

The FAGS runtime can be started with `--instance-id` to reject calls for the wrong PAGS instance.

For a job application agent:

```text
POST /agent/applications
GET  /agent/applications/:id
POST /agent/applications/:id/approve-submit
```

### Browser Execution Plane

Runs a browser controlled by the runtime.

Supported execution targets:

- Local FAGS runtime with Playwright and persistent browser profile.
- Managed FAGS runtime with Playwright and persistent encrypted storage.

The browser execution plane owns:

- Browser profile directory.
- Job-board login sessions.
- Resume files and downloaded artifacts.
- Screenshots/traces.
- Interactive handoff state.

## Runtime Modes

### FAGS Runtime Through Outbound Polling

Target cheapest best-practice mode.

The user runs one CLI process:

```bash
pags runner connect "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --headless
```

In target polling mode, that process should:

1. Start the local FAGS Playwright runtime on localhost.
2. Authenticate to PAGS with a scoped runner/session token.
3. Register heartbeat, capabilities, runner version, and instance binding.
4. Poll PAGS for pending approved task envelopes.
5. Execute work locally.
6. Post task events, status, receipts, and non-sensitive results back to PAGS.

The route is:

```text
PAGS task queue <-poll/post- FAGS runtime -> Playwright browser on user machine
```

```text
┌──────────────┐       poll task        ┌──────────────┐       automate       ┌──────────────┐
│ PAGS API/MCP │ <-------------------- │ FAGS runtime │ ------------------> │ Job website  │
│ task queue   │ ---- events/results -> │ local CLI    │ <--- page state ---- │ in browser   │
└──────────────┘                        └──────────────┘                      └──────────────┘
```

Pros:

- Cheapest default runtime path.
- User machine only makes outbound HTTPS requests.
- No public tunnel URL for the local machine.
- No always-on WebSocket/Durable Object requirement.
- Good enough latency for job applications and other human-paced browser work.

Cons:

- Requires new cloud-side task queue/state endpoints.
- User machine must be online while work runs.
- Not ideal for scheduled unattended work unless the CLI is left running.

### Managed FAGS Browser Runtime

Paid reliability path after the local protocol proves out.

ProAgentStore provisions or rents an isolated FAGS runtime for the user. The runtime hosts:

- Agent brain.
- Playwright.
- Persistent browser profile.
- Task state.
- Event stream.
- Screenshots/traces/receipts.

The route is:

```text
PAGS/MCP -> managed FAGS runtime -> Playwright browser on VM
```

The VM should provide:

- Persistent encrypted disk.
- Playwright browser dependencies.
- Per-user runtime isolation.
- Runtime heartbeat.
- Remote browser viewer or noVNC-style handoff for login/captcha/manual approval.
- Snapshot/stop/delete lifecycle.

Pros:

- Always-on option.
- PAGS can provide a managed experience.
- Better reliability for scheduled or long-running jobs.
- Easier to support and bill.
- Aligns with PAS Agent Teams: our system runs the loop.

Cons:

- Higher cost.
- More security responsibility.
- Stronger isolation, billing, retention, and deletion policies are required.

### FAGS Runtime Through Cloudflare Tunnel

Current shipped local mode and fallback/debug path.

The user runs the FAGS runtime service:

```bash
pnpm start
```

The service listens on localhost, for example:

```text
http://127.0.0.1:49171
```

The CLI currently exposes FAGS through Cloudflare Tunnel and registers it with PAGS:

```bash
pags runner connect "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --headless
```

For production usage, users should use a named tunnel and stable hostname:

```text
https://serge-job-runner.example.com
```

The PAGS console stores the FAGS runtime endpoint and verification fingerprint. The local machine stores browser state and files.

```text
┌──────────────┐       HTTPS proxy       ┌────────────────────┐       localhost       ┌──────────────┐
│ PAGS API/MCP │ ---------------------> │ Cloudflare Tunnel  │ -------------------> │ FAGS runtime │
│ task tools   │ <---- events/status --- │ public endpoint    │ <---- JSON API ------ │ local machine│
└──────────────┘                         └────────────────────┘                       └──────┬───────┘
                                                                                              │
                                                                                              ▼
                                                                                       Playwright browser
```

Pros:

- User keeps sensitive browser sessions and files locally.
- Best fit for personal automation and debugging.
- Already implemented and published in `@proagentstore/cli`.
- Lowest setup friction for the current API proxy model.

Cons:

- User machine must be online.
- User must install Node, Playwright browser dependencies, and Cloudflare Tunnel.
- Public tunnel dependency is less desirable than outbound polling for default production use.
- Reliability depends on the local machine.
- Harder for PAGS to support.

## Capability Manifest

Agents should declare runtime requirements in `agent.json`.

Proposed fields:

```json
{
  "runtime": {
    "kind": "fags-browser-runtime",
    "defaultPlacement": "local-polling",
    "browser": {
      "engine": "playwright",
      "persistentProfile": true,
      "headful": true,
      "manualHandoff": true,
      "fileUploads": true,
      "downloads": true
    },
    "deployment": {
      "localPolling": true,
      "localTunnel": true,
      "managedVm": true,
      "hostedWorker": false
    }
  }
}
```

This lets the marketplace and MCP know that the agent cannot run as a normal Worker-only agent and needs the FAGS browser runtime.

## Runtime Registration

A subscribed instance should have a runtime registration record:

```json
{
  "instanceId": "inst_123",
  "runtimeKind": "fags-browser-runtime",
  "endpoint": "https://runner.example.com",
  "status": "online",
  "lastHeartbeatAt": "2026-06-15T00:00:00.000Z",
  "capabilities": {
    "playwright": true,
    "persistentProfile": true,
    "manualHandoff": true,
    "fileUploads": true
  }
}
```

MCP tools should support:

```text
register_instance_runtime
instance_runtime_status
unregister_instance_runtime
run_instance_task
approve_instance_task
cancel_instance_task
instance_task_events
```

The existing `chat_with_instance` path can remain for text-only interaction, but FAGS browser tasks should use task-oriented tools so state, approval, and events are explicit.

User runner commands:

```bash
npm install -g @proagentstore/cli
pags runner connect "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --headless
```

Manual FAGS runtime commands for stable named tunnels:

```bash
pags runner start --port 49171 --token "$PAGS_RUNNER_TOKEN" --instance-id "$PAGS_INSTANCE_ID"
pags runner status --token "$PAGS_RUNNER_TOKEN" --instance-id "$PAGS_INSTANCE_ID"
pags runner task --type echo --input '{"ok":true}' --token "$PAGS_RUNNER_TOKEN" --instance-id "$PAGS_INSTANCE_ID"
```

PAGS registration and task commands for FAGS:

```bash
pags runner register "$PAGS_INSTANCE_ID" \
  --endpoint-url "$PAGS_RUNNER_ENDPOINT" \
  --runner-token "$PAGS_RUNNER_TOKEN" \
  --pags-token "$PAGS_TOKEN" \
  --probe
pags runner runtime "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --probe
pags runner run "$PAGS_INSTANCE_ID" --type echo --input '{"ok":true}' --pags-token "$PAGS_TOKEN"
pags runner approve-task "$PAGS_INSTANCE_ID" "$PAGS_TASK_ID" --pags-token "$PAGS_TOKEN"
pags runner cancel-task "$PAGS_INSTANCE_ID" "$PAGS_TASK_ID" --pags-token "$PAGS_TOKEN"
pags runner task-events "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN"
```

Local job application fixture:

```bash
pnpm --filter @proagentstore/browser-runner dev:test-job-server -- --port 49210
```

Use `http://127.0.0.1:49210/jobs/software-engineer` as the first safe resume-upload target. It accepts standard candidate fields, a resume file, and a cover note, then redirects to a success page and exposes submitted metadata at `/submissions`.

PAGS/MCP registration flow:

```text
subscribe_agent
register_instance_runtime
instance_runtime_status(probe: true)
run_instance_task
approve_instance_task
cancel_instance_task
instance_task_events
```

PAGS API endpoints implemented for subscribed instances:

```text
POST   /v1/instances/:instanceId/runtime
GET    /v1/instances/:instanceId/runtime
POST   /v1/instances/:instanceId/runtime/heartbeat
GET    /v1/instances/:instanceId/runtime/status
DELETE /v1/instances/:instanceId/runtime
POST   /v1/instances/:instanceId/tasks
GET    /v1/instances/:instanceId/tasks/:taskId
POST   /v1/instances/:instanceId/tasks/:taskId/approve
POST   /v1/instances/:instanceId/tasks/:taskId/cancel
GET    /v1/instances/:instanceId/task-events
```

Direct smoke test:

```bash
curl http://127.0.0.1:49171/health \
  -H "Authorization: Bearer $PAGS_RUNNER_TOKEN" \
  -H "X-PAGS-Instance-Id: $PAGS_INSTANCE_ID"
curl -X POST http://127.0.0.1:49171/tasks \
  -H "Authorization: Bearer $PAGS_RUNNER_TOKEN" \
  -H "X-PAGS-Instance-Id: $PAGS_INSTANCE_ID" \
  -H "Content-Type: application/json" \
  -d '{"type":"echo","input":{"ok":true}}'
```

## Authentication

Runtime endpoints must not be open just because they sit behind a tunnel.

Minimum requirements:

- FAGS runtime has a generated shared secret or public key pair.
- PAGS sends signed task requests.
- FAGS verifies request signature and instance ID.
- FAGS rejects unsigned direct public traffic.
- FAGS heartbeat proves the endpoint is still controlled by the user.

Current MVP:

- Registration stores the runner bearer token encrypted when `KEY_ENCRYPTION_KEY` is configured.
- PAGS sends the bearer token plus `X-PAGS-Instance-Id` to the FAGS runtime.
- The local FAGS runtime can bind to one instance id with `--instance-id`.
- PAGS normalizes runner task payloads and forces approval for `browser.open` and `job.apply_basic` before proxying.

Suggested model:

- During registration, runtime generates a key pair.
- Runtime sends public key to PAGS through authenticated MCP/API.
- PAGS signs each task request or sends a short-lived task token.
- Runtime validates token audience, instance ID, expiration, and task ID.

## Browser Task Lifecycle

Browser tasks should be state machines, not one-shot chat messages.

Common states:

```text
queued
running
needs_user_input
needs_approval
blocked
completed
failed
cancelled
```

A job application task should usually end at `needs_approval` before final submission.

Example:

1. User gives job URL.
2. Runtime opens job URL in Playwright.
3. Runtime extracts job details and application form.
4. Runtime prepares answers and fills fields.
5. If login/captcha/manual step is needed, task becomes `needs_user_input`.
6. Before final submit, task becomes `needs_approval`.
7. User approves through MCP/console.
8. Runtime submits and stores receipt/screenshot.

## Human Handoff

Browser agents must support handoff.

Examples:

- Job board login.
- MFA.
- Captcha.
- Confirming sensitive application answers.
- Selecting a resume file.
- Reviewing final form before submit.

The runtime should expose:

- Current URL.
- Screenshot.
- Task event stream.
- Optional remote browser viewer URL.
- Required user action text.

The agent should not attempt to bypass captcha or login controls.

## Job Application Agent Shape

The job application agent should be FAGS-browser-runtime-first.

Local runtime responsibilities:

- Launch persistent Playwright context.
- Visit job URL.
- Detect platform type when possible: Greenhouse, Lever, Workday, Ashby, SmartRecruiters, generic HTML.
- Fill known fields from local profile.
- Upload local resume when approved.
- Generate truthful answers from profile and job description.
- Pause for missing answers.
- Pause before final submission.
- Store application status, screenshot, URL, and receipt locally.

PAGS control-plane responsibilities:

- Subscribe user to the agent.
- Register runtime endpoint.
- Start tasks.
- Show task status and events.
- Store non-sensitive task summaries.
- Route MCP calls to runtime.

## Data Storage

Local runtime should store:

- Browser profile.
- Resume files.
- Detailed form contents.
- Screenshots/traces.
- Job-board cookies.

PAGS should store:

- Instance ID.
- Runtime endpoint.
- Runtime health status.
- Task summary.
- Timestamps.
- Non-sensitive result metadata.

For managed VMs, PAGS must define retention and deletion rules before launch.

## Implementation Plan

### Phase 1: Protocol and Docs

- Add this architecture doc.
- Define browser-runner capability fields for `agent.json`.
- Define runtime registration schema.
- Define browser task event schema.
- Decide whether runtime calls are direct from MCP worker to tunnel or proxied through API worker.

### Phase 2: FAGS Runtime Skeleton

- Done: create a generic FAGS runtime package at `packages/browser-runner`.
- Done: Node HTTP server with:
  - `/health`
  - `/capabilities`
  - `/tasks`
  - `/tasks/:id`
  - `/tasks/:id/approve`
  - `/events`
- Done: local JSON storage.
- Done: bearer-token request protection.
- Done: Playwright persistent browser context.
- Cloudflare Tunnel setup docs.

### Phase 3: PAGS Runtime Registration

- Done: add DB tables for instance runtime registrations.
- Done: add API endpoints:
  - register runtime
  - heartbeat
  - runtime status
  - unregister runtime
- Done: add MCP tools:
  - `register_instance_runtime`
  - `instance_runtime_status`
  - `run_instance_task`
  - `approve_instance_task`
  - `cancel_instance_task`
  - `instance_task_events`
- Done: add console runtime board for instance task status/events.
- Done: add `pags runner connect` to start the runner, open a quick tunnel, register it, and probe health.
- Add outbound polling task queue endpoints for the cheaper default local mode.

### Phase 4: Job Application Agent on Browser Runner

- Done: add `job.apply_basic` to the FAGS runtime for basic resume-upload HTML forms.
- Done: make `job.apply_basic` approval-gated before submission.
- Done: cover the fixture job application page with a Playwright e2e.
- In progress: convert the job application agent from Worker-first to FAGS-browser-runtime-first in the marketplace UX.
- Add platform adapters:
  - generic HTML form
  - Greenhouse
  - Lever
  - Ashby
  - Workday as best-effort with handoff
- Add final-submit approval gate.
- Add local profile/resume management beyond per-task inputs.
- Add screenshots and receipts.

### Phase 5: Managed VM Runtime

- Define VM provider abstraction.
- Provision per-user VM.
- Install FAGS runtime and Playwright dependencies.
- Add remote browser handoff.
- Add lifecycle:
  - create
  - start
  - stop
  - snapshot
  - delete
- Add billing and usage tracking.

### Phase 6: Hardening

- Threat model local tunnel and VM runtimes.
- Add request signing and token rotation.
- Add audit trails.
- Add rate limits.
- Add runtime version compatibility checks.
- Add tests for offline runtime, stale tunnel, bad signature, cancelled task, user-input handoff, and approval gate.

## Open Decisions

- Polling task queue schema and retention.
- Whether `pags runner connect` should default to polling and expose tunnel mode as `pags runner tunnel`.
- Direct tunnel calls from MCP/API versus API proxying for fallback mode.
- Named tunnel ownership: user-owned Cloudflare account versus PAGS-managed tunnel.
- Runtime auth: shared secret first or public/private key first.
- Local storage: JSON for MVP versus SQLite from day one.
- Browser viewer implementation for local and VM handoff.
- Whether managed VM is rented per user, per task, or pooled with strong isolation.
- How much task detail PAGS stores versus only FAGS runtime storage.

## Recommended MVP

Build the PAGS-control-plane/FAGS-runtime protocol first, make outbound polling the default local connection mode, then add managed FAGS runtimes behind the same task model.

Why:

- It matches PAS: our system runs the loop.
- It lets the runner stay generic: any agent brain connected to PAGS can use the same local capability executor.
- It gives us the cheapest secure end-to-end path before VM provisioning and billing are complete.
- The same runner binary can later run on managed VMs for users who want the paid always-on path.

MVP scope:

- PAGS registration and MCP task tools for FAGS runtimes.
- Local FAGS Node runtime.
- Playwright persistent profile.
- Outbound polling between FAGS and PAGS for local runtime tasks.
- Job application task with generic HTML, Greenhouse, and Lever support.
- Manual handoff and final-submit approval.
- Managed VM mode after the protocol proves out locally.

Do not make browser-resident local brains the default. Local outbound polling is the no-VM executor path; Cloudflare Tunnel is a current fallback/debug path; PAGS still owns the first implementation's brain and orchestration.
