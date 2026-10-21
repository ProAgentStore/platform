# Machine admission thresholds

The runner **admission gate** (#1264) refuses a *new* coding session on a machine that is overloaded, instead of
accepting it and going silent. Until #1275 its lines were one session formula and a few constants nobody could
change, so a small laptop was capped at one session while queued work waited. The lines now belong to the
**machine**: one policy and one gate state per physical machine, shared by every agent that runs there.

## What a machine can set

| Field | Meaning | Default |
|---|---|---|
| `maxSessions` | Reject a new session once this many are running on the machine, **of every kind** (coding sessions, local browser runs, application tailor and apply runs, on any hostname the machine has used). Replaces the formula. | the formula: one per two cores, one per 4 GiB, whichever is lower, at least 1 |
| `cpuLoad1PerCpu` / `cpuLoad5PerCpu` | Reject when load per core exceeds this | 1.5 / 1.2 |
| `memUsedPctMax` | Reject when memory in use exceeds this percent (not judged on macOS until the runner reports available memory) | 92 |
| `memAvailableMinBytes` | Reject when available memory falls under this | 1 GiB (0 never rejects) |
| `diskUsedPctMax` | Reject when the checkout volume in use exceeds this percent | 95 |
| `diskFreeMinBytes` | Reject when the checkout volume has less than this free | 10 GiB (0 never rejects) |
| `recoveryBand` | The gate reopens only when **every** metric is under this fraction of its reject line | 0.9 |
| `recoveryStreak` | Consecutive clear samples (one per ~30s heartbeat) required to reopen | 2 |

A breach rejects at once; recovery needs the band **and** the streak, so a machine hovering at a line does not flap.

## Precedence

Defaults table in code → the deploy's `RUNNER_GATE_DEFAULTS` (a JSON object of the same keys, for a fleet-wide
change without a code edit) → the machine's own override. Setting a field to `null` returns it to the level below.

## Changing and reading them

- **Console:** the machine page has an **Admission thresholds** card — each field shows the value in force and whether
  this machine sets it, saving sends only what you changed, and **Reset to defaults** removes every override.
- **CLI:** `pags runner thresholds` shows this machine's thresholds; `pags runner thresholds maxSessions=2
  diskFreeMinGiB=20 memUsedPctMax=null` changes some (a number sets, `null` returns one to its default);
  `pags runner thresholds --reset` removes every override. It acts on the machine you run it on — pass
  `--machine <id>` to act on another one.
- **MCP:** `get_machine_thresholds`, `set_machine_thresholds` (partial; `dry_run` first), `reset_machine_thresholds`.
- **API:** `GET` / `PUT` / `DELETE /v1/terminals/machines/{machineId}/thresholds`.
- **Seeing them:** `list_runner_nodes` shows each machine's `thresholds` (what is in force, where each value came
  from, the gate's verdict) and `coding_loop_status` shows `runnerGate` for the machine the coder runs on.

A change takes effect at the machine's next heartbeat. It never touches a session that is already running — the
gate only decides whether a *new* one starts, and a deferred run retries on its own.

## Setting one machine

To let a two-core laptop that the formula caps at one session run two:

```
set_machine_thresholds  machine_id=<id from list_runner_nodes>  maxSessions=2
```

`get_machine_thresholds` then reads `maxSessions: { value: 2, source: "machine", formula: 1 }`.

## What the runner reports

The gate judges the heartbeat sample each runner sends. Two readings were wrong or missing before:

- **macOS memory.** `os.freemem()` on a Mac counts only never-used pages, so a healthy Mac read 95%+ used and the gate
  could not judge memory there. A runner from CLI 0.4.168 sends `memAvailableBytes` (free + inactive + purgeable +
  speculative pages from `vm_stat`), and the gate then judges available memory on macOS too. Until a Mac's runner is
  updated, its memory is still not judged.
- **Disk on every platform.** The checkout volume is read with `statfs`, which reports real byte counts on Windows too (it
  has no inode counts, which are sent as 0 and shown as 0%), so a Windows machine's disk lines apply like any other.
