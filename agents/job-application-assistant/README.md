# Job Application Assistant

A first-party ProAgentStore catalog agent. Give it a job URL and an LLM brain drives a real
browser to fill — and, when you allow it, submit — the application, answering from your
structured Profile and the résumé you uploaded.

**Architecture: remote brain, local hands.**

| Half | Where it runs | What it is |
|---|---|---|
| Brain | ProAgentStore control plane | `JobApplyWorkflow`, a durable Cloudflare Workflow (`workers/api/src/workflows/job-apply.ts`, binding `JOB_APPLY`) using the subscriber's BYOK Claude. The decision loop is pure and unit-tested in `workers/api/src/lib/apply-loop.ts`. |
| Hands | The subscriber's own machine | The ProAgentStore browser runtime started by `pags up` — real Chrome via Playwright, exposing `POST /browser/snapshot` (an ARIA tree: what the brain "sees") and `POST /browser/act` (act by ARIA **role + accessible name**, never CSS selectors). |

Being a Workflow rather than a Durable Object request is what makes it durable and resumable —
an application can outlive the 30-second request limit and survive a captcha pause of many
minutes. The loop is: snapshot → Claude picks exactly ONE action → act → repeat.

The runner reaches the cloud over the outbound WebSocket relay (`RelayDO`). There is no
cloudflared, no tunnel, and nothing inbound to expose.

## Start an application

There is exactly one apply path. Every entry point below funnels into `startJobApply()` in
`workers/api/src/routes/instances-apply.ts`, which creates the `job.apply_agent` runner task
and starts `JobApplyWorkflow`.

### Console / HTTP

```http
POST /v1/instances/{instanceId}/apply
Authorization: Bearer <session token>

{ "url": "https://boards.example.com/jobs/1234", "dryRun": true }
```

Returns `202 { workflowId, taskId, status: "running", url }`.

| Field | Meaning |
|---|---|
| `url` | Required. The job posting / application URL (`http`/`https`). |
| `dryRun` | `true` = fill everything, but a **runtime guard inside the workflow blocks the final submit click**. The brain cannot override it. Omit or `false` to really submit. |
| `resumePath` | Optional and normally omitted. If a résumé has been uploaded to the platform the route hands the runner a short-lived signed download URL instead; a local path is only a legacy same-machine fallback. |
| `candidate`, `coverNote` | Optional overrides. Anything absent comes from the saved Profile. |

Requires a **live runner** — `requireLiveRuntime` throws if no machine is connected. It also
calls `requirePro`, which is currently a no-op in production because PAGS billing is deferred
(`PAYWALL_ENFORCE` is unset, so `isPaywallEnforced` is false); it becomes a `402` gate if PAGS
billing is ever enabled.

Concurrency is single-flighted per instance: the runner drives one browser page, so a second
concurrent apply on the same instance is rejected with `409` via an atomic placeholder-claim
insert, not a check-then-act race.

### MCP

```text
subscribe_agent
upload_resume        # url= or content_base64=, or neither to re-parse the résumé on file
apply_to_job         # submit=false (default) = fill-only test run
apply_to_job         # submit=true = real submission — requires `destructive` scope
instance_board       # watch progress and handoffs
instance_task_events
get_apply_tips       # what the agent has learned per ATS host
get_profile
```

`apply_to_job` maps `submit` to the route's `dryRun` inversely: `submit=false` sends
`dryRun:true`. A fill-only run needs `runtime` scope; a real submission needs `destructive`
scope. Both tools honour `dry_run`, which describes the call without performing it.

### Chat tool

The chat agent exposes `submit_job_application`. The **name** is legacy — it predates the
workflow — but it is not a separate implementation: it calls the same `startJobApply()`. Note
that it does **not** pass `dryRun`, so a chat-initiated apply is a real submission.

## Human handoffs

The brain pauses rather than guessing. Three reasons, one pause/resume machine
(`/browser/handoff`, `/browser/handoff-status`, `/browser/resume`):

| Reason | Trigger | How it resolves |
|---|---|---|
| `challenge` | A captcha or similar challenge. | Solve it in the live console takeover; the run auto-resumes when the token appears. |
| `stuck` | A widget the agent could not operate after repeated attempts on a page. | You perform that one step in the takeover, then click Resume. |
| `needs_input` | A required value the agent does not have and must not invent. | The console shows an input box; the value is saved to the Profile and the run continues. |

Each handoff waits up to about 15 minutes per round and notifies the user. A timeout is an
expected outcome, not a crash — the partial run's learnings are still saved.

