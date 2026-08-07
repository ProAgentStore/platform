// One delegation pool per pipeline RUN (#382) — which definitions need one, decided from the
// definition alone.
//
// `delegateToInstance` inherits the caller's pool and opens a new one only at the root, and says
// why at `delegate-instance.ts:71`: "Opening one per hop is the per-path copy that makes the tree
// total grow as fanout^depth." `RegistryToolCtx` carries `budgetId` for exactly that. `PipelineRunCtx`
// did not, so every `delegate_goal` issued from a pipeline step arrived with none and took the
// `??` branch — a FRESH ROOT POOL PER CALL. The #184 per-tree bound was inert on the one path that
// can delegate on a SCHEDULE: a 5-minute cron (`triggers.ts` floors it there) running a pipeline
// that delegates opens 288 pools a day, and a `forEach` over ten leads opens ten in one run. What
// was left bounding it is the account circuit breaker, which is a different control with a
// different threshold — meant to catch a runaway ACCOUNT, not to bound one delegation tree.
//
// ── Why the definition decides, rather than every run opening one
//
// `openBudget` is a percentile query plus an INSERT plus a read-back, and it leaves a row behind.
// Opening one for every pipeline run would put three D1 operations and a permanent unused row on
// the lead-finder's 5-minute sweep forever, to bound a delegation it will never make. The tools
// that can open a delegation tree are named IN the definition — a step dispatches exactly the tool
// it names — so "does this run need a pool" is answerable before the first step, for free, and
// deterministically (which the durable runner needs: the same answer on a resume).
//
// The failure mode of getting this set wrong is deliberately benign: a budget-opening tool that is
// missing from the set is handed no pool and falls back to `openBudget` — today's behaviour, not a
// crash. `pipeline-budget.test.ts` pins the call sites so a third one cannot arrive unnoticed.

/**
 * Registry tools that open a delegation tree when they run with no pool to inherit.
 *
 *   delegate_goal — `delegateToInstance` (`delegate-instance.ts`), the supervision connector's
 *                   hand-off to another instance's brain.
 *   start_work    — `tool-registry.ts`, the hand-off to the agent's OWN executor. From chat that
 *                   IS a root and opening a pool is right; from a pipeline step it is the same
 *                   per-call pool the issue is about, one verb over.
 *
 * A hardcoded set rather than a derived one because "opens a budget" is a property of a handler's
 * body, which no registry field states — deriving it would mean guessing from the connector, and
 * the `supervision` connector's other three tools open nothing.
 */
export const BUDGET_OPENING_TOOLS: ReadonlySet<string> = new Set(["delegate_goal", "start_work"]);

/** The only part of a pipeline definition this module reads. */
export interface ToolNamingSteps {
	steps: ReadonlyArray<{ tool: string }>;
}

/**
 * Does this definition contain a step that would open a delegation tree?
 *
 * True → the run opens ONE pool at kick and every step shares it, `forEach` iterations included.
 * False → no pool is opened at all, which is the honest answer for the overwhelming majority of
 * pipelines (source → transform → sink) and costs nothing.
 */
export function pipelineOpensDelegations(def: ToolNamingSteps): boolean {
	for (const step of def.steps ?? []) {
		if (typeof step?.tool === "string" && BUDGET_OPENING_TOOLS.has(step.tool)) return true;
	}
	return false;
}
