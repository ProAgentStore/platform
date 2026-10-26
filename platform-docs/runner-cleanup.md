---
description: "Configure gentle or harsh runner cleanup for owned processes, Playwright browsers, temporary files, worktrees, and caches."
---

# Runner post-run cleanup

After a coding run the runner used to end only the engine's **own** process. Builds, test runners, dev
servers, watchers and Playwright browsers the engine started survived, untracked; per-run temp folders and
worktrees were never removed. On a machine that runs agents all day that is a load of 283 on 12 cores and a
disk that climbs and never comes back (#1265).

Each machine now has a **cleanup mode** — `gentle` or `harsh` — and six switches the mode sets the defaults
of. Set them on the machine page in the console, or with `set_machine_policy`
(`cleanup_mode`, `cleanup_overrides`, `cleanup_now`); read them with `get_machine_policy` and
`list_runner_nodes` (`cleanup_mode`, `cleanup`).

## The two modes

| | **gentle** (default) | **harsh** |
|---|---|---|
| For | A machine somebody also **uses** | A **dedicated** runner |
| Stop / timeout / abort | Ends the engine and every process it can **prove** descends from it (by parent link, or by the engine's own process group) | The same, and signals the **whole process group**, then SIGKILLs survivors after 5 s |
| Leftover sweep | **Reports** leftovers (count and list on the heartbeat). Ends one only if it carries the session's `PAGS_SESSION_ID` marker for a session that has ended | Ends marker-carrying leftovers, processes left in an ended session's group, and **orphaned** (parent 1) `node`, `vite`, `next`, `jest`, `vitest`, `esbuild`, `wrangler`, `playwright` processes running out of runner workdirs |
| Browsers | Playwright's **own** throwaway browsers and profiles only, after every run | The same, after every run **and every 15 minutes** |
| Temp and worktrees | Deletes the run's own temp folder and the worktrees it created | The same, plus runner temp folders and Playwright profiles older than 24 h |
| Load warning | Warns when load is far above what the sessions account for | Warns **and runs a sweep** |
| Cache pruning above 90% disk | **Off** (a warning is shown instead) | **On**: `pnpm store prune`, `npm cache clean`, Xcode DerivedData, and git-**ignored** build outputs under runner checkouts |

**In both modes the runner never** touches a process or file outside what it owns, kills a live session,
touches a person's own browser, or deletes uncommitted work (a worktree with changes is left in place; a build
directory is removed only if git ignores it, and never in a checkout a live session is using).

## The six switches

The master toggle sets these defaults; each can be overridden per machine (changing the mode resets them).

| Switch | `cleanup_overrides` key | gentle | harsh |
|---|---|---|---|
| 1. Kill the engine's process tree on end/timeout/abort | `processGroupKill` | on | on |
| 2. Leftover-process sweep | `leftoverSweep` | on | on |
| 3. Playwright browser cleanup | `browserCleanup` | on | on |
| 4. Per-run temp folder and worktree deletion | `tempCleanup` | on | on |
| 5. Load-mismatch warning (harsh: and sweep) | `loadWarning` | on | on |
| + Cache pruning above 90% disk | `cachePruning` | **off** | on |

A switch that is off turns that behaviour off in either mode.

## How it works

* The engine is started in **its own process group** with `PAGS_SESSION_ID=<session>` and a per-run
  `TMPDIR=<runner config>/tmp/<session>`. Its group therefore contains only its own descendants, which is what
  makes signalling it safe, and the marker is how a leftover is proven to be a session's.
* The **platform** resolves mode + overrides into the six switches and sends them to the runner on every
  heartbeat answer (`cleanupPolicy`), so there is one resolver and the runner only obeys. With no policy (an
  older platform, a first start) the runner is gentle.
* The runner reports back on the heartbeat (`cleanup`): the active mode, leftovers it found and **did not
  touch**, load and disk warnings, and its last pass. The platform stores a bounded, sanitized copy. A report is
  telemetry: it can never change the mode.
* **Clean now** (`cleanup_now`) asks the machine for one pass on its next heartbeat — whether or not it is idle.
  The platform keeps asking until the machine reports having finished *that* request. The pass runs in the
  background so it never delays the heartbeat, and the report includes the **bytes freed**.
* Ending the runner ends its engines (they no longer receive a terminal's Ctrl-C, being in their own group).

## Which machines

Defaults to **gentle** everywhere. The intended assignment is gentle on a machine its owner also works on, and
harsh on dedicated runners — set per machine, by its stable machine id, so it survives renames and reconnects.

## Over the API

```
PUT /v1/terminals/machines/{machineId}/policy
{ "cleanup_mode": "harsh", "cleanup_overrides": { "cachePruning": false }, "cleanup_now": true }
```

The response's `machine.cleanup` carries `mode`, the resolved `behaviours`, `overrides`, the runner's `report`
and `report_at`, and `now_requested_at` / `now_done_at`.
