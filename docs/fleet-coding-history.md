# Fleet coding history: what was chosen, tried, started and why work stopped (#1335)

One read answers, across every instance you own: *what did the picker choose, what did it pass over and why, what was queued, what was
refused or deferred, and which of that became a real run.* It is a read model over records that already exist — it adds no ledger of its own.

- API: `GET /v1/instances/my/coding-history`
- MCP: `coding_fleet_history` (read-only)
- One objective's transition-by-transition story, from any handle an item gives you: `coding_loop_lifecycle` (#1017)

## What an item is

| `kind` | It is | Source |
|---|---|---|
| `attempt` | A **queue entry**: a try to start work. It may never become a run. | `instance_objective_queue` |
| `run` | A run that **no queue entry led to** (a direct start). | `agent_loop_runs` |
| `picker` | An auto-pickup **decision with no entry of its own**: `passed_over`, `none_eligible`, `skipped_failed`, `capped`, `skipped_gate`, `skipped_busy`, `error`. | `auto_pickup_log` |
| `request` | A start request that made **neither entry nor run**: `duplicate`, `not_started`, `outcome_unknown`. | `loop_start_receipts` |

An attempt that became a run is **one** item carrying both (`run` is filled in), and a picker selection is folded into the attempt it created
(`picker.outcome: "started"`), so nothing is counted twice.

**Attempts and runs are different numbers.** An entry the drain refused before any run existed (`outcome: "admission_failed"`, `run: null`) is an
attempt, never a run. 98 refused attempts and 2 real runs read as `attempts: 100`, `runs: 2`, `admissionFailuresWithoutRun: 98` (the #1334 shape).

## Outcomes

`outcome` is one vocabulary across kinds, and the filter takes any of it:

- a run's status: `running`, `completed`, `failed`, `needs_human`, `cancelled`;
- an attempt with no run: `queued`, `deferred` (admission was postponed at least once), `claimed`, `queue_cancelled`, `admission_failed`;
- the picker: `started`, `none_eligible`, `skipped_failed`, `capped`, `skipped_gate`, `skipped_busy`, `error`, `passed_over`;
- a request: `duplicate`, `not_started`, `outcome_unknown`.

`passed_over` is the reason the picker skipped an eligible-looking issue (recently done, already running, ...), one row per issue and reason,
written at most once an hour. Retries show as successive attempts on the same issue: filter `issue=N` and read them in order.
There is no stored `superseded` state: an objective that was replaced or withdrawn reads `queue_cancelled` (before it started) or `cancelled` (a run), with the
reason that was recorded, and a repeated request reads `duplicate`. Nothing here is labelled `superseded` unless the platform recorded it.

## Filters and paging

`instance_id`, `repo` (owner/name), `issue`, `outcome`, `kind`, `since`/`until` (inclusive; an ISO date or a millisecond epoch), `limit` (1-100,
default 25), `cursor`. A malformed value is a `400` that names it — never an unfiltered answer or a silent first page. An `instance_id` that is
not yours is a `404`.

Paging is keyset, newest first: pass `nextCursor` back as `cursor`. A row added while you page sorts above the cursor, so it never shifts or
repeats a later page, and a row removed is simply absent. `complete: true` means *no older item remains* — it is paging, **not** a claim that the
history is whole. That is `coverage`.

## The summary covers the whole range

`summary` is computed over every item the filters select, never the page: `attempts`, `runs`, `admissionFailuresWithoutRun`,
`attemptsWithoutRun`, `pickerDecisions`, `requests`, totals `byOutcome` and `byKind`, and `byInstance` (the 200 busiest, with
`instancesTruncated` set if there are more; the totals still count them all). Send `summary=false` on follow-up pages to skip it.

## Correlation and attribution

Each item carries `correlation` (`requestId`, `queueEntryId`, `runId`, `sessionId`), `machine` (the runner node that owns the run's session),
and `actor`:

- `{kind: "owner", uid, verified: true, clientClaimed}` — the uid is the verified session; `clientClaimed` is only what the caller declared;
- `{kind: "platform", via: "auto_pickup"}` — the platform's own act;
- `{kind: "unknown", legacy: true}` — a row from before attribution was recorded. It is never guessed from a request key.

`transitions.history` says whether the lifecycle ledger holds this objective's transitions: `recorded`, `predates_ledger`, or `not_recorded`
(it began after the ledger did and has none).

## What is NOT recorded (and is not invented)

`coverage` is explicit; `status` is `partial` whenever a gap applies, however many pages you read.

- **Before the ledger.** Work that began before an instance's lifecycle ledger (migration 0212) has its attempt and run records, but not its
  transitions. They are counted per instance in `gaps` and are not reconstructed.
- **No recorded issue.** `issue_number` is stamped when an entry or run is created (migration 0305). Older rows have none (an auto-picked entry
  still names it in its metadata), so an `issue` or `repo` filter cannot match them. They are **counted** in `gaps` rather than hidden, and a
  `request` (which does not index its issue) is counted the same way.
- **Skip reasons.** The picker records each passed-over candidate from the date in `coverage.passedOverRecordedSince`. Before that the reason
  exists only inside the detail text of the entry it chose or of the `none_eligible` row.
- **Deployment.** A deployment is not recorded against a run, so `deployment` is always `null` on an item and means *unobserved*, not *none*.
- **Retention.** Queue entries, runs, the picker log, requests and lifecycle events are kept indefinitely (no sweep deletes them; only unfinished
  reservation rows are removed). The MCP audit log is separate and is kept 90 days.

## Safety

Owner isolation is the `user_id` on every source row. Reasons and picker detail are redacted for secret-shaped text and clipped to 300
characters; an objective's own text is never returned. The read writes nothing and replays or requeues nothing.
