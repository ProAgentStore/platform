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

## The Pilot's run: tested by running it

The largest family of text guards read `workflows/coding-session/workflow-run.ts` (formerly
`coding-session.ts`) because "a Cloudflare Workflow cannot be constructed under vitest". That was
never true of the run itself: `runCodingSessionWorkflow` imports `cloudflare:workers` for TYPES only.
`workflows/coding-session/workflow-run.test.ts` runs it — the real function, over the real D1 schema
(`realSchemaD1`), with only its two edges faked: the machine (`runner-client`) and the BYOK brain
(`decideCodingAction`). Its fake `step` is a journal, and handing a journal back REPLAYS a run the
way Cloudflare does, so replay-sensitive invariants are testable too.

Each of its tests was checked by mutation: breaking the invariant in `workflow-run.ts` turns at
least one test red. Put a new Pilot invariant there, as a run.

## Inventory (#915)

Converted to behaviour, in `workflow-run.test.ts` — the source guards were removed from:

| Was in | Invariant now asserted by running the workflow |
|--------|-----------------------------------------------|
| `coding-board.test.ts` | The card is claimed `running` at the start, is `needs_human` during a handoff and `running` after it, gets the run's verdict at the end even when the run does not end the session, and the delegation card agrees (#553) |
| `run-attribution.test.ts` | An answered handoff reaches the next decision as `goal.ownerTurns`, and a report claiming an owner decision is stamped only when the owner never spoke (#505) |
| `coding-failure.test.ts` (#529, #546 arms) | A crash files an `ended` record naming the step it died in, its steps and start; a REPLAY re-measures the journalled pane and the driven instruction |
| `coding-resume.test.ts` | An interruption is resumed in the workflow: filed `resumed`, parked `platform_interrupt` with its retry instant, journalled once (a replay does not count it twice); teardown runs on every ending (#855) |
| `coding-resume-note.test.ts` | The predecessor's note reaches the FIRST decision only, in platform voice, and the timeline; a continue's lookback is honoured; the start-of-run tree count is passed, but not to a repair run (#523, #806) |
| `coding-run-report.test.ts` | An interrupted run's row and report both say `interrupted`, never the `failed` placeholder (#523) |
| `repo-sync-gate.test.ts` | An unconfirmed base stops the run before any decision, as a refusal (no crash record), on the timeline and the trace; a behind checkout is fast-forwarded and gated on the re-read; a repair run gets the brief and passes (#801, #802, #804) |
| `coding-idle-poll.test.ts` | Both idle-wait modes work, and later step names are identical whichever ran (#814) |
| `coding-turn-replay.test.ts` (Pilot door) | A turn sent to an engine with no memory carries the platform's record (#693) |
| `run-park-writers.test.ts` (call-site scan) | A capturing run clears its park while it works; an owner wait parks with reason and `until` (#580, #591) |
| `driver-failure.test.ts` (Pilot arm), `workflow-trace.test.ts` (lifecycle arm) | Resumed vs ended dispositions; `coding.run.start` and `coding.run.end` on the trace |

Made structure-aware rather than path-bound: `agent-workflows.test.ts` reads a workflow's file AND
its module directory, so a split — or the re-export stub #912 left behind — cannot hide its runner use.

Kept, deliberately — these are STRUCTURAL rules over a whole directory or the import graph, which the
standard allows: the driver registries in `driver-cancel.test.ts` / `driver-failure.test.ts` /
`workflow-trace.test.ts` (every file in `workflows/` is classified), `metering-callsites.test.ts`
(every caller in the tree), `autonomous-budget.test.ts` (import-graph reachability).

## Remaining text guards — convert them when you touch that code

158 test files still call `readFileSync` (measured at #915) — over console and admin components, prompts,
routes, migrations. Many are legitimate (reading a MIGRATION or a fixture is data, not spelling).
The ones that match a line of production code are to be converted **opportunistically**: when you
change the code a text guard reads, replace that guard with a behavioural test of the invariant
it names, in the same commit. Not in one sweep — each needs its invariant understood first, and a
bulk rewrite is how intent gets lost.

---

**Rationale:** The goal is to make tests describe *what the code does*, not *what the code looks like*. This keeps tests useful through refactors, tool improvements, and code review automation.
