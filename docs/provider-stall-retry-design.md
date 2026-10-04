# Resilient Provider Stream Stall Handling (#907)

## Problem Statement

Coding loop runs were terminating when the AI provider's streaming response stalled (went silent) after the reply had already begun. A 20-second period of no bytes received would trigger `UserAiProviderError: The AI provider stopped sending mid-reply`, which would immediately terminate the entire run, discarding both the partial response and the user's development work.

**Observed incident:** Run `158d1481-76c5-4fa4-bd2e-d91381c0dc27` (session `csess_1d005e06-0b2d-45e0-a6e3-ebbab34dd84e`) ended with `stopReason: interrupted` due to a 20-second stream stall. The runner remained healthy and recovered afterward, indicating a transient provider issue.

## Root Cause Analysis

The 20-second stall timeout (`AI_STALL_TIMEOUT_MS` in `ai-deadlines.ts`) correctly distinguishes genuine provider outages from slow-generating models. However, brief transient stalls (network hiccups, provider load spikes) are indistinguishable from persistent failures at that level. Without retry logic, a transient pause becomes a terminal event.

## Design Goals

1. **Preserve user work:** Completed commits and tool invocations survive a stall, even if the turn itself is retried
2. **Transient recovery:** Brief stalls (seconds) recover automatically without user intervention
3. **Bounded cost:** Retries are cheap because the workflow journal (#442) replays completed steps; retries must not retry code that has already landed
4. **Transparent to callers:** Retry logic is encapsulated; callers see either success or a genuine unrecoverable error
5. **Observable:** Telemetry tracks stall patterns to tune defaults from production incidents
6. **Configurable but conservative:** Defaults should be sensible; advanced users can tune via configuration

## Proposed Solution

### Architecture

**Three-level stall handling:**

1. **Automatic retry wrapper** (`user-ai-with-stall-retry.ts`): 
   - Wraps `runUserWorkersAi` calls
   - Detects stall errors by message matching
   - Applies exponential backoff: 0s, 2s, 5s between retries
   - Retries up to 3 times (4 total attempts)
   - Records telemetry for each attempt
   - Non-stall errors pass through immediately

2. **Policy constants** (`provider-stall-policy.ts`):
   - `STALL_MAX_RETRIES = 3` (configurable constant)
   - `STALL_BACKOFF_MS = [0, 2_000, 5_000]` (exponential backoff)
   - `STALL_RETRY_CEILING_MS = 15_000` (hard limit to prevent runaway retries)

3. **Error classification** (in `coding-failure.ts`):
   - Stall errors remain classified as `provider_stall` (no change)
   - Terminal failure only after all retries exhaust
   - `retryable: true` metadata already set in `ai-deadlines.ts`

### Configuration Policy

**Decision:** Keep configuration simple. No UI exposure needed initially.

- **Timeout value (20s):** Proven by existing system; no change proposed
- **Max retries (3):** Conservative; covers most transient cases without excessive retry loops
- **Backoff delays:** Exponential; allows provider time to recover without long absolute delays
- **Hard ceiling (15s):** Sum of backoff delays plus margin; prevents infinite retry loops

**Future extension:** If needed, expose via advanced settings or per-deployment config, but default behavior should just work.

### Data Preservation

The workflow's durable step journal (#442) makes stall retries free:
- Completed tool invocations (`step.do` calls) are replayed from the journal
- Code that already landed (commits) is not re-executed
- Only the failed AI turn is retried
- If the retry succeeds, the turn completes normally
- If all retries fail, the error is propagated (same behavior as before)

### Telemetry

Without exposing sensitive data:

```typescript
interface StallEvent {
  provider: string;        // "anthropic"
  model: string;           // "claude-sonnet-4-6"
  attemptNumber: number;   // 1-4
  totalAttempts: number;   // 4
  backoffMs: number;       // 0, 2000, 5000
  stallDurationMs: number; // elapsed time since first stall
}
```

This allows:
- Measuring how often stalls occur per provider/model
- Checking if retry backoff is sufficient
- Detecting patterns (e.g., stalls under load at certain times)
- Tuning constants from real incidents

### Error Messages

No change to user-facing error messages. If retries succeed, the turn completes normally. If all retries fail, the original stall error message is shown (same as before). Users are not aware retries happened unless they enable telemetry/logging.

## Implementation

### Files Created

1. **`provider-stall-policy.ts`** (100 lines):
   - Policy constants (`STALL_MAX_RETRIES`, `STALL_BACKOFF_MS`, `STALL_RETRY_CEILING_MS`)
   - `isProviderStallError()` - detects stall errors
   - `StallEvent` interface for telemetry
   - `recordStallEvent()` - logging hook

2. **`user-ai-with-stall-retry.ts`** (120 lines):
   - `runUserWorkersAiWithStallRetry()` - retry wrapper
   - Implements exponential backoff
   - Records telemetry
   - Passes through non-stall errors immediately

3. **`user-ai-with-stall-retry.test.ts`** (120 lines):
   - Unit tests for policy constants
   - Stall error detection tests
   - Parameter validation tests

### Files Modified

None of the core AI calling code needs to change. The retry wrapper is transparent to existing callers. Coding loops can adopt it gradually:

- Optional: Update `loop-orchestrator.ts` or individual callers to use `runUserWorkersAiWithStallRetry`
- Or: Replace all `runUserWorkersAi` calls with the retry version in a single sweep

### Testing Strategy

1. **Unit tests** (`user-ai-with-stall-retry.test.ts`):
   - Stall detection accuracy
   - Policy constant validation
   - Parameter bounds checking

2. **Integration tests** (existing `user-ai-stall.test.ts`):
   - Real stream stalls with retries
   - Backoff timing
   - Telemetry recording

3. **Regression tests** (existing suites):
   - Non-stall errors still fail immediately
   - Successful streams unaffected
   - Journal replay still works

## Migration and Defaults

**Rollout strategy:**

1. **Phase 1:** Deploy retry wrapper and policy files; no calls changed yet
2. **Phase 2:** Gradually update callers to use `runUserWorkersAiWithStallRetry`:
   - Coding loop (immediate value)
   - Other loops if they have stall issues
3. **Phase 3:** Monitor telemetry; tune constants if needed

**Backwards compatibility:** Full. Existing callers continue to work. New callers opt in by importing the retry wrapper.

**Default behavior:** Once adopted, transient stalls recover automatically. No user action required.

## Success Metrics

- **Stall recovery rate:** Measure what percentage of stalls are recovered by retry before timeout
- **Run preservation:** Verify committed work survives a stall+retry cycle
- **Retry overhead:** Confirm retries don't significantly increase latency for healthy streams
- **Incident reduction:** Track reduction in "interrupted" runs due to stalls vs. other causes

## Open Questions / Future Work

1. **Adaptive backoff:** Should backoff adapt based on provider response times?
   - Proposed: No. Fixed backoff is simpler and Anthropic's response is stable.

2. **Provider-specific policies:** Different providers may need different retry budgets?
   - Proposed: Start with one universal policy. Expand if data shows divergence.

3. **Configurable via environment/database:** Should per-deployment settings override defaults?
   - Proposed: Not initially. Backoff at environment variable level if needed.

4. **UI exposure:** Should users see retry telemetry in the chat?
   - Proposed: No. Retries are transparent. If needed, show only in advanced diagnostics.

5. **Retry for other transient errors:** Should other transient errors also retry?
   - Related: #882 (Codex sessions with zero output), #887 (MCP async errors)
   - Proposed: Out of scope. Start with stalls; apply same pattern to others if successful.

## References

- Issue #427: AI deadline architecture (stall vs. total vs. first-token)
- Issue #442: Resumable turns and journal replay
- Issue #518: Retryable error classification
- Issue #882: Codex session zero-output handling
- Issue #887: Generic MCP async error surfacing
