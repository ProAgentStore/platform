# Error and audit capture matrix

Epic #1083, acceptance #1091. One row per surface where a failure can happen:
- where it is captured;
- what it records;
- where it goes when its store refuses it;
- what is deliberately not recorded;
- the MCP tool that reads it back;
- what evidence exists for it, kept apart by kind.

**This is not a claim of zero-loss logging.** Every limit below is a real way a record can be missing. Each one is either counted or stated here.

Checked against `main` at 9b4a7c1a (MCP 0.1.144), plus the #1119 fix that ships with this file.

Landed since the first draft (at 3b4dbd1f, MCP 0.1.141), and reconciled below: #1069 (trace URLs keep origin and path), #1107 (application run progress, blocker and stall notifications), #1108 (per-card action log), #1109 (generated operator guidance), #1110 (remote GitHub file reads), #1111 (MCP duplicate request ids refused), #1112 (GitHub Actions never-started reason), #1114 (runner attach causes, recorded), #1115 and #1116 (runner caller errors answered 4xx, not recorded as crashes). Only #1111, #1114 and #1116 change what is captured; the others add records or notifications, not error capture.

## Stores

| Store | Written by | Retention | When the store refuses a write |
|---|---|---|---|
| D1 `error_log` | `logError` (`workers/api/src/lib/error-log.ts`) | 30 days after a row was last seen; pruned on about 2% of writes | Spooled to KV (`tel_spool:error_log:`) and replayed by the cron drain |
| D1 `agent_events` (trace) | `logEvent` (`lib/events.ts`); `logError` copies each new row | 14 days; pruned on about 1% of writes | Spooled (`tel_spool:agent_events:`) |
| D1 `admin_audit_log` | `recordAdminAction` (`lib/admin.ts`) | No expiry | Spooled (`tel_spool:admin_audit_log:`) |
| KV MCP ledger (`audit_idx:` per owner, `audit_all:` cross-owner) | `writeAudit` (`workers/mcp/src/safety.ts`) | 90-day TTL | One index missing → spooled for the drain; both missing → `lost` (counted) |
| KV spool, dead letters, loss counters | `lib/telemetry-spool.ts` | 7 days spool; 30 days dead letters and loss counters | — |
| Runner crash file and local event store | `packages/browser-runner/src/crash-reports.ts`, `store.ts` | Until delivered; caps of 100 reports and 500 events, overflow counted | Kept on disk; the CLI re-sends |
| Browser outboxes (localStorage) | `packages/sdk/src/error-outbox.ts`, `store/auth-widget.js`; `store/widget.js` keeps its outbox in memory only | 50 events (SDK), 20 (auth-widget), in-memory (widget) | Retried with backoff; when the cap is reached, dropped events are counted (`droppedReports`) |

**Replay policy** (`telemetry_health.policy`):
- 5 attempts, with backoff of 5 s, 30 s, 5 min, 30 min and 2 h, then a dead letter;
- 1000 records per sink;
- 25 records per sink drained each minute.

Every reader states what it cannot see through its `coverage` field. `telemetry_health` (admin only) reports `pending`, `dead`, `lost` and the age of the last drain.

## Surfaces

**Legend.**
- *Local* is a test in this repo that injects the failure at a real boundary and reads it back.
- *Live* is a row read from production through MCP, read-only.
- No production failures were injected for #1091; the scope excludes synthetic injection.

### API request entrypoint

- **Capture:** `app.onError` → `logUnhandled` (`workers/api/src/index.ts`, `lib/on-error.ts`).
- **Records:**
  - user;
  - path and method;
  - level: transient → warn 503; 402/403/409/429 → warn; 5xx or unknown → error with the stack (1800 chars);
  - build.
- **Exclusions:** 401, 404 and other non-diagnostic 4xx. There is no request id on `error_log`.
- **Reader:** `list_errors`, `error_summary`.
- **Local:** `entrypoint-capture.test.ts`. `capture-acceptance.test.ts` drives it through an outage, a replay and the reader.
- **Live:** `transient` D1 "Network connection lost" rows (503 warn); `unhandled` 409 warns.

### API route that RETURNS a failure

- **Capture:** `logDirectResponse` at 4 call sites: rate limit, coding diagnostics, and instance tasks (two).
- **Records:** status; source; warn for 402/403/409/429 and expected 5xx, otherwise error.
- **Exclusions:** **any other route that returns a 5xx itself records nothing.** This is a known gap, not covered.
- **Reader:** `list_errors`.
- **Local:** `entrypoint-capture.test.ts` (the "returned" block).
- **Live:** `rate-limit` 429 warn (2026-10-16 06:39).

