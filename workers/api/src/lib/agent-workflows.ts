/**
 * The workflow vocabulary — the autonomous brains a creator may declare (#375).
 *
 * `capabilities.workflow` is a CLOSED enum whose members are `[[workflows]]` bindings in
 * `workers/api/wrangler.toml`: a value means something only because a route calls
 * `env.<BINDING>.create(…)`. That fact was restated in four hand-kept places — the type union,
 * the sanitizer's Set, the MCP zod enum and an `<option>` list in the console — and they drifted
 * in BOTH directions at once. Every list carried `INSURANCE_QUOTES`, which has no binding, no
 * `Env` field and no `.create()` call anywhere (picking it changed a lint and no behaviour),
 * while the console's list omitted `BROWSER_TASK` — the one value the platform actually
 * ENFORCES, since `trigger-capability.ts` refuses `run_browse` without it. So the creator's
 * picker offered a brain that is bound to nothing and hid the only one a creator must declare.
 *
 * This table is the single source. The type union is DERIVED from it, the sanitizer asks it, and
 * the creator's picker is SERVED from it (`GET /v1/agents/:id/capabilities` → `workflowOptions`)
 * instead of restating it in JSX — a picker and an enforcer kept as two lists is the bug itself,
 * so fixing it by editing the second list would only reset the clock.
 *
 * NOT every bound workflow belongs here. `PIPELINE_RUN` and `AGENT_LOOP` are platform-driven —
 * the pipeline runner and the generic loop start them whatever an agent declares — so they are
 * not brains a creator selects. `agent-workflows.test.ts` asserts the other direction, that
 * everything here IS bound, which is the check that would have caught `INSURANCE_QUOTES`.
 */

/** One selectable brain. `value` is the wrangler `[[workflows]]` binding name, verbatim. */
export interface WorkflowSpec {
	value: string;
	/** What it does, for the creator choosing it — this is product copy, the picker shows it. */
	description: string;
	/**
	 * The `capabilities.runtime` this brain's hands need, or `null` for one that runs entirely
	 * in the cloud.
	 *
	 * REQUIRED, and that is the guard: a fourth workflow cannot be added without stating whether
	 * it needs a physical executor. Declaring one that does alongside `runtime: null` is
	 * accepted-and-broken in a way nothing downstream can report — `pags up` filters an instance
	 * whose agent declares `runtime: null` out of the list it registers, so no runner can ever
	 * exist for it, and `triggers.ts` treats the resulting 503 as a transient skip (rightly, for
	 * the laptop-is-closed case it was written for). The owner is told to run `pags up` forever
	 * and the failure count stays at 0 (#705).
	 *
	 * This is deliberately NOT read in the other direction. `runtime: "coding"` with
	 * `workflow: null` is legitimate and shipped — the tmux Operator and `tmux-coder` both drive
	 * a CLI through registry tools with no Pilot — so inferring a runtime from a workflow would
	 * silently grant one nobody declared.
	 */
	requiresRuntime: WorkflowRuntimeRequirement;
}

/**
 * The runtime vocabulary a workflow may require.
 *
 * Stated here rather than imported from `agent-capabilities.ts` because this module is the leaf
 * of the graph and that one already imports it; `workflowRuntimeVocabulary` in
 * `agent-workflows.test.ts` asserts the two lists are the same set, so the duplication cannot
 * drift the way #375's four hand-kept copies of the workflow enum did.
 */
export type WorkflowRuntimeRequirement = "browser" | "coding" | null;

export const AGENT_WORKFLOWS = [
	{
		value: "JOB_APPLY",
		description:
			"Fills in and submits one job application in your own signed-in browser, pausing for a captcha or for a value it was never given.",
		requiresRuntime: "browser",
	},
	{
		value: "CODING_SESSION",
		description: "Drives a coding CLI on your machine toward an objective — the Coder's Pilot.",
		requiresRuntime: "coding",
	},
	{
		value: "BROWSER_TASK",
		description:
			"Drives your own signed-in browser toward an objective on any site. Required for the run_browse trigger action: a scheduled browser run is refused without it.",
		requiresRuntime: "browser",
	},
] as const satisfies readonly WorkflowSpec[];

