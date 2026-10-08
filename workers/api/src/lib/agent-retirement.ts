/**
 * A workflow the platform no longer runs, as DATA every surface reads (#979).
 *
 * ── What was wrong
 *
 * The legacy Job Application Assistant (`workflow: JOB_APPLY`) was retired on 2026-10-08: its
 * catalogue row was drafted (migration 0189) and every start path answers an actionable 410. But
 * the retirement existed only as a refusal — nothing a surface could READ. So an owner's existing
 * instance kept rendering as an ordinary `active` apply agent, with its tabs, its board and its
 * Loop button, and the only way to discover it was dead was to try to use it. Beside the live
 * Scout → Tailor → Runner pipeline, which is also an "apply agent", that is worse than untidy:
 * two things that look identical, one of which cannot work.
 *
 * ── The shape, and why it is here rather than in a column
 *
 * Retirement is a fact about the WORKFLOW, not about the subscription. The instance stays `active`
 * on purpose — it is accessible, its history is readable, its board still shows what it did — and
 * what is permanently unavailable is the work. Those are two different states and #979's first
 * requirement is that they stop being one: a status column could not express it without making
 * every reader of `status` learn a new value.
 *
 * So it rides on the resolved CAPABILITIES (`agent-capabilities.ts`), which is already the one
 * answer to "what is this agent" that the console renders surfaces from and MCP serves. One table,
 * one resolution, and the console and MCP cannot disagree because they read the same field of the
 * same response.
 *
 * PURE — no D1, no Env, no fetch. {@link replacementsFrom} takes the owner's instances as the
 * caller already has them.
 */

/** The owner-facing wording. Kept stable across HTTP, chat and MCP: it is the migration answer. */
export const LEGACY_JOB_APPLY_RETIRED_MESSAGE =
	"The legacy JOB_APPLY workflow no longer accepts new applications. Existing application tasks and history remain available. Use the Scout → Tailor → Runner pipeline: triage a job lead, generate application materials, then request review or start the Application Runner fill.";

/** One role of a replacement pipeline, named as the owner sees it in their own instance list. */
export interface ReplacementRole {
	/** Stable id for a reader that branches, e.g. the console's link list. */
	role: "scout" | "tailor" | "runner";
	/** The `capabilities.runtime` that IS this role — how the owner's own instance is recognised. */
	runtime: "local_browser" | "local_artifact" | "local_apply";
	label: string;
	/** What this part of the pipeline does, in one clause. */
	does: string;
}

export interface RetirementNotice {
	/** The retired workflow binding name. */
	workflow: string;
	/** One word for a badge. Deliberately not "inactive": the SUBSCRIPTION is still active. */
	status: "retired";
	/** The badge text itself, so every surface shows the same two words. */
	label: string;
	/** ISO date it was retired (migration 0189). */
	since: string;
	/** Why, in one sentence an owner reads on the banner. */
	summary: string;
	/** What to do instead — the same actionable sentence the 410 responses carry. */
	migration: string;
	/** What still works, so "disabled" is not read as "gone". */
	preserved: string;
	/** The pipeline that replaces it. */
	replacement: { pipeline: string; roles: readonly ReplacementRole[] };
}

const JOB_APPLY_REPLACEMENT: readonly ReplacementRole[] = [
	{ role: "scout", runtime: "local_browser", label: "Job Search Scout", does: "finds and triages job leads" },
	{ role: "tailor", runtime: "local_artifact", label: "Application Tailor", does: "writes the résumé and cover letter for one job" },
	{ role: "runner", runtime: "local_apply", label: "Application Runner", does: "fills the employer's form on your machine, and submits only what you approve" },
];

/**
 * The closed table. A member is added by a code review, with its own migration — there is no
 * free-text retirement, because this is the text an owner is shown instead of their agent working.
 */
export const RETIRED_WORKFLOWS: Readonly<Record<string, RetirementNotice>> = {
	JOB_APPLY: {
		workflow: "JOB_APPLY",
		status: "retired",
		label: "Retired — disabled",
		since: "2026-10-08",
		summary:
			"This agent's cloud-brain job-application workflow was retired. It is kept for its history: nothing it recorded has been deleted, and nothing it can be asked to do will run.",
		migration: LEGACY_JOB_APPLY_RETIRED_MESSAGE,
		preserved: "Its board, tasks, activity, trace, résumé and learned per-ATS tips stay readable. Chat still answers questions about them.",
		replacement: { pipeline: "Scout → Tailor → Runner", roles: JOB_APPLY_REPLACEMENT },
	},
};

/** The notice for a workflow, or undefined. The one place anything decides "is this retired". */
export function retirementFor(workflow: string | null | undefined): RetirementNotice | undefined {
	return workflow ? RETIRED_WORKFLOWS[workflow] : undefined;
}

/** One role of the replacement, resolved against the owner's OWN instances. */
export interface ResolvedReplacement extends ReplacementRole {
	/** The owner's instance for this role, or null when they do not have one yet. */
	instanceId: string | null;
	instanceName: string | null;
	/** Where it is in the console, for a one-click route out of the dead agent. */
	consolePath: string | null;
}

/** An instance as this module needs to see it: an id, a name, and what runtime it declares. */
export interface InstanceLike {
	id: string;
	name?: string | null;
	runtime?: string | null;
}

/**
 * Resolve the replacement pipeline against the owner's instances.
 *
 * Their OWN instances, by the runtime each role is defined by — never the catalogue, and never a
 * guess from a name. A role they have not subscribed to resolves to nulls rather than being
 * dropped: #979 asks for a route to the replacement, and "you do not have a Runner yet" is the
 * route when that is the truth. The FIRST match wins and the rest are ignored, because the link is
 * a starting point, not an inventory.
 */
export function replacementsFrom(notice: RetirementNotice, instances: readonly InstanceLike[]): ResolvedReplacement[] {
	return notice.replacement.roles.map((role) => {
		const match = instances.find((i) => i.runtime === role.runtime);
		return {
			...role,
			instanceId: match?.id ?? null,
			instanceName: match?.name ?? null,
			consolePath: match ? `/instances/${match.id}` : null,
		};
	});
}

/** The retirement as a response carries it: the notice plus where the owner's replacement is. */
export interface RetirementView extends RetirementNotice {
	replacements: ResolvedReplacement[];
	/** Roles the owner has no instance for — what a "set this up" prompt is built from. */
	missingRoles: ReplacementRole["role"][];
}

export function retirementView(notice: RetirementNotice, instances: readonly InstanceLike[]): RetirementView {
	const replacements = replacementsFrom(notice, instances);
	return { ...notice, replacements, missingRoles: replacements.filter((r) => !r.instanceId).map((r) => r.role) };
}