### Cron sweeps (`scheduled()`)

- **Capture:** each sweep's `.catch` → `logUnhandled` with `path: "scheduled:<name>"`, method `CRON`. Some sweeps log their own failures.
- **Records:** level per `logUnhandled`; stack; build (stamped since #1085).
- **Exclusions:**
  - A failed spool drain goes to the console only; this is deliberate, so it cannot feed itself.
  - #1119: the terminal-snapshot sweep swallowed its failures. It is now recorded.
- **Reader:** `list_errors`.
- **Local:** `capture-acceptance.test.ts` drives the real `scheduled()`. Also `entrypoint-capture.test.ts`, `run-sweeper.test.ts` and `trigger-sweep.test.ts`.
- **Live:** sweep-owned sources (`commit-close-watch`, `ci-health`, `issue-sync`). There is **no `scheduled:*` crash row**, so a live gate is open.

### Route `waitUntil` tasks

- **Capture:** none at the call site (`public.ts`, `tools.ts`, `instances-runner-attach.ts`).
- **Exclusions:** **known gap.**
- **Local:** none.
- **Live:** none.

### `AgentDO` (fetch, chat, WebSocket, alarm)

- **Capture:**
  - fetch catch-all → `agent-do`;
  - chat → `chat`;
  - socket → `agent-ws`;
  - `alarm()` → `alarm`, recorded and then rethrown.
- **Records:** user (pinned on the socket); instance; stack; build.
- **Exclusions:** transient errors on fetch.
- **Reader:** `list_errors`, `agent_trace`.
- **Local:**
  - `capture-acceptance.test.ts` covers the alarm;
  - `entrypoint-capture.test.ts` covers the socket.
- **Live:** `chat` 504 (05:56) and `storage` summarization errors. There is **no `alarm` or `agent-ws` row**, so a live gate is open.

### `RelayDO`

- **Capture:** none. Close and error only reject pending calls.
- **Exclusions:** **known gap.** A relay failure is seen as the caller's own error (for example `runner` "not responding").
- **Local:** `relay-do.test.ts` covers behaviour, not capture.
- **Live:** `runner` "relay connected but not responding" warns, written by the callers.

### Workflows (job apply, browser task, pipeline, coding session, agent loop)

- **Capture:** each `run()` catch, plus per-step and sink failures; `recordCodingFailure`.
- **Records:** user; instance; run id (= trace id); failure class; stack; level by class.
- **Exclusions:**
  - Transient errors are traced as `*.interrupted` and rethrown.
  - `RunnerUpdateWorkflow` writes only its operation row; it has no `error_log` row.
- **Reader:** `list_errors(run_id)`, `agent_trace(trace_id)`, `list_pipeline_runs`.
- **Local:** `workflow-trace.test.ts`, `driver-failure.test.ts`, `pipeline-run-accounting.test.ts`, `turn-recovery.test.ts`.
- **Live:** `coding:session` failures, for example run d859e667 (2026-10-16 12:30). There is **no `pipeline-run` row**, so a live gate is open.

### Host worker

- **Capture:** `reportHostFailure` → `POST /v1/errors/client` over the service binding.
- **Records:** `client:host` or `client:host-sitemap`. The report is treated as untrusted, so there is no user, instance or run.
- **Exclusions:** no event id, so there is no receipt dedupe and no retry. A failed report goes to the console only.
- **Reader:** `list_errors`.
- **Local:** `host-template-capture.test.ts`.
- **Live:** **no row**, so a live gate is open.

### Agent templates

- **Capture:** none. A failure becomes a 502 or a console log.
- **Exclusions:** **known gap**, by design. Templates are independent Workers.
- **Local:** `host-template-capture.test.ts`.
- **Live:** none.

### MCP tool calls

- **Capture:** `registration.ts` `wrapToolsCall` → one event per call (#1089).
- **Records:**
  - outcome (`completed`, `dry_run`, `denied`, `failed`, `error`, `invalid_input`, `unknown`);
  - failureClass and reason;
  - explanation;
  - gate;
  - durationMs;
  - requestId and mcpSessionId;
  - argument names plus `instance_id`.
- **Exclusions:**
  - Successful read-only calls are not recorded.
  - Metadata only: never messages, bodies or argument values.
  - A call no one can be attributed to goes to `audit_all` only.
  - #1118: a nested tool's `{success:false}` is recorded as `completed`.
  - #1111: a POST that reuses a request id still in flight in the same MCP session is refused with a JSON-RPC error before it reaches any tool (`request-isolation.ts`), so it leaves no call event. The refusal is the caller's own reply; it is not an error-log row.
- **Reader:** `mcp_audit_log`, `admin_mcp_audit`.
- **Local:** `workers/mcp/src/call-audit.test.ts` covers throw, returned error, validation, denials, dry run, lost reply, sink failure and the unattributed case.
- **Live:** probe `cb2f7834` read back as `failed`/`api_404` through both readers with `action: "failed"`, 2026-10-16 12:15, during #1090.

### MCP gate (suspension)

- **Capture:** `suspension.ts` notes passed, denied or unverified on the call event.
- **Records:** `gate`, `gateReason` (`api_unreachable`, `api_5xx`).
- **Exclusions:** fails open; the failure is recorded, not hidden.
- **Reader:** same as MCP tool calls.
- **Local:** `call-audit.test.ts`.
- **Live:** `gate: "passed"` appears on every live event. **There is no `unverified` row**, so a live gate is open.

### Browser: console and SDK

- **Capture:** SDK outbox → `POST /v1/errors/client` (#1088): global handlers, ErrorBoundary, `api()` failures, uploader.
- **Records:**
  - source `client:*`;
  - status;
  - build;
  - count (into `repeat_count`);
  - session-bound user, never upgraded later;
  - event id (receipt dedupe);
  - level set by the server.
- **Exclusions:**
  - aborts and "Script error.";
  - the outbox is capped at 50, with drops counted;
  - a browser that closes while offline delivers on its next visit, or never;
  - #1120: a build-less caller wrote `client:undefined`.
- **Reader:** `list_errors(source: client:…)`.
- **Local:**
  - `browser-error-delivery.test.ts` (real outbox → real route);
  - `error-outbox.test.ts`;
  - `e2e/browser-error-delivery.spec.ts`.
- **Live:** `client:api` rows (409 and 503), `client:voice-config`. There is **no `client:network` (offline) or `client:react` row**, so a live gate is open.

### Browser: admin

- **Capture:** the same SDK reporter, with sources prefixed `admin:`.
- **Records:** as for the console.
- **Exclusions:** as for the console.
- **Reader:** `list_errors`.
- **Local:** `e2e/admin.spec.ts`.
- **Live:** **no row**, so a live gate is open.

### Browser: public pages and the widget

- **Capture:** `auth-widget.js` (its own outbox) and `widget.js` (in memory).
- **Records:** `client:public`, `client:widget`; anonymous.
- **Exclusions:**
  - same-origin stacks only;
  - at most 5 widget reports per page, not persisted.
- **Reader:** `list_errors`.
- **Local:** `e2e/browser-error-delivery.spec.ts`. There are no unit tests.
- **Live:** **no row**, so a live gate is open.

### Runner and CLI crashes

- **Capture:** crash handlers, request 5xx, startup failure, store corruption, child exit → crash file → CLI → `POST /v1/errors/runner-crashes` (#1087).
- **Records:**
  - the signed-in user;
  - instance (ownership checked);
  - kind and route;
  - stack (2000 chars);
  - output tail;
  - build = the runner version;
  - receipt per report.
- **Exclusions:**
  - a hard kill before the crash file is written is not recoverable;
  - the store is capped, with overflow counted;
  - #1116: a CALLER's bad input or a lookup that finds nothing is answered 400/404/409 and is deliberately not a crash report — only a runner-side failure (5xx) is.
- **Reader:** `list_errors(source: runner-crash)`.
- **Local:** `runner-crash-ingest.test.ts`, `crash-delivery.test.ts`, `crash-reports.test.ts`, `store.test.ts`.
- **Live (installed runners, build 0.4.138):**
  - `ed94ef31…`: macOS install, instance a185b1db, `repeat_count` 2, stack;
  - `81f69722…`: Windows install, instance 964594b6.

### Runner attach (pin and force attach, #1114)

- **Capture:** `recordAttach` (`lib/runner-attach-report.ts`) for every attempt from `set_instance_runner_node` and `force_runner_attach`, including outcomes that settle after the 15 s window.
- **Records:** the instance's activity log (`runner.attach`: node, via, forced, outcome, cause, duration); and for a real failure (`no_socket`, `runner_timeout`, `runner_unresponsive`, `refused`, `stale_registration`, `old_runner`) an `error_log` row, source `runner.attach`, warn, with the machine's last heartbeat as context on a timeout. The three states no runner would attach — `paused`, `not_active` (canceled), `no_runtime` (a cloud-only agent) — are answered before any machine is asked and recorded as activity only, never as errors; they are the CLI's own eligibility rule (`isEligible`), held equal by `runtime-attach-eligibility.test.ts`.
- **Exclusions:** `paused` and an attached outcome are activity only, never an error row.
- **Reader:** `list_errors(source: runner.attach)`, `instance_activity`.
- **Local:** `runner-attach-1114.test.ts`.
- **Live:** **no row** read back yet, so a live gate is open (recorded under gate 9).

### Admin actions

- **Capture:** `recordAdminAction`.
- **Records:** actor, action, target and redacted detail.
- **Exclusions:** —
- **Reader:** `admin_action_audit`.
- **Local:** `history-retrieval.test.ts`, `telemetry-spool.test.ts`.
- **Live:** reader works, with 0 rows (no admin actions in the log).

## Related records that are not error capture

These landed in the same period and are read by the same owner, but they are not failure capture and add no row to the stores above:
- **#1108 per-card action log** — `action` rows in `instance_runtime_task_events`, never pruned; read by `task_action_log`.
- **#1107 application run signals** — `run_progress`, `run_stalled` and blocker notifications through the owner-attention policy (#992); they write notification rows, not `error_log` rows.
- **#1112** — a GitHub Actions run that never started reports GitHub's own annotation; it is a tool result, not a captured failure.

## Cross-cutting guarantees and their evidence

| Guarantee | Local | Live (read-only) |
|---|---|---|
| Sink outage → spool → replay once, same id and time | `telemetry-spool.test.ts`; `capture-acceptance.test.ts` (entrypoint crash → outage → drain → reader) | `telemetry_health` complete: 0 pending, 0 dead, 0 lost on all 4 sinks; last drain 39 s old (2026-10-16 ~12:39Z). **No production outage has been observed or replayed**, so a live gate is open |
| Spool unavailable too → counted loss, the caller's answer unchanged | `capture-acceptance.test.ts`, `telemetry-spool.test.ts`, MCP `call-audit.test.ts` | Not observable without an outage |
| Partial MCP index write → reconciled | `telemetry-spool.test.ts`, `audit-ledger.test.ts` | `coverage.delivery` complete |
| Dedupe and occurrence counts | `browser-error-delivery.test.ts` (event id), `runner-crash-ingest.test.ts` (receipt), `capture-acceptance.test.ts` (counts survive replay) | Live `repeat_count` 2 on runner row `ed94ef31` |
| Pagination: stable, complete, within the byte budget | `history-retrieval.test.ts` (1203 trace events; inserts and expiry during a walk), `history-tools.test.ts`, `mcp-audit.test.ts` | `agent_trace` and `list_errors` cursor walks continue without overlap (#1090 comment, 2026-10-16) |
| Tenant isolation and admin-only readers | `capture-acceptance.test.ts`, `history-retrieval.test.ts`, `mcp-audit.test.ts` | Admin reads only. **No live non-admin refusal has been captured**, so a live gate is open |

## Open live gates

These keep #1091 and #1083 open. Closing any of them needs a real production occurrence, or an owner-approved injection method.

1. Cron sweep crash (`scheduled:*`).
2. `AgentDO` alarm or WebSocket failure.
3. A pipeline-run failure.
4. A host worker failure (`client:host`).
5. A browser offline replay (`client:network`), a React crash (`client:react`), and admin and public/widget reports.
6. An MCP gate fail-open (`gate: unverified`).
7. A real sink outage replayed in production.
8. A non-admin refusal by an admin reader.
9. An installed-runner crash after this release, with its version recorded. The pre-existing 0.4.138 rows count as evidence for #1087. A live `runner.attach` failure row (#1114) has not been read back either.

## Known gaps

Recorded, not fixed here:
- direct-5xx routes outside `logDirectResponse`;
- route `waitUntil` tasks;
- `RelayDO`;
- `RunnerUpdateWorkflow`;
- templates;
- no request id on `error_log`;
- host reports have no id or retry;
- #1118 (nested `{success:false}` recorded as `completed`);
- #1120 (`client:undefined` from a build-less caller).
- #1119 is closed by the change that ships with this file: the terminal-snapshot sweep now throws, and the cron records it (`capture-acceptance.test.ts`, transient → warn, genuine → error).
