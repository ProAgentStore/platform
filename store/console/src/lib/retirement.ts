/**
 * A retired agent, as the console reads it (#979).
 *
 * The shape is the server's: `GET /v1/instances/my/instances` attaches `retirement` to an instance
 * whose WORKFLOW the platform no longer runs, resolved from one table
 * (`workers/api/src/lib/agent-retirement.ts`) and passed through verbatim by MCP's `my_instances`.
 * So this file decides nothing about WHETHER something is retired — it only turns the server's
 * answer into what a person sees, which is why the console and MCP cannot drift apart.
 *
 * The distinction it exists to show: the subscription is still `active` and the instance is still
 * yours to read. What is permanently unavailable is the WORK.
 */

export interface RetirementRole {
	role: string;
	runtime: string;
	label: string;
	does: string;
	/** The owner's own instance for this role, when they have one. */
	instanceId?: string | null;
	instanceName?: string | null;
	consolePath?: string | null;
}

export interface InstanceRetirement {
	workflow: string;
	status: "retired";
	/** The two words every surface shows — the server's, not ours. */
	label: string;
	since: string;
	summary: string;
	/** What to do instead: the same sentence the start refusals return. */
	migration: string;
	/** What still works, so "disabled" is not read as "deleted". */
	preserved: string;
	replacement: { pipeline: string; roles: RetirementRole[] };
	replacements?: RetirementRole[];
	missingRoles?: string[];
}

/** The retirement on an instance record, or null. One reader, so no surface has to know the path. */
export const retirementOf = (instance?: { retirement?: InstanceRetirement | null } | null): InstanceRetirement | null => instance?.retirement ?? null;

/** The tooltip the badge carries: the verdict, the date, and the thing to use instead. */
export const retiredTitle = (r: InstanceRetirement): string => `${r.label} since ${r.since}. ${r.migration}`;

export interface ReplacementRoute {
	key: string;
	label: string;
	does: string;
	/** Where to go, when the owner HAS this part of the pipeline. */
	href: string | null;
	/** What to do when they do not — never an empty row, which reads as a broken link. */
	hint: string | null;
}

/**
 * The one-click route out of a dead agent (#979), per role of the replacement pipeline.
 *
 * `replacements` is the server's resolution against the owner's OWN instances; `replacement.roles`
 * is the static description. Falling back to the second means a response from an older server (or
 * one that could not resolve the roster) still explains what replaces this agent instead of
 * rendering an empty banner — the worst outcome here, because the banner is the only place the
 * owner learns their agent is dead.
 */
export function replacementRoutes(r: InstanceRetirement): ReplacementRoute[] {
	const roles = r.replacements?.length ? r.replacements : r.replacement.roles;
	return roles.map((role) => ({
		key: role.role,
		label: role.instanceName || role.label,
		does: role.does,
		href: role.consolePath ?? null,
		hint: role.consolePath ? null : `You have no ${role.label} yet — subscribe to one to ${role.does}.`,
	}));
}

/** Is this agent's work disabled? The one test a start control asks before it renders. */
export const isRetired = (instance?: { retirement?: InstanceRetirement | null } | null): boolean => !!retirementOf(instance);
