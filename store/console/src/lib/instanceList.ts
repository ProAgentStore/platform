// Which instances the Instances tab shows, and in what order (#815).
//
// The tab had one control — the #795 search box. This adds the two that need no live data: a
// sort, and a filter by agent. Status (working / waiting / stalled / idle) and queue depth come
// from a poll that does not exist yet, and land here when it does.
//
// Pure for the reason `instanceSearch.ts` gives: the console has no component harness, so the
// decision is tested as a value and the wiring is source-guarded (`Dashboard.instances.test.ts`).
// Matching stays in `instanceSearch.ts`; this module composes it and never re-implements it.

import { activityFor, lastActiveAt, statusRank, type InstanceActivity, type InstanceHealth } from "./instanceActivity";
import { filterInstances } from "./instanceSearch";
import type { Instance } from "./types";

/**
 * The sorts on offer.
 *
 *   recent  when the instance was last REALLY active — `max(last_activity_at, the run's heartbeat,
 *           the run's start)`. It was labelled "Recently used" while this list could only see the
 *           first term, because `last_activity_at` moves on OWNER-driven events alone and a Pilot
 *           working unattended for two hours does not move it. #815 slice 4 wired the other two
 *           terms, so the label is now "Last active" and the claim is true.
 *   name    by the card's title.
 *   status  whatever needs the owner first: stalled, waiting, working, idle (`statusRank`).
 */
export const INSTANCE_SORTS = ["recent", "name", "status"] as const;
export type InstanceSort = (typeof INSTANCE_SORTS)[number];

export const INSTANCE_SORT_LABEL: Record<InstanceSort, string> = {
	recent: "Last active",
	name: "Name A–Z",
	status: "Status",
};

const SORT_KEY = "console:instanceSort";

/** A stored or typed value, validated — a stale key from an older build must not select nothing. */
export function parseSort(raw: unknown): InstanceSort {
	return (INSTANCE_SORTS as readonly unknown[]).includes(raw) ? (raw as InstanceSort) : "recent";
}

/**
 * The sort is persisted; the filters are not, and the difference is deliberate. A sort is a
 * preference and hides nothing. A filter that survived a reload is a list silently missing rows
 * (the rule `Dashboard.tsx` already states for the search box).
 */
export function rememberedSort(): InstanceSort {
	try {
		return parseSort(localStorage.getItem(SORT_KEY));
	} catch {
		/* storage disabled (private mode) — the default order */
		return "recent";
	}
}

export function rememberSort(sort: InstanceSort): void {
	try {
		localStorage.setItem(SORT_KEY, sort);
	} catch {
		/* storage disabled (private mode) — the choice lasts for this page only */
	}
}

/** What the instance IS, renamed or not: `agentName` exists only when `name` is a display name. */
export function agentLabel(inst: Pick<Instance, "name" | "agentName">): string {
	return inst.agentName || inst.name || "";
}

export interface AgentOption {
	agentId: string;
	label: string;
	/** How many of the user's instances run this agent. */
	count: number;
}

/**
 * The agents actually present in the list, for the agent filter — A–Z, one per `agent_id`.
 *
 * Built from the rows rather than fetched, so the filter can never offer an agent that would
 * match nothing. The caller renders the control only when this has more than one entry.
 */
export function agentOptions(instances: Instance[]): AgentOption[] {
	const byId = new Map<string, AgentOption>();
	for (const inst of instances) {
		const seen = byId.get(inst.agent_id);
		if (seen) seen.count++;
		else byId.set(inst.agent_id, { agentId: inst.agent_id, label: agentLabel(inst), count: 1 });
	}
	return [...byId.values()].sort((a, b) => compareText(a.label, b.label) || compareText(a.agentId, b.agentId));
}

/** Case- and accent-insensitive, and numeric so "Coder 10" sorts after "Coder 9". */
function compareText(a: string, b: string): number {
	return (a || "").localeCompare(b || "", undefined, { sensitivity: "base", numeric: true });
}

export interface InstanceListView {
	query: string;
	sort: InstanceSort;
	/** An `agent_id`, or "" for every agent. */
	agentId: string;
	/** One of the four states, or "" for every status. */
	health?: InstanceHealth | "";
	/** What the activity poll last said. Empty before the first response — see `activityFor`. */
	activity?: Map<string, InstanceActivity>;
}

/**
 * The instances to render.
 *
 * With nothing narrowing and the default sort this returns the SAME array — the identity
 * `filterInstances` is careful to preserve. Sorting copies; the input is never mutated, because
 * it is React state and "recent" has to be able to get the server's order back.
 */
export function listInstances(instances: Instance[], view: InstanceListView): Instance[] {
	const activity = view.activity ?? new Map<string, InstanceActivity>();
	let out = filterInstances(instances, view.query);
	if (view.agentId) out = out.filter((inst) => inst.agent_id === view.agentId);
	// Before the first poll every instance reads idle, so filtering on any other status would show
	// an empty list and blame the filter. The caller renders the control only once `asOf` is set.
	if (view.health) out = out.filter((inst) => activityFor(activity, inst.id).health === view.health);
	// The id tie-break keeps two same-named siblings from swapping places between renders.
	if (view.sort === "name") out = [...out].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
	if (view.sort === "status") {
		out = [...out].sort(
			(a, b) =>
				statusRank(activityFor(activity, a.id).health) - statusRank(activityFor(activity, b.id).health) ||
				compareText(a.name, b.name) ||
				compareText(a.id, b.id),
		);
	}
	// `recent` is the server's order until the poll lands. Once it has, the list re-sorts on the
	// CORRECTED definition — which is what licenses the "Last active" label.
	if (view.sort === "recent" && activity.size) {
		out = [...out].sort(
			(a, b) =>
				lastActiveAt(b, activityFor(activity, b.id)) - lastActiveAt(a, activityFor(activity, a.id)) ||
				compareText(a.name, b.name) ||
				compareText(a.id, b.id),
		);
	}
	return out;
}