Handoff routes: `GET /v1/instances/{id}/takeover`, `GET .../takeover/{taskId}/frame`,
`POST .../takeover/{taskId}/input`, `POST .../takeover/{taskId}/resume`,
`POST .../takeover/{taskId}/end`, and `POST /v1/instances/{id}/input` for the ask-and-hold
value. Screenshots of each step are at `GET /v1/instances/{id}/tasks/{taskId}/shots/{seq}`.

## Where the answers come from — three separate data planes

| Plane | Storage | Contains |
|---|---|---|
| **Profile** | `user_profile` D1 table, `lib/profile.ts`, `GET/PUT /v1/profile` | Structured reusable PII: name, phone, city/country, links, work authorization, salary, plus Job Preferences (target roles/locations/work type/relocation). This is what forms are filled from. |
| **Credentials vault** | `agent_credentials` D1 table, `/v1/instances/{id}/credentials` | Site logins. Secrets are envelope-encrypted under `KEY_ENCRYPTION_KEY`. Matched to a job host by suffix, so `dayforcehcm.com` covers `jobs.dayforcehcm.com`. |
| **Knowledge base** | Per-instance Durable Object | Unstructured documents — résumé prose, company notes. Not a form-filling source. |

The résumé itself is uploaded once (`PUT /v1/instances/{id}/apply-resume`) and stored in R2;
the runner downloads it through a short-lived signed URL when a job needs a file upload, so a
runner on a different machine still has it. `POST .../apply-resume/parse` re-parses the stored
résumé with BYOK Claude to pre-fill the Profile.

Two prompt rules are hard-locked and worth knowing:

- Use the Profile value or call `request_user_info` — **never invent one**.
- Demographic / EEO questions are always answered "Decline to self-identify".

**Special Instructions** (`GET/PUT /v1/instances/{id}/instructions`, console Knowledge →
Rules & Tips) are free-text rules injected at the top of the prompt, overriding defaults.

**Per-ATS tips cache** (`ats_apply_cache`): every run saves its step transcript — what worked
*and* what failed — plus the outcome, keyed by ATS host, and feeds it back into the next run's
prompt. Read it with `GET /v1/instances/{id}/apply-tips`.

## Safety model

- `dryRun` is enforced in the **workflow**, not in the prompt. `dryRunBlockReason()` refuses
  the submit action regardless of what the brain decides, and the guard carries across handoff
  rounds.
- Real submission through MCP requires `destructive` scope; a fill-only run requires only
  `runtime` scope.
- Single-flight per instance prevents duplicate submissions from a double-click or from the
  console racing the chat tool.
- Every run is written to the unified trace (`GET /v1/instances/{id}/trace`, or the MCP
  `agent_trace` tool) with the play-by-play, not only failures.

Not yet production-hardened: Profile and credential encryption uses a server-held key (no KMS,
no zero-knowledge, no separate audit log), there is no per-instance consent gate over private
Profile fields, and there is no application rate limit or cross-run historical dedup — only
concurrent runs on one instance are prevented.

## Manifest

`agent.json` declares the current runtime contract:

```jsonc
"runtime": {
  "kind": "pags-browser-runtime",
  "taskTypes": ["job.apply_agent"],   // the task the workflow creates
  "approvalRequiredFor": [],          // intentionally empty: the gate is dryRun + MCP scope,
                                      // not a per-task approval step
  "brainPlacement": "pags-control-plane",
  "runtimePlane": "pags"
}
```

`job.apply_agent` is the only apply task type. The earlier `job.apply_basic` selector-driven
task no longer exists.

## Legacy: the standalone `/applications` Worker

`src/index.ts` in this directory is a **separate, legacy** Worker that drafts an application
packet (cover letter, short pitch, detected form fields) from a job URL and can POST a simple
HTML form after an exact `submit <application-id>` confirmation. Its endpoints are `GET /`,
`GET|PUT /profile`, `POST /applications`, `POST /run`, `GET /applications`,
`GET /applications/:id`, `POST /applications/:id/submit`.

It is **not** the product path and it is not deployed by any workflow in `.github/workflows/`.
Nothing in the console, CLI, or MCP server calls it. It predates `JobApplyWorkflow` and is kept
only as a reference for the packet-drafting prompt. Do not point users at it.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
```

The parts that actually matter for the apply flow live outside this directory:

| Concern | File |
|---|---|
| Route + `startJobApply()` | `workers/api/src/routes/instances-apply.ts` |
| Durable brain | `workers/api/src/workflows/job-apply.ts` |
| Pure decision loop | `workers/api/src/lib/apply-loop.ts` |
| Chat tool entry point | `workers/api/src/lib/storage-tools.ts` |
| MCP tools | `workers/mcp/src/instance-tools/apply.ts` |
| Local browser hands | `packages/browser-runner/src/` |
