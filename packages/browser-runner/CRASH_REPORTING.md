# Runner crash reporting and crash-safe local state (#1087)

What the local runtime and the `pags` CLI keep when something fails, how it reaches the
platform, and — stated plainly — what it cannot keep.

## What is recorded

| Kind | Written by | When |
|---|---|---|
| `uncaught_exception`, `unhandled_rejection` | runtime | A stray error anywhere in the runtime. The runtime keeps serving (dropping the relay over one bug would be worse). |
| `startup_failure` | runtime | The runtime could not start — e.g. its port is taken (`route: "listen"`, then it exits 1), or the startup reaper failed (`route: "reap"`, it still starts). |
| `request_failure` | runtime | A request failed on the runtime's side (5xx): method + path, instance id, task / session id from the path. A caller's bad input (4xx) is answered, not recorded. |
| `store_corrupt` | runtime | A store or crash file could not be parsed and was quarantined (below). |
| `runner_exit` | CLI (`runner connect`) | The runtime died on its own — with its exit **code or signal** and its last 20 stderr lines. |
| `connect_exit` | CLI (`pags up`) | The supervised `runner connect` died — with code or signal and its last 20 lines. A Ctrl-C stop is not a crash and is not recorded. |

Every report carries its build (the CLI release) and the **account** it belongs to (a hashed key
of the signed-in login). Messages are clipped to 1000 characters, stacks to 4000, each output line
to 300 — every cut is marked — and credential-shaped text (bearer tokens, API keys, JWTs,
`token=…`) is masked before anything is written. No request or response bodies, no environment
(ADR 0004).

## Where it is kept, and how it reaches the platform

- The runtime writes `<data dir>/crash-reports.json` (default
  `~/.config/proagentstore/browser-runner/`). Only the runtime writes it.
- The CLI writes `~/.config/proagentstore/runner-crashes-<account key>.json`, and remembers what
  the platform acknowledged in `crash-delivered-<account key>.json`.
- `runner connect` delivers every unacknowledged report for **its own account** to
  `POST /v1/errors/runner-crashes` once its relay is connected, every five minutes while it runs,
  and — within five seconds — when the runtime dies. Anything it could not deliver (offline, the
  platform refusing) stays on disk and is sent on the next start.
- Delivery is at least once and **idempotent**: the platform keeps one receipt per (account,
  report id) and writes a report to the error log only the first time. The reports are then read
  with MCP `list_errors(source: "runner-crash")` (or `error_summary`), filed under the signed-in
  account; an instance a report names is kept only if that account owns it.
- A report with no account (a bare `pags runner start`, with no signed-in session) is never sent.
  A machine shared by two accounts never sends one account's reports under the other.

## Crash-safe files

The runtime's `runner-store.json` (sessions, tasks, events) and every crash file are written
**atomically**: to a temp file in the same directory, fsync'd, then renamed over the target. A
reader sees the old file or the new one, never a half-written one; a temp file an interrupted write
left behind is deleted the next time the file is opened.

A file that does not parse is **quarantined**, not reset: it is moved to
`<file>.corrupt-<timestamp>` (copied, if it cannot be moved), a `store_corrupt` report names the
copy, and only then does the runtime continue on a fresh file. At most five quarantined copies
are kept per file.

## Limits — what this does not do

- **Hard kill and power loss.** A write in progress when the process is killed or the machine
  loses power is lost — the file keeps its previous contents. The directory entry is not fsync'd,
  so a power loss just after a rename can, on some filesystems, roll the file back one write.
- **SIGKILL / out-of-memory kills** run no handler in the dying process. The runtime cannot
  record its own death; its parent (`runner connect`) records `runner_exit` with the signal. If the
  parent is killed the same way at the same moment, nothing is recorded.
- **A crash before `record` returns** (the process dying inside the handler) is not recorded.
- **Bounded, not complete.** At most 100 reports per file; older ones are dropped first and the
  number dropped is counted in the file's `dropped` field.
- **The event buffer** in `runner-store.json` keeps the newest 500 events; older ones are dropped
  and counted in `droppedEvents`.
- **The coding transcript** (`coding/headless.ts`) is in memory only, by design: past 4000 entries
  it keeps the newest 3000 and says how many it dropped (`droppedRecords`, shown in the pane). It is
  not a crash record and is not persisted.
- **`pags up`'s output buffer** is the last 200 lines, in memory only; it feeds the status line and
  the exit message and dies with the process.
- Delivery needs a signed-in account and a reachable platform. Reports older than what fits in the
  file, or kept past an account's sign-out, may never be delivered.
- Background daemon supervision (#499) is out of scope: nothing here keeps a runner running.
