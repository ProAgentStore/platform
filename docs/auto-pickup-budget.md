# Auto-pickup: what the daily allowance counts (#1334)

Three different things used to be one number.

| Thing | What it is | Counted against |
|---|---|---|
| **Attempt** | A queue entry auto-pickup committed (`auto_pickup_log` row `started`, written by the #1315 trigger in the same statement as the entry). | `maxPerDay × 3` per rolling 24h — a ceiling that pauses an endless loop and says so (`capped`). |
| **Run** | An attempt that was not refused before a run existed. A log row whose queue entry ended `failed` with no `run_id` is *not* a run. | `maxPerDay` per rolling 24h. |
| **Started** (reported) | The queue drain returned `started: true` with a `runId`. Enqueue succeeding is not a start. | — |

Both limits are enforced twice: by the picker before it reads GitHub, and inside the single atomic admission statement
(`admitAutoPickup`), so overlapping wakes cannot exceed either. #1315's guarantees are unchanged: one statement commits the
allowance, the objective and the receipt together; a crash leaves a normal pending objective that the next wake recovers.

## Eligibility before enqueue

After ranking, the picker runs each candidate through `checkStartIdempotency` — the same check every coding start passes
(#1253): a run on it now, a closed issue (cached state), or a run that ended `done` within 7 days. A refused candidate is passed
over and the next one is tried; nothing is queued for it. The refusals are named in the started row's `detail`
("passed over #3 (already_done)") or, when nothing qualifies, in the `none_eligible` reason. The seven-day window and `force`
are untouched; auto-pickup never forces.

## Reporting

`runAutoPickup` returns `started: true` only when the drain made a run. A drain that refused the entry returns
`started: false` with the drain's reason; one that kept it waiting says it is waiting; no evidence either way is not claimed
as a start.

## Not in this change

Counting null-run admission failures toward the per-issue failure quarantine, a configurable five-attempt quarantine, and
fleet-wide history are the linked follow-ups on #1334.
