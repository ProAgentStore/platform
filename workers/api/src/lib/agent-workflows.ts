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
}

export const AGENT_WORKFLOWS = [
	{
		value: "JOB_APPLY",
		description:
			"Fills in and submits one job application in your own signed-in browser, pausing for a captcha or for a value it was never given.",
	},
	{
		value: "CODING_SESSION",
		description: "Drives a coding CLI on your machine toward an objective — the Coder's Pilot.",
	},
	{
		value: "BROWSER_TASK",
		description:
			"Drives your own signed-in browser toward an objective on any site. Required for the run_browse trigger action: a scheduled browser run is refused without it.",
	},
] as const satisfies readonly WorkflowSpec[];

/** The declarable workflow values — derived, so the type can never outlive the table. */
export type AgentWorkflow = (typeof AGENT_WORKFLOWS)[number]["value"];

/** Is this a workflow the platform actually runs? The one membership test, used by both the
 *  write-side sanitizer and the read-side resolver in agent-capabilities.ts. */
export function isAgentWorkflow(value: unknown): value is AgentWorkflow {
	return typeof value === "string" && AGENT_WORKFLOWS.some((w) => w.value === value);
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
