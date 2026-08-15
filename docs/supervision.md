# Supervision as a platform primitive

> ## ⚠ SUPERSEDED (2026-08-15) — this proposal was built (#605)
>
> **Read the rest of this document as history, not as a description of the platform.** It is written
> in the tense of a plan that had not yet been carried out, and seven of its eight tracked items have
> since shipped. A reader trusting the present tense below will conclude PAGS has no supervision
> graph, no cross-agent delegation, no budgets and no durable loop. It has all four — the Tracking
> table at the end of this file now names where each one lives.
>
> It is kept unrewritten on purpose: the value of a proposal is the reasoning that led to it, and
> rewriting it into a description would destroy exactly that. For how supervision behaves **today**,
> read the code the Tracking table points at — not this file.
>
> **One tracked item was not built:** #160, retiring the `workflow` closed enum. It is **deferred and
> still open, not decided against** — `lib/agent-workflows.ts:33-47` still declares exactly three
> values (`JOB_APPLY`, `CODING_SESSION`, `BROWSER_TASK`). The document's own closing argument, that
> retiring the enum "is what finally makes a Coder configurable", therefore still stands unanswered.

> Status: proposal. Extends `coordination-primitives.md` (#154). That doc deferred cross-agent
> delegation until "a real second consumer beyond Coder" existed. **It now does** — configurable
> multi-layer supervision — so this picks up where the gate left off.

## The observation

Coder has a two-level hierarchy: an **Overseer** coordinates across repos and delegates to each
repo's **Pilot**, which drives an **Engine**. That structure is correct. The problem is *where it
lives*: inside the agent, not in the platform.

Three places hardcode it:

| Hardcoded as | Where | Consequence |
|---|---|---|
| The delegation target is a **repo** | `drive_claude(repoId, instruction)` | You cannot delegate to an *agent*. The type forbids it. |
| The coordinator is a **route** | `POST /:instanceId/coding/overseer` | Supervision is code, not configuration. |
| Depth is **fixed at 2** | Overseer → Pilot → Engine, by construction | No third layer is expressible. |

There is no table anywhere describing *who supervises whom*. So supervision cannot be configured,
cannot be inspected, and cannot be reused by a second agent. Every future agent that needs a
coordinator would rebuild the Overseer.

The fix is not to refactor Coder. It is to give the platform the primitive Coder is already an
instance of — exactly the reasoning #154 applied to `delegate`, now carried one level up.

## Two edge types, and we only have one

PAGS has **choreography**: `agent_connections` (migration 0056) routes an emitted FACT to another
instance. Deliberately decoupled — a producer must not know its consumers. That is the right model
for the lead chain.

Supervision is a **different edge**, and pretending it is the same one would be a mistake:

| | Choreography (built) | Supervision (missing) |
|---|---|---|
| Verb | emit a **fact** | assign a **goal** |
| Addressing | producer doesn't know the consumer | supervisor **names** the subordinate |
| Result | nothing returns | a result returns; the supervisor is **accountable** for it |
| Coupling | decoupled by design | directed and deliberately coupled |
| Failure | dead-letter + replay | **escalate to the supervisor** |
| Shape | fan-out | tree |

Facts flow outward to whoever cares. Goals flow *down* a named tree and results flow *back up*.
Modelling supervision as an event connection would lose the return path and the accountability,
which are the entire point.

What they **share** is the delivery substrate: both need at-least-once handoff, idempotency, and
trace correlation. Migration 0058 already provides all three for connections. Supervision should
reuse that outbox rather than grow a second reliability mechanism — the same argument that
re-scoped #17.

## The design

**A supervision edge is configured data**, owner-scoped like connections:

```
supervisor_instance_id → subordinate_instance_id
```

`delegate(target, goal)` (#156) generalizes its target from `repoId` to an addressable
supervisable entity — an instance, or a repo's Pilot. That single type change is what unlocks
everything else; the rest is enforcement.

A supervisor then works the way the Overseer already does, minus the hardcoding: it reads its
subordinates' status, decides, delegates goals, and reports up. Depth becomes whatever the user
configured. Coder's Overseer becomes *one configuration of the primitive* rather than the only
instance of it.

## What multi-layer makes newly dangerous

Two levels in code are safe because a human wrote them. N levels by configuration are not. These
are the hazards no existing ticket covers, and they are the reason this needs design rather than
just un-deferring #159.

**1. Cycles.** A supervises B supervises A is now reachable by *configuration*, not just by a code
bug — and it is an unbounded loop that spends money. The graph must be validated as a DAG at
wiring time. Same principle as validating connection filters at create time: reject the broken
wiring when the human is present, not at 3am.

**2. Cost multiplies with depth.** Every layer is an LLM. Fan-out 5 at 3 levels is 125 leaf runs
from one delegation. Without a bound, a config typo is a billing incident — and `ai_usage` records
the damage rather than preventing it (it is a ledger, not a control).

Three things about the obvious design are wrong, and worth stating because the obvious design is
what gets built by default:

- **Depth bounds almost nothing.** A supervisor at depth 1 can re-delegate sequentially a thousand
  times without ever increasing depth. Depth caps tree *height*, not work. Cost is the real
  control, plus a delegation *count* (a cheap model spins many iterations before a cost cap bites).
- **A budget "carried down and decremented at each hop" is a per-path copy** — five siblings each
  receive the full allowance, so the tree total is `allowance × fanout^depth`: unbounded in exactly
  the quantity being bounded. It must be a **shared pool scoped to the root**, drawn atomically.
- **Check-then-go overshoots.** Cost is known only *after* a run, so N concurrent branches all pass
  an optimistic check and overshoot by `N × run_cost` — the classic overbooking problem. Reserve a
  bounded maximum before starting, settle the actual on completion, refund the remainder.

And the scope is wider than supervision: cron triggers, webhook triggers, and connection deliveries
all start work with no budget today. Budgeting only delegation plugs one hole in a boat. Retries
draw from the pool too — the 0058 outbox retries up to five times, each re-running the action.

**3. Supervision must not escalate authority.** This is the security-critical one. A subordinate
executes with **its own** consent-gated tools (migration 0051) and **its own** guardrails — never
the supervisor's, and never a union of the two. Otherwise supervision becomes a consent bypass:
wire a low-trust agent beneath a high-trust one and it inherits reach it was never granted. A
delegation carries the *owner's* authority (both instances already belong to one user), plus a
goal. It lends nothing. This is the same boundary #142 draws for creators declaring capabilities.

**4. Goals must terminate.** A goal needs a completion predicate and a deadline, or supervisors
wait forever and the board fills with permanent `running`. Fire-and-forget was #154's complaint
about the old one-shot; "waits forever" is the opposite failure and just as real.

**5. Escalation needs a ladder, not a broadcast.** When a subordinate hits `needs_human`, it
should surface to its **supervisor** first — which may resolve it without waking anyone — and only
reach the human after a bounded number of hops. Otherwise multi-layer supervision multiplies human
interrupts, which is precisely backwards: the point of a hierarchy is to *absorb* interrupts.

**6. Accountability must render as one tree.** The parent trace has to flow down every hop. This
already exists for the pump (`traceId` → child run → a `chain.link` event under the parent) and
should carry unchanged, so a three-level delegation reads as a single tree rather than five
unrelated runs.

## The loop belongs to the platform too

Supervision needs an autonomous worker to delegate *to*. Today that worker is half in the wrong
place.

The platform **already owns the thinking**: `POST /v1/instances/:id/loop-decide` lives in
`routes/instances-chat.ts` — not `coding.ts` — with a pure `lib/loop-decide.ts`. It is instance-scoped
and agent-generic.

The **browser owns the persistence**: `store/console/src/pages/InstanceDetail.tsx` polls that
endpoint and sends the next instruction. Close the tab and an in-flight objective dies. Meanwhile
the Pilot (`CodingSessionWorkflow`) is a durable server-side loop, but Coder-bound and tied to the
`workflow` enum.

Three overlapping mechanisms, and the decide step — the hard part — is already right. What is
missing is a **durable, generic loop runner** any agent can use, with the Pilot as one
configuration.

Two consequences make this blocking rather than tidy-up:

**You cannot budget a loop you do not own.** Every enforcement point the budget needs (#184) sits
on the server side of a loop the server does not drive. So the platform loop is a *precondition*
for budgets, not parallel work.

**It is a straight UX improvement.** A durable loop survives tab close, phone lock and laptop
sleep, and can be reattached from another device — and it makes `max iterations`, already in the
Loop UI, meaningful rather than best-effort.

Tracked in #158 (re-scoped and un-deferred).

## Budgets without breaking what exists

Coder already exposes a budget: the Loop's **`max iterations`**. So this generalizes a concept the
product has taught rather than imposing a new one. Three conditions keep it from becoming an
obstacle:

1. **Attended work is not hard-capped.** When a human clicks Loop and watches, the human is the
   circuit breaker. Hard stops belong on unattended paths (cron, webhook, delivery, sleeping
   delegation); interactive paths get visibility, not enforcement. Chat and `/explain` are not
   gated at all.
2. **Exhaustion is a pause with a one-click raise, never a failure.** Stopping at iteration 30 and
   losing the session is strictly worse than today's no-limit. Pause, keep the timeline, offer
   "continue", resume without redoing work.
3. **Defaults come from the ledger.** `ai_usage` separates `kind` (`coding`/`copilot`/`overseer`/
   `chat`) with `cost_micros`. Set defaults above the 95th percentile of real sessions; the
   acceptance test is "what fraction of historical sessions would this have interrupted?" — target
   ~0.

Design goal: **invisible in normal use, decisive in a runaway.**

## The other half: configuring a Coder at all

"Configure a Coder agent" needs more than supervision. Status of the authoring path:

- **#141 (closed)** — capabilities (`surfaces`/`runtime`/`workflow`/`tools`) are accepted and
  validated on create + update. A Coder-*equivalent* can be stamped out from config.
- **#142 (open)** — trust gating before a creator may declare `runtime`/`workflow`. Gates the
  above for third parties.
- **#160 (open, deferred)** — `capabilities.workflow` is still a **closed enum**
  (`JOB_APPLY`/`CODING_SESSION`/`BROWSER_TASK`) backed by code. You can *select* Coder's brain;
  you cannot *define* one.

So #160 is the real blocker on "configurable Coder," and supervision is the blocker on "Coder's
hierarchy is platform-provided." They are independent and can proceed in parallel.

## Sequencing

1. **#156 — generalize `delegate(target, goal)`.** The target-type change (repoId → supervisable
   entity). Everything else depends on it, and it is the smallest useful step.
1b. **#158 — platform-provided durable loop.** Supervision needs a worker to delegate to, and
   budgets need a loop the server drives. Can proceed in parallel with #156.
2. **Supervision graph as data** — the edge table, DAG validation, wiring API; reuse the 0058
   outbox for handoff.
3. **Budget + authority containment** — depth/spend flowing down, and the no-privilege-inheritance
   rule. Do this *with* step 2, not after: both are cheap to build in and expensive to retrofit.
4. **#157 — typed task/handoff model.** The result channel and the escalation ladder.
5. **#159 — cross-agent delegation** falls out of 1–4 rather than being separate work.
6. **#160 — retire the `workflow` enum**, which is what finally makes a Coder configurable.

Coder stays the first consumer throughout: at each step its Overseer should be re-expressible in
the primitive, and when it is, the hardcoded route comes out.

## Tracking

Where each item ended up, added 2026-08-15 (#605). This column is the pointer this document owes a
reader; it is not a description of how any of it behaves — read the code for that.

| Work | Ticket | Shipped as |
|---|---|---|
| Generalize `delegate(target, goal)` | #156 (un-deferred) | `lib/delegate-target.ts`; tool `delegate_goal` at `lib/connectors/supervision.ts:606` |
| Platform-provided durable agent loop | #158 (re-scoped, un-deferred) | `workflows/agent-loop.ts`, migration `0062_agent_loop_runs.sql` |
| Supervision graph as configured data | #183 | migration `0060_agent_supervision.sql` — table `agent_supervision` |
| Autonomous work budget — cost, count, depth | #184 | migrations `0061_delegation_budgets.sql`, `0113_account_budget_limits.sql`, `0115_account_budget_loop_max_iterations.sql`; `lib/delegation-budget-store.ts` |
| Authority containment (no privilege inheritance) | #185 | `lib/supervision-capability.ts` |
| Typed task/handoff + escalation ladder | #157 | `lib/escalation.ts` |
| Cross-agent delegation | #159 (un-deferred) | `lib/delegate-instance.ts` |
| Retire the `workflow` enum | #160 | **Not built — deferred, still open.** `lib/agent-workflows.ts:33-47` declares three values. |
