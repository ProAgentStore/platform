# Embedded per-instance brain — architecture review

> **Review status:** proposal for joint owner review; no feature in this document is implemented or enabled by it.  Scope is the owner brief on [#154](https://github.com/ProAgentStore/platform/issues/154#issuecomment-6092033597), not a reopening of that closed coordination epic.
>
> **Recommendation in one sentence:** add an explicitly opt-in, per-instance *decision service* with its own model/provider selection, budget and evidence contract; preserve every existing deterministic driver, queue, credential and authority boundary when it is off.

## Executive review guide

The requested experience is an **optional embedded brain on every instance**, not another supervising agent.  Its job is narrow: consume recorded progress evidence, choose a bounded next lifecycle action, and help a capable executor recover.  It is not the chat persona, the executor, a replacement for human controls, or a source of authority.

There are three deliberately independent concerns:

| Concern | What it does | Configuration outcome |
| --- | --- | --- |
| Conversation model | Replies in an instance's chat | Existing `AgentState.model` behaviour remains compatible |
| Execution engine/model | Performs work (for example a local CLI, browser bridge, pipeline or tool loop) | Existing runtime-specific selection remains authoritative |
| Embedded decision model | Interprets typed evidence and selects an allowed lifecycle action | New, per-instance, default-off setting; it must never silently alias either field |

The decision to turn it **on** must grant neither tools, credentials, website access, submission permission nor a broader consent scope.  It allows only a policy-filtered decision over evidence an adapter has already recorded.  The owner must approve the decisions marked **joint review required** below before implementation.

The conservative initial product contract is:

1. New instances and all existing instances default to `embedded_brain: off`.
2. Off means existing deterministic, authorized execution continues: queues, workflows, run persistence, status, pause/resume/cancel and explicit human actions remain available.  There is **no hidden LLM decision call**.
3. On means a supported adapter may ask the decision model to propose only `continue`, `retry`, `wait`, `request_review`, `stop`, or `escalate`; policy validates the proposal before it is persisted or delivered.
4. Existing working loops are never silently disabled, enabled, re-modelled, or re-attributed during migration.  The migration writes no enablement row and exposes a compatibility notice where the legacy shared model had been used.

The recommended first release is observation plus safe recovery on adapters which can prove their evidence and single-driver ownership.  Submission-capable and uncertain-effect paths remain policy- or human-controlled.

## Evidence ledger (current-source review)

Evidence is classified carefully.  “Source-inspected” means present in the checked-out repository at review time; it is not a claim that a real owner machine exercised it.  “Live-verified” means an issue comment reports an actual run.  “Superseded” is useful history, not a current implementation assertion.  “Missing” means no universal contract was found in the inspected surface, rather than proof that no code anywhere can do something similar.

| Status | Evidence and conclusion |
| --- | --- |
| **Source-inspected** | [`AgentState`](../workers/api/src/agent-types.ts) has one `model` plus `modelChosen`; [`agent-do.ts`](../workers/api/src/agent-do.ts) persists that single selection.  It is not a separate decision-model contract. |
| **Source-inspected** | [`BrainModelCard`](../store/console/src/components/BrainModelCard.tsx) describes the selected instance model as shared by **chat and orchestration**.  [`lib/brain-models.ts`](../workers/api/src/lib/brain-models.ts) is the catalogue used for that model family. |
| **Source-inspected** | [`storage.ts`](../workers/api/src/routes/storage.ts) validates an instance model and marks `modelChosen`; [`user-ai.ts`](../workers/api/src/lib/user-ai.ts) uses owner BYOK credentials and fails closed for a selected Workers AI model whose required credentials are missing; [`workers-ai-protocol.ts`](../workers/api/src/lib/workers-ai-protocol.ts) normalizes Workers AI tool calling.  [`set_instance_model`](../workers/mcp/src/instance-tools/settings.ts) writes the same state setting through MCP. |
| **Source-inspected** | [`loop-orchestrator.ts`](../workers/api/src/lib/loop-orchestrator.ts) currently names its orchestration model directly, while [`local-apply/brain.ts`](../workers/api/src/lib/local-apply/brain.ts) reuses the selected instance model for a constrained checkpoint.  These different paths reinforce that there is no explicit all-runtime decision-model resolution contract today. |
| **Source-inspected** | The durable generic loop, Pilot run, driver table, queues, pause gates, triggers and application checkpoint policy listed below exist as distinct primitives.  They are a strong substrate, not a universal toggle. |
| **Live-verified, bounded** | [#944's current report](https://github.com/ProAgentStore/platform/issues/944#issuecomment-6076700095) records implementation/test coverage for the local browser runtime and says live connected-Codex acceptance remains outstanding.  This must not be represented as either absent implementation or completed acceptance. |
| **Superseded/historical** | [`coordination-primitives.md`](./coordination-primitives.md) and [`supervision.md`](./supervision.md) label themselves historical/superseded.  Their references to #160 being open are stale: [#160 is closed](https://github.com/ProAgentStore/platform/issues/160). |
| **Missing (in inspected surface)** | No one per-instance universal `brain_enabled` setting, decision-model/provider record, decision budget, common evidence envelope, or all-runtime adapter contract was found.  The supplied intake labels `b8d922e`/`ff0871e8` should therefore be treated as historical audit pointers; the findings above are grounded in current source, not inferred from those labels. |

The important reconciliation is that the existing `model` is already called a “brain” in some paths, and application runner code already uses it for a bounded checkpoint decision.  That is **evidence of a coupling to untangle**, not evidence that all agents already have a separately configurable embedded brain.

## What can be reused without inventing a second control plane

The proposed feature should compose existing durable primitives rather than duplicate their records or allow a model to route around them.

| Existing primitive | Reuse in embedded-brain design |
| --- | --- |
| [`workflows/agent-loop.ts`](../workers/api/src/workflows/agent-loop.ts) | Generic server-driven iteration, terminal states, cancellation, budget/iteration handling and no-progress semantics.  Use it only where the chat/tool loop remains the executor. |
| [`workflows/coding-session/workflow-run.ts`](../workers/api/src/workflows/coding-session/workflow-run.ts) | Pilot owns an autonomous coding execution and its durable run.  A decision adapter must ask Pilot for evidence; it must not start a second engine driver. |
| [`lib/loop-drivers.ts`](../workers/api/src/lib/loop-drivers.ts) | Common start contract, continuation refusal categories and coding session claims.  It is the single-driver boundary for a generic next-action request. |
| [`workflows/browser-task.ts`](../workers/api/src/workflows/browser-task.ts) | Browser-task lifecycle and the place to adapt recorded browser outcomes, rather than raw page text, into compact evidence. |
| [`lib/local-apply/brain.ts`](../workers/api/src/lib/local-apply/brain.ts) | The strongest policy pattern: typed `continue` / `request_review` / `stop`, deterministic policy precedence, idempotent directive issue, and an audit event that says who decided and why without exposing hidden reasoning. |
| Migration [`0188_local_apply_supervision.sql`](../workers/api/migrations/0188_local_apply_supervision.sql) | Redacted bounded checkpoint facts and immutable idempotent application directives; a useful reference record, not the schema for every runtime. |
| [`lib/objective-queue-start.ts`](../workers/api/src/lib/objective-queue-start.ts) | Claim-before-start and one-at-a-time queue draining.  A brain may request wake/continue; it cannot bypass a claim or open a fresh budget. |
| [`lib/ticket-queue.ts`](../workers/api/src/lib/ticket-queue.ts) and migration [`0162_ticket_queue.sql`](../workers/api/migrations/0162_ticket_queue.sql) | Default-off queue enablement, explicit ticket authority, leases, one-run protection and human requeue.  Queue enablement is not the future universal brain switch. |
| [`routes/instances-lifecycle.ts`](../workers/api/src/routes/instances-lifecycle.ts) | Pause writes the admission block before asking in-flight work to stop; resume does not resurrect stopped work.  Brain configuration must preserve this ordering. |
| Migrations [`0062_agent_loop_runs.sql`](../workers/api/migrations/0062_agent_loop_runs.sql), [`0149_instance_objective_queue.sql`](../workers/api/migrations/0149_instance_objective_queue.sql), [`0162_ticket_queue.sql`](../workers/api/migrations/0162_ticket_queue.sql), [`0045_instance_triggers.sql`](../workers/api/migrations/0045_instance_triggers.sql), [`0060_agent_supervision.sql`](../workers/api/migrations/0060_agent_supervision.sql) | Durable run history, queued objectives, deliberate default-off pickup, event/cron inputs and supervision data.  Add a focused decision record rather than overloading any one of these tables. |

Provider credentials remain separate by design: cloud decision inference uses the owner’s explicit BYOK provider material; website credentials are for a site/session; local CLI subscription login belongs to the owner’s machine/runtime.  A selected decision provider must never fall back to a different provider, a browser login, or local CLI authentication merely because another credential happens to exist.

## Capability matrix and supported-adapter honesty

“All agent types” should mean a common configuration and observable lifecycle contract, not a false promise that each runtime has identical recovery actions on day one.

| Instance/runtime kind | Brain off | Brain-on candidate action set | Initial adapter status / boundary |
| --- | --- | --- | --- |
| Cloud/chat and connector agents | Durable chat/tool loop, authorized deterministic queue execution, state/status and human controls | Observe typed loop progress; continue/wait/retry/escalate/stop within the loop’s existing policy | **Candidate**; requires normalized progress evidence and no-hidden-call verification |
| Pipeline agents | Existing pipeline state, queue/trigger handling and operator controls | Decide only over declared pipeline checkpoints | **Candidate**; no generic pipeline decision adapter was found |
| Repo Coder / local CLI | Pilot/driver claim, explicit repository choice, execution engine and existing recovery | Ask Pilot for recovery classification; request a continuation only after its claim/pause/budget checks | **Candidate, high risk**; never interrupt or replace an active executor |
| Browser and local-browser research | Existing runner, read-only bridge policy, consent pause, result/trace state | Wait for person, request review, resume only after existing consent/recovery condition is cleared | **Partially evidenced**; local-browser implementation is shipped/tested but live Codex acceptance is incomplete ([#944](https://github.com/ProAgentStore/platform/issues/944)) |
| Local application/artifact flow | Existing checkpoint, directive and submission-gate policy | Existing bounded `continue` / `request_review` / `stop` is the reference adapter | **Existing specialised implementation**, not yet a general configuration contract |
| Creator-defined agents | Their declared deterministic behaviour, status and human controls | Only actions their manifest explicitly maps to a safe adapter | **Unsupported until declared**; display “decision brain unavailable for this runtime”, not a misleading toggle |

In every row, an execution LLM is not necessarily a decision LLM.  An executor can be a cloud model, a local subscription CLI, a deterministic workflow, or no model at all.  The brain must not assume it may call executor tools, rerun uncertain effects, or see sensitive artifacts just because the executor did.

## Proposed contract (for decision, not implementation)

### Configuration, precedence and compatibility

**Recommended schema direction, subject to review:** an owner-scoped `instance_embedded_brains` record keyed by `instance_id` with `enabled`, `decision_model_id`, `decision_provider`, `model_source` (`explicit`, `inherited`, `legacy_compatibility`), spend/turn limits, retry policy, revision, and timestamps.  Keep secrets in existing provider-key storage; store references and attribution only.

Precedence should be deliberately boring:

1. Non-bypassable safety/consent/submit policy and paused status;
2. an explicit per-instance decision configuration;
3. a template/creator default only if the owner opted into inheritance;
4. platform default: **off**.

The conversational model and execution engine resolve independently.  For old instances, retain current `AgentState.model` exactly as chat/existing orchestration uses it.  If an owner chooses to migrate to an embedded brain, the UI may offer “use current selected model as decision model” as an explicit copy, recording `model_source`; it must never silently split or reassign it.  A model can be selected only if its provider credential and the runtime’s required capability are available.  Provider credit exhaustion, missing credential, unsupported input and rate limits become typed waits/failures—not provider fallback.

**Joint review required:** whether creator templates may nominate an inheritable decision model at all, or may only nominate a catalogue/capability requirement.  The conservative answer is the latter: owner opt-in and explicit provider choice remain mandatory.

### API, MCP, UI and instruction contract

Expose a single typed configuration/readiness projection to REST, console and MCP:

```text
embeddedBrain: {
  enabled, configured, readiness: ready | unsupported | waiting_for_credentials | paused,
  decisionModel: { id, provider, source } | null,
  budget: { maxTurns, maxSpend, usedTurns, usedSpend },
  adapter: { kind, supportedActions },
  lastDecision: { action, source: policy | brain, evidenceRef, reasonCode, at } | null
}
```

Write operations should be narrow and owner-scoped: configure/disable brain, set an explicit decision model, set budgets, and request a decision at a supported checkpoint.  They should offer `dry_run` where intent or readiness is uncertain, apply existing consent/audit conventions, and return why an action was refused.  They must not include a generic “run arbitrary brain” endpoint.

The UI should explain the three model roles separately and show: off/on, readiness, estimated budget, which actions the adapter permits, the most recent evidence-based decision, and a link to the underlying run/trace.  A clear “this does not grant tools or submission permission” note belongs beside enablement.  MCP instructions must say the same and direct callers to existing pause/stop/continue endpoints for human control.

Instruction precedence is similarly constrained: owner objective and instance instructions describe the desired outcome; runtime adapter instructions define the evidence schema and supported actions; platform policy constrains execution.  A brain receives a compact typed evidence envelope, not unbounded prompt history, browser snapshots, local files, passwords, form values, or raw executor prose by default.

### Evidence, lifecycle, reliability and audit

Each adapter should create an immutable evidence snapshot containing at least: run/instance IDs, executor state, progress counters or checkpoints, last successful external-effect marker, blocked reason, policy/consent state, budget state, event sequence and configuration revision.  The decision record references the snapshot and stores a closed action/reason code.  Audit output is observable (“policy selected `wait`: provider_credit_exhausted”, “brain proposed `continue`, policy overrode to `request_review`: before_submit”), never hidden chain-of-thought.

The decision lifecycle needs these invariants:

- **Single driver:** an active executor retains its claim.  Brain configuration changes and decisions are non-interrupting; they take effect only at a declared safe checkpoint or on the next run.  No decision starts a parallel Pilot, chat loop or browser task.
- **Wake/dedup:** event/terminal wakes carry an idempotency key and monotonic sequence.  A wake can observe an existing decision but cannot create two continuations.  Reuse terminal-outcome event work from [#968](https://github.com/ProAgentStore/platform/issues/968).
- **Progress, not heartbeat:** distinguish alive/working, waiting, stalled and ended; record both heartbeat and forward progress.  Repeating discovery without a changed evidence marker reaches a bounded no-progress outcome rather than spending forever.
- **Failure and recovery:** provider-credit or rate-limit failures become a visible wait with bounded, backoff retry.  Repeated identical failures need a changed credential/readiness/evidence condition before retry.  Restart/offline recovery re-reads the persisted evidence/decision and claim rather than replaying work.
- **Uncertain effects:** after a timeout or lost connection around an external action, record `outcome_unknown`, request reconciliation/review, and never replay the effect automatically.  Browser/login/captcha pauses remain human-controlled.
- **Pause/stop:** pause blocks future admission before cooperative stop, as it does now.  Disable/pause/stop must be visible in the decision record; an in-flight model response cannot cause action after it loses its policy revision/claim check.

### Cost and policy boundaries

Decision inference must have its own reservation/usage attribution and caps, separate from any execution-engine spend and from a parent delegation budget.  Every decision has a maximum input/output size, timeout and allowed tool/action vocabulary.  Decision calls cannot carry tool authority: policy code translates only a validated persisted action into a call to an existing adapter.  This preserves the existing rule that supervision/delegation lends a goal, not privileges.

## Issue and design deduplication map

The following are closed, useful substrate or historical context—not candidate tickets to reopen for this feature: [#154](https://github.com/ProAgentStore/platform/issues/154), [#158](https://github.com/ProAgentStore/platform/issues/158), [#204](https://github.com/ProAgentStore/platform/issues/204), [#825](https://github.com/ProAgentStore/platform/issues/825), [#851](https://github.com/ProAgentStore/platform/issues/851), [#852](https://github.com/ProAgentStore/platform/issues/852), [#853](https://github.com/ProAgentStore/platform/issues/853), [#863](https://github.com/ProAgentStore/platform/issues/863), [#864](https://github.com/ProAgentStore/platform/issues/864), [#875](https://github.com/ProAgentStore/platform/issues/875), [#968](https://github.com/ProAgentStore/platform/issues/968), [#982](https://github.com/ProAgentStore/platform/issues/982), [#985](https://github.com/ProAgentStore/platform/issues/985), and [#988](https://github.com/ProAgentStore/platform/issues/988).  [#160](https://github.com/ProAgentStore/platform/issues/160) is also closed despite old prose saying otherwise.

[#943](https://github.com/ProAgentStore/platform/issues/943) remains the open umbrella for a repo-free local CLI browser runner.  [#944](https://github.com/ProAgentStore/platform/issues/944) remains open specifically because its implementation is shipped but its live connected-Codex acceptance is not complete; its live evidence and remaining matrix are recorded [here](https://github.com/ProAgentStore/platform/issues/944#issuecomment-6076700095).  Do not use incomplete acceptance to erase shipped implementation, and do not use merged code to claim live proof.

Historical recovery reports (#391, #505, #522, #541 and #545) should be read before a targeted adapter changes, but are not declared regressions in this review.  A new ticket needs current trace/reproduction evidence, an invariant, and a test of observed behaviour rather than a status-derived conclusion.

## Draft child tickets — do not file before owner review

These are dependency-ordered proposals, not issue creation requests.  Each is deliberately narrower than a “brain everywhere” implementation.

1. **Embedded-brain configuration and model separation** *(first; no runtime behaviour change)*
   - Add default-off owner-scoped configuration/readiness projection; explicit decision provider/model and independent budget fields; compatibility migration with no auto-enable or auto-disable.
   - Dedup: extends model-selection conclusions of [#852](https://github.com/ProAgentStore/platform/issues/852), [#853](https://github.com/ProAgentStore/platform/issues/853), [#863](https://github.com/ProAgentStore/platform/issues/863) and [#875](https://github.com/ProAgentStore/platform/issues/875); does not reopen them.
   - Acceptance: old cloud/chat, Coder, browser, pipeline, local-apply and creator-defined instances retain their existing model/runtime; missing provider is actionable and fail-closed; configuration exposes unsupported adapters honestly; no decision inference happens while off.
   - Risk/review: migration/cost attribution and whether template inheritance is permitted.  **Recommendation:** explicit owner selection only for v1.

2. **Policy/evidence core and adapter registry** *(depends on 1)*
   - Define closed evidence/action schemas, policy-before-model evaluation, revision/claim checks, typed audit and per-adapter declared capabilities.  Provide a deterministic fake adapter for conformance tests.
   - Dedup: extract the reusable shape demonstrated by [#982](https://github.com/ProAgentStore/platform/issues/982) and [#985](https://github.com/ProAgentStore/platform/issues/985), rather than generalising their application policy implicitly.
   - Acceptance: policy overrides unsafe proposals; enabling adds no tools/credentials; off makes zero decision calls; unsupported creator runtime returns `unsupported`; audit cites evidence and reason but no private reasoning.
   - Risk/review: evidence minimisation and retention.  **Recommendation:** typed counters/state/reason codes only, with opt-in diagnostics under existing privacy rules.

3. **Progress, recovery and event-dedup conformance** *(depends on 2)*
   - Add standard progress snapshots, no-progress/discovery-loop rules, provider-credit wait/backoff, restart/offline reconciliation and idempotent wakes.
   - Dedup: build on [#968](https://github.com/ProAgentStore/platform/issues/968), durable loop runs [#158](https://github.com/ProAgentStore/platform/issues/158), pause [#825](https://github.com/ProAgentStore/platform/issues/825), and queues [#864](https://github.com/ProAgentStore/platform/issues/864).
   - Acceptance: duplicate event/restart causes one continuation; active executor is not interrupted; uncertain external effect is never replayed; retries cease until a relevant condition changes; each runtime reports working/waiting/stalled/ended separately from progress.
   - Risk/review: false positive no-progress cutoff.  **Recommendation:** start conservative with per-adapter thresholds and human-visible reason codes.

4. **Supported runtime adapters: chat/pipeline, Coder, browser/local runner, local application** *(depends on 2 and 3; split by risk if needed)*
   - Each adapter declares checkpoint evidence and action mappings; integrate through existing drivers rather than direct executor control.
   - Dedup: Coder must preserve [#204](https://github.com/ProAgentStore/platform/issues/204) and driver claims; local browser work belongs alongside [#943](https://github.com/ProAgentStore/platform/issues/943)/[#944](https://github.com/ProAgentStore/platform/issues/944), not a parallel runner; local-apply builds on [#982](https://github.com/ProAgentStore/platform/issues/982)/[#985](https://github.com/ProAgentStore/platform/issues/985).
   - Acceptance across types: brain-off deterministic execution; a safe brain-on continuation; blocked/consent provider state becomes wait/review; no direct tool widening; no active-engine interrupt; no submission without the existing gate.
   - Risk/review: local/live acceptance prerequisites.  **Recommendation:** do not enable a browser/local adapter in product UI until its own live acceptance criteria are met.

5. **Console/MCP controls, migration messaging and cross-adapter conformance suite** *(last; depends on 1–4)*
   - Ship one explanation/receipt shape, explicit enable/disable/model/budget flows, run/audit views, dry-run readiness, and an invariant suite spanning all declared runtime kinds.
   - Dedup: extend existing MCP setting practice, not a generic authority proxy; respect [#988](https://github.com/ProAgentStore/platform/issues/988)'s projection work.
   - Acceptance: console and MCP see identical readiness/action/audit facts; disabling is non-interrupting; pause/stop semantics remain correct; migrations do not alter existing run configuration; compatibility and rollback are testable.
   - Risk/review: UI can make “on” appear more powerful than it is.  **Recommendation:** lead with allowed actions and boundaries, not a vague autonomy promise.

## Decisions requested from the owner

Before code begins, joint review should choose:

1. Approve the default-off, explicit per-instance configuration and no-silent-migration recommendation.
2. Approve separate decision model/provider/budget attribution rather than reusing `AgentState.model` indefinitely.
3. Confirm the initial action vocabulary: recommend `continue`, `wait`, `retry`, `request_review`, `stop`, `escalate`; exclude arbitrary tools, direct submission and replay.
4. Confirm v1 adapter order: local-apply/reference policy first, then generic chat/pipeline, then Coder and browser/local runtimes only after their safety/live prerequisites.
5. Decide whether a template may recommend a decision-model catalogue entry or must never set one; recommend recommendation-only, owner approval required.

With these choices, the feature can extend the platform’s existing durable, consent-bounded mechanisms without silently converting any already-working agent into a different autonomous system.
