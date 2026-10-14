/**
 * A workflow the platform no longer runs, as DATA every surface reads (#979).
 *
 * ── What this is for
 *
 * A retirement is a fact about the WORKFLOW, not about the subscription. The instance stays `active`
 * — accessible, its history readable, its board showing what it did — while the work itself is
 * permanently unavailable. Modelling it here, on the resolved CAPABILITIES (`agent-capabilities.ts`),
 * is what lets every surface say so before anything is attempted: the console's badge and banner,
 * the Loop gate (`loop-drivers.ts`), and MCP's `my_instances`, all reading this one table.
 *
 * ── Membership
 *
 * EMPTY since #1062. `JOB_APPLY` was the first member (2026-10-08, #979), and it was a mistake:
 * "legacy" never meant retired. The cloud-brain JOB_APPLY workflow is a SUPPORTED browser-work path
 * alongside Scout → Tailor → Runner, so it is no longer a member and every surface that read this
 * table follows from that one change. The infrastructure stays for a real future retirement; its
 * tests run against a fixture member.
 *
 * PURE — no D1, no Env, no fetch. {@link replacementsFrom} takes the owner's instances as the
 * caller already has them.
 */

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
	/** ISO date it was retired. */
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

/**
 * The closed table. A member is added by a code review, with its own migration — there is no
 * free-text retirement, because this is the text an owner is shown instead of their agent working.
 */
export const RETIRED_WORKFLOWS: Readonly<Record<string, RetirementNotice>> = {};

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
