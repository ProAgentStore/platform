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
  - build;
  - request id (#1135): the `X-Request-Id` the response carried — the caller's id when it sent an id-shaped one (the MCP Worker and the host do), else `cf-ray`, else a fresh uuid. `request_id` is the request that opened the row, `last_request_id` the latest folded into it. The request's trace rows carry it as `context.requestId`. Every `logError` written inside a request gets it, not only `app.onError`'s.
- **Exclusions:** 401, 404 and other non-diagnostic 4xx. Rows written outside a request (Durable Object, Workflow, cron) have no request id.
- **Reader:** `list_errors` (`request_id` filter), `error_summary`.
- **Local:** `entrypoint-capture.test.ts`. `capture-acceptance.test.ts` drives it through an outage, a replay and the reader. `request-id-correlation.test.ts` reads the request id back through `GET /v1/errors`, through a repeat and through the spool's replay.
- **Live:** `transient` D1 "Network connection lost" rows (503 warn); `unhandled` 409 warns.

### API route that RETURNS a failure

- **Capture:** `logDirectResponse` where a route builds the failure (rate limit, coding diagnostics, instance tasks, and — at `error`, because the fault is this Worker's — the admin-audit and trace read failures). Behind it, the request middleware's backstop `logReturnedFailure` (#1134) records every other 5xx a route returns, after it has answered, when nothing in the request wrote a row already.
- **Records:** status; source (`route-5xx` for the backstop); the response's own `error` text, redacted and clipped; user; path, method and the path's instance (kept only for its owner); request id. Level: 500 → error; 501 (not configured on this deployment) and 502/503/504 (a dependency — the runner, GitHub, a provider) → warn; 402/403/409/429 → warn where a route records them.
- **Exclusions:** other 4xx; a route that recorded its own failure (one row, not two); the `/v1/errors*` endpoints themselves, so a failing log never reports itself.
- **Reader:** `list_errors`.
- **Local:** `entrypoint-capture.test.ts` (the "returned" block); `capture-gaps.test.ts` §1 drives a route's own 503 through the Worker and reads it back through `GET /v1/errors`.
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

- **Capture:** the Worker hands every route an execution context whose `waitUntil` records a rejected task through `logUnhandled` (#1134, `recordingWaitUntil` in `index.ts`) — every route's background task, present and future, with no per-site catch. The task itself runs unchanged.
- **Records:** source `unhandled` (or `transient`, at warn); path; method `<METHOD> waitUntil`; stack; request id.
- **Exclusions:** a task that catches its own failure. Checked at #1134: `recordFunnelEvent` (`public.ts`) and `parseResumeIntoProfile` (`instances-apply.ts`) already record their genuine failures themselves, and the route's silent `.catch(() => undefined)` on the résumé parse was removed so anything that still escapes reaches the wrapper.
- **Reader:** `list_errors`.
- **Local:** `capture-gaps.test.ts` §2.
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

- **Capture (#1134):** a command that times out or is cut off (the caller's 504), a socket error, and a throw inside the relay (recorded, then rethrown so the caller's answer is unchanged).
- **Records:** source `relay`; owner and instance from the object's name (`<instance>:node:<node>`), verified against `agent_instances`; node; the runner path without its query; outcome. Timeout, disconnect and socket error → warn (the owner's machine); a throw → error with its stack.
- **Exclusions:** commands ended by the owner on purpose (`pags up --force` takeover, stale-socket eviction); the "connected but not responding" 503, which its callers already record (`runner` warns) — recording it here too would be a second row for one fact.
- **Reader:** `list_errors`.
- **Local:** `capture-gaps.test.ts` §3 drives the real `RelayDO`; `relay-do.test.ts` covers behaviour.
- **Live:** `runner` "relay connected but not responding" warns, written by the callers. No `relay` row yet.

### Workflows (job apply, browser task, pipeline, coding session, agent loop)

- **Capture:** each `run()` catch, plus per-step and sink failures; `recordCodingFailure`.
- **Records:** user; instance; run id (= trace id); failure class; stack; level by class.
- **Exclusions:**
  - Transient errors are traced as `*.interrupted` and rethrown.
  - `RunnerUpdateWorkflow` (#1134): a control-plane throw inside the operation, and a failure that escapes it (recorded, then rethrown so the engine still retries), are `runner-update` errors with owner, `opId`, node and stack; a machine that answered but could not update is a `runner-update` warn. Expected outcomes (up to date, refused while busy, deferred, unsupported CLI, unreachable) stay on the operation row only. Local: `capture-gaps.test.ts` §4, `runner-update-ops.test.ts`.
- **Reader:** `list_errors(run_id)`, `agent_trace(trace_id)`, `list_pipeline_runs`.
- **Local:** `workflow-trace.test.ts`, `driver-failure.test.ts`, `pipeline-run-accounting.test.ts`, `turn-recovery.test.ts`.
- **Live:** `coding:session` failures, for example run d859e667 (2026-10-16 12:30). There is **no `pipeline-run` row**, so a live gate is open.

### Host worker

- **Capture:** `reportHostFailure` → `POST /v1/errors/client` over the service binding.
- **Records:** `client:host` or `client:host-sitemap`. The report is treated as untrusted, so there is no user, instance or run. The request id is the visitor request's `cf-ray` (#1135).
- **Delivery (#1135):** each report carries an event id minted once, so it gets the browser reports' receipt (#1088): a re-send of a report already stored is answered `duplicate` and writes no second row. A throw, 5xx or 429 is retried after 250 ms and 1 s; a 4xx is not. After the last attempt the failure goes to the console. A crash's retries run under `waitUntil`, so the visitor's 500 does not wait for them.
- **Exclusions:** retries live in the isolate only; a report that fails all three attempts is not spooled.
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
  - apiRequestId (#1135): the `X-Request-Id` every platform API request of the call carried, so `list_errors request_id=<apiRequestId>` finds the API rows the call caused;
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

**Read-only recheck, 2026-10-17 (main 22aaea5f).** `error_summary scope:all days:3` — 140 signatures over 2,768 rows, not truncated, 14–17 Oct — holds **no** occurrence for gates 1, 2, 3, 4, 6 or 8, nor gate 5's offline replay, React, admin or public reports. Every gate stays open. What it did show:
- Gate 5, online half only: live `client:network` rows from the console (`Load failed`, Safari), each with owner, deployed build (`3b9e16ccc9d4`, `19d2c37fe15f`) and `context.caller.origin: https://proagentstore.online` — #1120's attribution working in production. These are online network errors, not the offline **replay** the gate needs.
- Gate 9: the only `runner-crash` rows are CLI 0.4.138, already counted for #1087. No crash from a later release.
- Gate 8: a `cf-access` row ("blocked an admin request carrying no Access token", 403) is the Cloudflare Access layer, not the app's admin-role refusal the gate asks for.
- `telemetry_health`: complete — 0 pending, 0 dead, 0 lost on all four sinks; last drain under a minute old.

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

Recorded, not fixed here. Each was re-verified against `main` at 22aaea5f and is tracked:
- templates — by design (independent Workers), not tracked.

Resolved since this list was written:
- #1134 (returned 5xx outside `logDirectResponse`, route `waitUntil` tasks, `RelayDO`, `RunnerUpdateWorkflow`) — each now records through `logError` / `logUnhandled`; see their sections.
- #1135 (no request id on `error_log`; host reports with no id or retry) — request id stamped on every row written inside a request and shared with the trace and the MCP call event; host reports carry an event id and are retried.
- #1118 (nested `{success:false}` recorded as `completed`) — fixed in e417f636.
- #1120 (`client:undefined` from a build-less caller) — fixed in a3708994 and 22aaea5f. Eighteen of the twenty unattributed rows were the mobile-handoff e2e fixture (stopped by 5d1dd1d6, #1086); vitest (a3708994) and the chromium e2e browser (22aaea5f) can no longer reach production's API.
- #1119 is closed by the change that ships with this file: the terminal-snapshot sweep now throws, and the cron records it (`capture-acceptance.test.ts`, transient → warn, genuine → error).
