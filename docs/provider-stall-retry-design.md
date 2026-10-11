# Controller AI-provider stall recovery (#907)

## Scope

This covers the **controller's** own requests to its AI provider: the Pilot's decisions, the Loop orchestrator and the Co-pilot. It does not cover the local coding CLI or the runner. A provider stream going silent says nothing about either of them, and no message ever claims it does.

## What changed, and why the first attempt did not work

The first #907 delivery (700bc091) added `runUserWorkersAiWithStallRetry`, but no production code ever called it. Its 15 s "ceiling" was never enforced, its telemetry hook was empty, and the provider was hard-coded. It has been removed. Its tests only checked constants.

## Deadlines are phase-aware (`user-ai.ts` `readAnthropicStream`)

- **Pre-content.** The stream is in this phase until the model produces a content block (`content_block_start` / `content_block_delta`).
  - Connection framing (`message_start`, `ping`) keeps the stream alive exactly as before.
  - Framing no longer ends the first-content budget. The first byte is not the first answer.
  - The deadline never gets stricter than it was before this change.
- **Mid-reply.** Once content has begun, silence between chunks is bounded by the silence budget.
- **Total.** Each request has its own wall-clock cap, clamped by the decision ceiling below.
- **Recorded on every stall.** A stall carries its measured phase: content started or not, events seen, last event type, how long it had been silent, elapsed time. It also carries the provider and model the request actually used.
- **Survives the step boundary.** The phase is also written into the message as a `[stream: …]` suffix, because a Workflow step boundary keeps an error's message but not its properties. That is why none of 166 production stalls had recorded `events` before this change. `recordCodingFailure` reads the phase from either source.

## One recovery policy (`lib/controller-ai-recovery.ts`)

Every controller call goes through `controllerAiCall`, which does the following:

- **Retries only a provider stall:** silence before content, silence mid-reply, or a dropped stream. Credentials, credit, rate-limit and total-length failures, and bugs, pass through on the first throw.
- **Bounds it:** at most 4 attempts, with backoff of 2 s, 5 s, then 10 s. A **wall-clock ceiling counts attempt time and backoff together**. An attempt is only started while there is at least 15 s left, and each attempt's own deadlines are clamped to the time remaining.
- **Honours cancellation** before every attempt and after every backoff. A cancelled Pilot decision ends the round as `cancelled` and sends nothing to the engine.
- **Never forwards a partial reply.** A stalled attempt raises before returning anything, so a retry re-asks the same question from the same state.
- **Never replays a side effect.** The Pilot's acts are separate journalled steps, and the Co-pilot runs its read-only tools only after a successful call.
- **Draws budget per attempt.** Each Pilot attempt reserves and settles its own budget draw.
- **Emits sanitized telemetry** to the agent trace (`source: controller-ai`, `controller_ai.stall | recovered | exhausted | ceiling | cancelled`): surface, provider, model, attempt, configured deadlines, measured phase, backoff and elapsed time. No prompt, reply, key or pane text.

### How a stream's ending decides it (`anthropic-stream.ts` `finish()`)

What matters is why an incomplete tool call stopped. A partial call is never returned in any of these cases.

| How the stream ended | Outcome |
|---|---|
| The transport ended before `message_stop`, mid tool call | Transient. Marked `[stream: incomplete-tool-args]`, retried by this policy, and resumable `provider_stall` from its message alone |
| `message_stop` with a tool still open, no output cap | The provider stopped mid-reply. Marked and retried the same way |
| `max_tokens`/`length` with a tool still open | The known output-cap outcome (#504), the same on every attempt. One attempt, not a stall, `provider_error` once only its message is left |
| The transport ended mid prose, a malformed closed call, an `error` frame, a non-JSON frame | One attempt, not a stall |

### Not nested inside the other two layers

- **Step retry.** The Pilot's decide step keeps Cloudflare's step retry for non-stall failures. A stall that exhausts recovery is **returned** across the step boundary rather than thrown (`lib/pilot-decide.ts`), so the step retry does not run the whole recovery again.
- **Round resume.** Outside the step it is raised as an ordinary error. The existing round-level resume (`coding-interrupt.ts`, bounded per run) classifies it as `provider_stall` and handles it once.

## Exhaustion is truthful and recoverable

The message says the controller's AI provider stalled, how many attempts were made and over how long, and where each one stalled. It also says that the CLI, the runner and the repository were not involved and that no partial decision was sent. The objective and its queue are kept. The run is classified `provider_stall`, which is resumable and is never a CLI login, credit, runner or code failure.

## Settings: per instance, Advanced

`GET` / `PUT /v1/instances/:id/controller-ai` stores `agent_instances.config.controllerAi`.

| Setting | Default | Bounds |
|---|---|---|
| `preContentSeconds` | 60 | 20–180 |
| `silenceSeconds` | 45 | 15–120 |
| `decisionCeilingSeconds` | 240 | 60–600 |

Values must be whole seconds inside the bounds. An out-of-range value is refused, never silently clamped, and `null` restores the default. Requests with no stored settings use the defaults.

## Tuning

Use the `controller_ai.*` events and the stall phase that `error_log` now records. Before changing a default, look at the share of stalls that happen before content versus mid-reply, and at their silence durations.
