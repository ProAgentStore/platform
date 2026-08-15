# Run Lifecycle

A **run** is one autonomous unit of work an agent started for you — a Loop objective, a coding session's Pilot, an apply workflow. While it is going, the platform reports it through a small, fixed vocabulary: a verdict called `health`, three timestamps, and a park.

This page is the reference for that vocabulary. It exists because the words are easy to guess at and expensive to guess wrong: the same run can be legitimately silent for ten minutes, deliberately parked for four hours, or actually dead, and the intervention each one deserves is different.

The value sets below are **generated from the code that emits them**. If a state or a park reason is added, this page stops matching and the docs gate fails — so what you read here is what the platform will actually send you.

## Liveness, Progress And A Park Are Three Different Facts

Migration `0127` split what used to be one column, because a single "is it still going" signal was being asked three incompatible questions at once.

| Field | What it means | What it does **not** mean |
| --- | --- | --- |
| `lastAliveAt` | The orchestrator's **heartbeat**. Written by every tick and by every real advance. | Not evidence that anything is being accomplished — a parked run keeps ticking on purpose. |
| `lastProgressAt` | The last time the run **advanced an instruction**. | Not a liveness signal. It stands still through one long, healthy engine turn. |
| `waitingUntil` / `waitingReason` | The run is **deliberately parked**, named and dated. | Not a stall. Nothing is advancing and that is correct. |
| `interruptions` | How many times a platform event (our own deploy evicting a Durable Object) interrupted this run and it was resumed. | Not a failure count. A resumed run is a working run. |

The reason this matters is that the two signals disagree constantly in normal operation, and each disagreement has an innocent explanation:

- **Fresh heartbeat, stale progress.** A large refactor is legitimately many minutes into one instruction. This is also exactly what a park looks like, and what a stall looks like from a distance.
- **Stale heartbeat.** Now something is wrong: a Workflow that dies mid-step leaves its row saying `running` forever.

Read `health` rather than deriving your own verdict from the timestamps. That inference has told an owner a run was stuck while the engine was mid-edit, and the intervention it invites — restart the session, kill the engine — destroys work that was progressing normally.

## `health` — The Platform's Own Verdict

<!-- generated:run-health — rendered from `RUN_HEALTH_STATES` in `workers/api/src/lib/work-report.ts`. Do not edit by hand; `pnpm docs:drift` prints the expected text. -->

`health` has **4** values: `working`, `waiting`, `stalled`, `ended`.

<!-- /generated:run-health -->

- **`working`** — the orchestrator is ticking. It may legitimately be many minutes into a single instruction. Nothing is wrong and nothing is wanted from you.
- **`waiting`** — deliberately parked. See the park table below; the reason says what for, and the verb says what happens when the clock runs out.
- **`stalled`** — nothing has ticked for 15 minutes. The row will say `running` forever and the Workflow is probably gone. This is the state worth acting on.
- **`ended`** — the run is **closed**. Read `status` and `stopReason` for what happened.

### `ended` Is The Common Answer, Not An Edge Case

`check_instance_loop` and `coding_loop_status` list an instance's recent runs without filtering by status, most of which finished hours or days ago. So most rows you see carry `ended`, and that is the expected reading rather than a sign something went wrong.

`ended` makes **no liveness claim in either direction**. It does not mean the run succeeded — a run that failed days ago is `ended` too. It is a statement that the liveness question no longer applies, and the answer to "what happened" is `status` and `stopReason`.

It is a word rather than an omitted field on purpose. Before it existed the classifier fell through to `working`, and a live measurement on 2026-08-15 found `health` reading `"working"` on all 89 runs across 7 instances, including runs that had failed days earlier. Leaving the field off instead was rejected for the same reason: a model reads an absent key as "fine".

## Neither Timestamp Speaks For The Engine

This is the most important limit on everything above, and the one that has caused real misreporting.

`lastAliveAt` is the **orchestrator's** heartbeat and `lastProgressAt` is its last advance. Neither is the engine's last output. A run's `health` describes the platform's own loop — and some runs have no engine at all.

The engine's own state lives behind `/capture`, on the coding surface. The two genuinely disagree: `check_instance_loop` has reported `running` with a fresh timestamp at the same moment `coding_session_capture.runState` said `idle` and the terminal pane showed the CLI's own usage-limit message.

So a fresh heartbeat is not an all-clear about the engine. If the question is "what is the CLI doing right now", read the capture; `health` cannot answer it, and treating it as though it can replaces a false stall with a false all-clear.

## Parks — What A Run Is Waiting For, And What Its Clock Means

A park is a run that is **not advancing on purpose**. `waitingReason` is a short platform enum, never free text, and `waitingUntil` is **the instant this park's clock runs out**.

What running out *means* is entailed by the reason, and the two kinds demand opposite actions from you:

<!-- generated:run-wait-reasons — rendered from `RUN_WAIT_REASONS` in `workers/api/src/lib/agent-loop-store.ts` and `PARKS` in `workers/api/src/lib/work-report.ts`. Do not edit by hand; `pnpm docs:drift` prints the expected text. -->

| `waitingReason` | What the run is waiting for | When `waitingUntil` runs out |
| --- | --- | --- |
| `engine_limit` | the coding CLI's own usage limit has to reset | **resumes** — the run continues by itself, and the owner does nothing |
| `human` | it is waiting for YOU to answer a handoff | **gives up** — the run stops waiting, and the owner has until then to act |
| `platform_interrupt` | a platform update interrupted it and it is being resumed | **resumes** — the run continues by itself, and the owner does nothing |

<!-- /generated:run-wait-reasons -->

**Read the verb before deciding a parked run needs nothing from you.** "Resuming in 12 minutes" means sit still. "Gives up in 12 minutes" means go and answer it now — one park is waiting for a *person*, and its clock is running against them rather than for them.

Two consequences of the clock being one field with one meaning:

- **A park with no knowable instant still parks.** `platform_interrupt` often has no time attached, because journal replay finishes when it finishes. The run is parked; there is simply no deadline to state.
- **A deadline in the past renders as nothing.** "Gives up in −3m" is not a sentence, and the next tick either clears the park or closes the run.

A park also outranks the heartbeat test. A run parked on a platform interruption is mid-resume and has nothing ticking *by design*, so reading its silence as death would report a recovery in progress as a failure.

## Where You See This

- **`check_instance_loop`** and **`coding_loop_status`** (MCP) — an instance's recent runs, each with `health` and, when parked, a note saying what for and until when.
- **`check_work`** (agent tool) — how an agent reads back a run it started itself.
- The **recent work** block the agent receives automatically, which is rendered by the same code, so the tool result and the context block can never tell different stories about one run.

Quote `health` rather than re-deriving it. It is one verdict, produced in one place, and every surface that reports a run ships the same explanation of it.
