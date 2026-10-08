# Job Application Assistant (legacy, retired for new starts)

> The `JOB_APPLY` workflow is retired for new starts. `POST /apply`, the chat
> `submit_job_application` tool, and MCP `apply_to_job` return migration guidance without
> creating a task. Existing task cards, history, traces, résumé data, and ATS tips remain
> readable. Start new work through the Scout → Tailor → Runner pipeline: triage a lead, tailor
> materials, then request review or start the Application Runner fill.

A former first-party ProAgentStore catalog agent. Historically, an LLM brain drove a real
browser to complete and submit an application autonomously, answering only from your structured
Profile and the résumé you uploaded. That start path is now retired; the implementation remains
documented here solely to explain existing history and data.

**Historical architecture: remote brain, local hands.**

| Half | Where it runs | What it is |
|---|---|---|
| Brain | ProAgentStore control plane | `JobApplyWorkflow`, a durable Cloudflare Workflow (`workers/api/src/workflows/job-apply.ts`, binding `JOB_APPLY`) using the subscriber's BYOK Claude. The decision loop is pure and unit-tested in `workers/api/src/lib/apply-loop.ts`. |
| Hands | The subscriber's own machine | The ProAgentStore browser runtime started by `pags up` — real Chrome via Playwright, exposing `POST /browser/snapshot` (an ARIA tree: what the brain "sees") and `POST /browser/act` (act by ARIA **role + accessible name**, never CSS selectors). |

Being a Workflow rather than a Durable Object request is what makes it durable and resumable —
an application can outlive the 30-second request limit and survive a captcha pause of many
minutes. The loop is: snapshot → Claude picks exactly ONE action → act → repeat.

The runner reaches the cloud over the outbound WebSocket relay (`RelayDO`). There is no
cloudflared, no tunnel, and nothing inbound to expose.

## Retirement and migration

There is no legacy apply start path. The three former entry points are retained only to answer
with the same migration message; they do not create a `job.apply_agent` task, a workflow, a
budget, or browser actions. Existing `job.apply_agent` records, workflow traces, board cards,
uploaded résumé data, and per-ATS tips are not deleted.

For new work, use the existing owner-controlled pipeline:


1. Use the Job Search Scout to record and triage the lead (`triage_application` with `apply`).
2. Run `generate_application_materials` through the Application Tailor.
3. Use `request_application_review`, or `start_application_fill` when the Application Runner's
   submission policy allows it.

`POST /v1/instances/{instanceId}/apply` returns `410 Gone`; chat
`submit_job_application` and MCP `apply_to_job` return the same migration direction. Their
schemas remain available temporarily for cached clients, but none can begin legacy work.

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

## Autonomous submission boundaries

- The workflow clicks the application's final submit control automatically once it has completed
  the form with grounded Profile, résumé, and explicit-instruction values. It does not wait for a
  separate review or final-confirmation step.
- The agent never invents employment history, education, qualifications, work authorisation,
  compensation expectations, dates, or screening answers. A missing required value is a handoff,
  not a guess.
- CAPTCHA, login/security checks, and controls the browser cannot operate remain hard stops until
  the subscriber resolves that specific obstacle; they are not a review gate for ordinary
  submissions.
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
  "approvalRequiredFor": [],          // intentionally empty: the workflow submits autonomously
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
