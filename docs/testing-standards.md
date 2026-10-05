# Testing Standards for ProAgentStore Platform

## Source-Assertion Guards: The Problem

Source-assertion guards are tests that read source code text and assert the presence of specific strings or patterns. These guards are brittle and problematic:

- **They fail on refactoring:** When code is moved, renamed, or restructured (as with #912's workflow split), guards break even when the behavior they protect is intact
- **They encourage copy-paste verification:** A string match doesn't verify correctness; it just verifies that text exists somewhere
- **They're invisible to tools:** IDEs, refactoring tools, and type checkers can't understand what the guard actually protects
- **They rot quickly:** A guard checking for exact code patterns breaks when someone reformats, adds comments, or renames variables

## The Standard: Behavioural and Structure-Aware Tests Only

**Rule: Never write a new source-assertion guard that checks for literal text in a hardcoded file path.**

Instead, test the **behaviour** (call the code, assert the effect) or use **structure-aware checks** that survive refactoring:

### What This Means

#### ❌ BAD: Source-text string matches
```typescript
// BAD: Breaks when code moves or is reformatted
const source = readFileSync(join(__dirname, "../workflows/coding-session.ts"), "utf8");
expect(source).toContain('step.do("resume-note"');  // Brittle to any change
```

#### ✅ GOOD: Behavioural tests
```typescript
// GOOD: Tests what actually matters — the resume note is calculated
import { pendingCodingResumeNote } from "./coding-resume-note.js";

it("computes a resume note when a run is cut off", async () => {
  const note = await pendingCodingResumeNote(env, {
    userId: "u1",
    instanceId: "inst-1",
    sessionId: "s1",
    uncommittedFiles: 3,
  });
  expect(note).not.toBeNull();  // Tests the function, not the text
});
```

#### ✅ GOOD: Structure-aware checks (import-based)
```typescript
// GOOD: Checks that a function exists and is callable
import { pendingCodingResumeNote } from "./coding-resume-note.js";

it("exports pendingCodingResumeNote function", () => {
  expect(typeof pendingCodingResumeNote).toBe("function");
});
```

#### ✅ GOOD: AST or module introspection (when needed)
```typescript
// For truly architectural checks (e.g., "this module is imported in the workflow")
// use dynamic imports or module metadata, not source-text scanning
import * as workflowRun from "../workflows/coding-session/workflow-run.js";

it("workflow imports resume-note logic", () => {
  expect(workflowRun).toHaveProperty("runCodingSessionWorkflow");
});
```

## Converting Existing Guards

Don't mass-delete existing guards. Convert them case-by-case:

1. **Understand the invariant:** What does this guard actually care about? "Does function X exist?" or "Is side effect Y happening?" or "Are two related things changed together?"

2. **Test the invariant, not the text:** Write a test that would fail if the invariant broke, independent of file structure.

3. **Delete the source-assertion:** Once the behavioural test covers it, remove the source-text check.

4. **Verify with a refactor:** Move the code that was being guarded and confirm the behavioural test still passes.

## Inventory of Existing Source-Assertion Guards in workers/api

These guards currently read source files and check for text patterns. They should be converted to behavioural tests over time:

| File | Reads | Guards | Invariant | Status |
|------|-------|--------|-----------|--------|
| `run-attribution.test.ts` | `workflow-run.ts` | `goal.ownerTurns =` | Resume counter written alongside user hint | TODO: Convert |
| `coding-board.test.ts` | `workflow-run.ts` | `setCodingSessionCardStatus` calls (count = 3) | Workflow writes card status at 3 points | TODO: Convert |
| `coding-idle-poll.test.ts` | `workflow-run.ts` | Durable idle poll wiring | Idle polling uses step.sleep for durability | TODO: Convert |
| `coding-resume-note.test.ts` | `workflow-run.ts` | Multiple (resume-note step, lookbackMs, resumeNote assignments, appendTimeline) | Resume note flow is wired through workflow | TODO: Convert |
| `coding-resume.test.ts` | `workflow-run.ts` | `roundThroughInterruptions` call, sleep signature | Round retry and interruption handling | TODO: Convert |
| `coding-run-report.test.ts` | `workflow-run.ts` | `outcome: outcomeWord` assignment | Run outcome is derived from stop reason | TODO: Convert |
| `repo-sync-gate.test.ts` | `workflow-run.ts` | `step.do("repo-sync-gate"`, gate result reading | Sync gate blocks runs when repo is unconfirmed | TODO: Convert |
| `coding-turn-replay.test.ts` | `workflow-run.ts` | `withTurnReplay(` call | Every critical operation replays turns for recovery | TODO: Convert |
| `run-park-writers.test.ts` | `workflow-run.ts`, `lib/coding-interrupt.ts` | `recordLiveness` calls (count = 1) | Liveness is recorded exactly once per interruption | TODO: Convert |
| `autonomous-budget.test.ts` | Workflow class discovery | Workflow file list (includes `workflows/coding-session/index.ts`) | All autonomous workflows declare budgets | TODO: Convert |
| `coding-failure.test.ts` | `workflow-run.ts` | `logError` calls, probe reader | Failures are logged and timestamped | TODO: Convert |

## Roadmap

1. **Phase 1 (done):** Inventory and document the problem
2. **Phase 2 (in progress):** Convert simple guards (import existence, function availability)
3. **Phase 3 (future):** Convert medium guards (call counts, wiring presence)
4. **Phase 4 (future):** Convert complex guards (orchestration ordering, state flow)

---

**Rationale:** The goal is to make tests describe *what the code does*, not *what the code looks like*. This keeps tests useful through refactors, tool improvements, and code review automation.
