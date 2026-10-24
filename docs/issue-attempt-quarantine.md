# Per-issue hard stop after repeated unsuccessful attempts (#1336)

After **N distinct unsuccessful attempts on one issue** (default 5), that issue alone is stopped. Everything else keeps
being picked.

## The counter

Keyed by **owner + lower-cased `owner/repo` + issue number**, so every instance of that account working the repo shares one
count, and another account's is separate (`issue_attempts`, migration 0286). One row per attempt; `UNIQUE(user_id, attempt_key)`
makes a replayed event, a retried step or a second wake a no-op.

| Counts as one attempt | Key |
|---|---|
| A queue entry the drain refused for a structural reason, so no run ever existed (no checkout, no coding CLI, no repo…) | `entry:<queue entry id>` |
| A run that ended `failed`, `escalated`, `max_iterations`, `no_progress`, `engine_error`, `constraint_refused`, `turn_lost` or `budget` | `run:<run id>` |

| Never counts |
|---|
| A deferral or wait (`busy`, `paused`, `runner_offline`, `runner_overloaded`, `recovery_required`), polling, a duplicate receipt |
| A cancellation |
| A start-guard refusal: `duplicate`, `issue_closed`, `already_done`, `quarantined` — the guard doing its job |
| Provider credit, credentials, a usage window, a machine that stayed away, an unanswered owner question, a platform interruption — those have their own holds (#1314) and are not the issue's fault |

The existing auto-pickup bound (two failed auto-picked runs pass an issue over, #1233) is unchanged and stricter for runs the
picker started; this counter is the account-wide, configurable, all-paths one.

## Threshold

`autoPickup.maxAttemptsPerIssue`, an integer from 1 to 50, default 5, validated at the write (400 otherwise) through
`PUT /v1/instances/{id}/auto-pickup`. The threshold of the instance that records the attempt that reaches it is stored on the
incident. Reading is account-wide, so a stop made from one instance holds for all.

## The stop

At the threshold one conditional statement opens the quarantine row (`issue_quarantine`) with an incident id, the count and
the threshold; of any number of concurrent writers exactly one sees `changes = 1` and logs `issue_quarantine.opened`. Further
attempts are still recorded and raise the count, and do not open a second incident.

`checkStartIdempotency` — the one start guard every path passes — refuses the issue with reason `quarantined`, **before** the
`force` branch, so `force` cannot override it. That covers the cron sweep, a run-end wake, the queue drain, a manual start and
delegation. The auto-resume path continues a run through the same driver, which checks the stop for a continue too (a repair
checkout is the only exception). The picker treats `quarantined` like any other refusal: it passes the issue over, records
"passed over #N (quarantined)" and starts the next eligible issue; nothing is queued for the stopped one, so a wake loop cannot
flood the queue or the counter.

## How it ends

It never expires into a retry loop. Only:

1. **A verified success** — a run on the issue that ended `done` — restarts the count and lifts the stop. (`done` is the platform's
   existing notion of success, the same one the seven-day guard uses; no further verification is claimed.)
2. **The owner's release** — `POST /v1/instances/{id}/issue-quarantines/release { repo, issue, reason }`. A reason is required, it is
   audited (`issue_quarantine.released`, who and why are also kept on the row), the count restarts, and a second release is a 404.

The count restarts by moving a floor past every earlier attempt; no attempt row is deleted. `GET .../issue-quarantines` lists the
open stops (`?released=1` adds lifted ones).

## Not in this change

The owner push, the full-detail view and the choice / free-text reply flow are #1337 and reuse the existing channels; this change
only provides the incident and the release call they will use. Fleet history across instances is #1335.