/** The declarable workflow values — derived, so the type can never outlive the table. */
export type AgentWorkflow = (typeof AGENT_WORKFLOWS)[number]["value"];

/** Is this a workflow the platform actually runs? The one membership test, used by both the
 *  write-side sanitizer and the read-side resolver in agent-capabilities.ts. */
export function isAgentWorkflow(value: unknown): value is AgentWorkflow {
	return typeof value === "string" && AGENT_WORKFLOWS.some((w) => w.value === value);
}

/** What runtime a stored workflow value needs — `null` both for "needs none" and for a value
 *  this platform does not run, since neither can require a runner. */
export function workflowRequiredRuntime(value: unknown): WorkflowRuntimeRequirement {
	const spec = AGENT_WORKFLOWS.find((w) => w.value === value);
	return spec ? spec.requiresRuntime : null;
}

/**
 * Why this `{workflow, runtime}` pair may not be declared — or `null` if it may.
 *
 * The one check that makes two individually-correct decisions consistent (#705). `pags up` filters
 * out every instance whose agent declares `runtime: null` (correct: #58's cloud-only agents must
 * not have `pags up` claim to serve them), and `triggers.ts` records a runner-offline 503 as a
 * transient skip rather than a failure (correct: #358, so a closed laptop does not burn its
 * owner's failure budget and auto-disable their cron). Compose them under a workflow that needs
 * hands and the result is a permanently unsatisfiable instruction to "run `pags up`", repeated on
 * every fire, with a clean failure count and nothing anywhere that can say why.
 *
 * Refused at DECLARATION time, where the mismatch is a static fact. At fire time it is
 * indistinguishable from a closed lid, which is why counting the 503 as a failure was rejected.
 *
 * Pure, and takes `unknown` because both arguments arrive from a request body. A value that is
 * not a workflow this platform runs returns `null`: the sanitizer drops it to `null` anyway, and
 * refusing the write instead would mean a creator could not clear a stale value by saving.
 */
export function workflowRuntimeDenial(workflow: unknown, runtime: unknown): string | null {
	if (!isAgentWorkflow(workflow)) return null;
	const required = workflowRequiredRuntime(workflow);
	if (required === null || runtime === required) return null;
	const hands = required === "browser" ? "the subscriber's own signed-in browser" : "a coding CLI on the subscriber's own machine";
	const has = runtime == null ? "capabilities.runtime is null" : `capabilities.runtime is "${String(runtime)}"`;
	return `capabilities.workflow "${workflow}" drives ${hands}, so it requires capabilities.runtime "${required}" — but ${has}. No runner can ever be registered for that combination (\`pags up\` skips an agent that declares no runtime), so every scheduled run would be recorded as a transient "runner offline" forever. Declare capabilities.runtime "${required}", or clear capabilities.workflow.`;
}

/** One row of the creator's Workflow picker. */
export interface WorkflowChoice {
	value: string;
	label: string;
	description: string;
	/** True for a stored value this platform runs nothing for — shown so it can be seen, not hidden. */
	unavailable?: boolean;
}

const NO_WORKFLOW: WorkflowChoice = {
	value: "",
	label: "none",
	description: "No autonomous brain. The agent still chats and runs its tools; nothing drives it on its own.",
};

/**
 * The picker rows for an agent whose stored value is `current`.
 *
 * A stored value that is no longer declarable comes back FLAGGED rather than dropped. A
 * `<select>` whose value matches no option renders as its first option, so omitting it would show
 * "none" over a config that still says otherwise and then clear it on the next Save without
 * anyone choosing that. Same rule `triggerActionOffers` states for unavailable actions: a picker
 * that quietly has fewer entries teaches nothing, and the user's question is why.
 */
export function workflowChoices(current?: unknown): WorkflowChoice[] {
	const rows: WorkflowChoice[] = [
		NO_WORKFLOW,
		...AGENT_WORKFLOWS.map((w) => ({ value: w.value, label: w.value, description: w.description })),
	];
	if (typeof current === "string" && current && !isAgentWorkflow(current)) {
		rows.push({
			value: current,
			label: `${current} (not available)`,
			description: "This platform runs no workflow by that name, so nothing drives this agent. Saving clears it.",
			unavailable: true,
		});
	}
	return rows;
}
