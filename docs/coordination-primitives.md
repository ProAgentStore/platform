# Coordination primitives — delegate goals, not one-shots

> **Status:** design proposal, 2026-08. Companion to [`agent-platform-strategy.md`](./agent-platform-strategy.md)
> and [`connector-manifest.md`](./connector-manifest.md). Where the connector work made *what an
> agent can touch* declarative, this makes *how work is delegated* correct — as a **platform
> primitive** that Coder is the first consumer of, NOT a refactor of Coder's hardcoded internals.

## The problem (verified in code)

A coordinator brain hands work to an executor. Today the Coder's cross-repo brain, the **Overseer**
(`routes/coding.ts` `/overseer` → `drive_claude`), fires **one instruction** at a repo's Engine and
returns. Likewise `send_to_cli(repo_name, message)` (`lib/storage-tools.ts`) is a single message to a
coding engine session. Both are **fire-and-forget one-shots** with:

- no follow-through — the Engine may get stuck / need input / half-finish, and the coordinator never
  knows;
- no typed handoff — `drive_claude` returns a *reply string*, not a task with an owner + status +
  result;
- three overlapping ways to drive an Engine (Chat's `send_to_cli`, the client-driven **Loop**, the
  Overseer's `drive_claude`) with only *implicit* rules about which to use;
- autonomy that isn't durable — the Loop is driven by the console polling `/capture` → `/loop-decide`
  → `/message`, so it dies when the browser closes (the **Pilot**, `CodingSessionWorkflow`, *is*
  durable — the Loop overlaps it instead of being its UI).

## What's already right (keep)

The primitives are sound and stay: **Engine = executor / brain = decider**; deterministic target
routing (repo → *one* active session → live runner node, multi-machine aware); per-instance DO
isolation; consent-gated, now-declarative tools. This is **not a rewrite** — the executor layer is
best-practice. Only the *coordination policy* on top needs tightening.

## The principle

**Delegate at the right abstraction, through a durable handoff.** Commands go to Engines; **goals go
to autonomous workers** (a Pilot, or later another agent) that own the loop/retry/escalate; a
coordinator delegates goals and **tracks status** — it never micro-manages an executor or fires a
blind one-shot for multi-step work.

## Why build it as a primitive, not a Coder refactor

Every fix here is a *general* capability, not Coder-internal cleanup: a `delegate(target, goal)` verb,
a typed task/handoff record, and goal→durable-runner all belong to the platform. So we build the fix
**as the primitive**, with Coder as the **first consumer**. Same effort → (a) fixes the Overseer gap,
(b) is reusable by every future agent, (c) moves Coder *toward configured* instead of entrenching it
as hardcoded. Two failure modes we explicitly avoid: **polishing the hardcoded thing** (a cosmetic
Coder refactor) and **building the framework before the need** (a speculative cross-agent orchestrator
with no second consumer yet).

## Scope

### Near-term — the only thing we build now
**Overseer delegates a GOAL to the durable Pilot (with a task/status handle), replacing the one-shot
for multi-step work.** For a genuine one-shot ("run the tests") the direct Engine send stays; for
anything multi-step the Overseer hands a goal to the repo's Pilot (`CodingSessionWorkflow`), which
owns the loop and escalation, and the coordinator gets a task it can report on. This is simultaneously
the correctness fix *and* the first slice of the `delegate` primitive + task record — shaped to
generalize, generalized only as far as this consumer forces.

### Deferred — filed, not built (need a proven primitive and/or a real second consumer)
- **First-class `delegate(target, goal)` registry primitive** — extract the near-term mechanism into a
  general tool (target = a repo's Pilot now; an *instance/agent* later).
- **Typed task/handoff model** — a first-class coordination record (task → owner → status → result)
  on the existing board + `coding_timeline`, so all delegation is observable + resumable.
- **Converge the Loop into the durable Pilot** — make the console Loop a thin UI over the durable
  Pilot workflow rather than a parallel client-driven brain (one autonomous brain, survives the tab
  closing).
- **Cross-agent delegation** — delegate a goal to *another instance's* brain (the "manager + workers"
  shape for the multi-agent marketplace). Needs a real second consumer beyond Coder.
- **Retire the `workflow` closed enum** — behavior (`JOB_APPLY`/`CODING_SESSION`/`INSURANCE_QUOTES`)
  becomes declarative (composed steps/triggers), so a creator can define a *new* autonomous loop.
  The larger "open the vocabulary" frontier from the strategy doc.

## Sequencing

Finish the connector/tool substrate (in flight) → ship the near-term Overseer→Pilot goal delegation →
let it prove out with Coder → THEN promote the mechanism to the first-class `delegate` primitive +
typed task model → THEN cross-agent + workflow-enum retirement once a second consumer exists. Build
the abstraction when the fix you'd make anyway can be made *through* it and it has a real first
consumer — not before.
