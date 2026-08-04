// Where an autonomous run's "I need a human" goes (#157).
//
// The point of a hierarchy is to ABSORB interrupts. Without a ladder it does the opposite: three
// Repo Coders under one Lead means three separate pings to the same person, each lacking the
// context that the Lead has. Multi-layer supervision would make an owner's phone worse, not
// better, which is precisely backwards.
//
// So an escalation climbs: the subordinate's supervisor is told first, and the human is reached
// only at the root of the tree or once the hops are spent. Deliberately NOT auto-acting — the
// supervisor is informed (a board card it can see, and a note in its thread), it does not
// silently start spending to resolve something. Auto-resolution is a bigger decision than
// interrupt routing and belongs behind its own gate.

import { rootOf, supervisorOf, type SupervisionEdge } from "./supervision-graph.js";

/** How many times an escalation may climb before it must reach the human. */
export const MAX_ESCALATION_HOPS = 3;

export type EscalationTarget =
	/** Tell this supervisor instance; the human is not interrupted yet. */
	| { kind: "supervisor"; instanceId: string; hops: number }
	/** No one above, or the hops are spent — the human is the right answer now. */
	| { kind: "human"; reason: "root" | "hops_exhausted" };

/**
 * Who should hear that `instanceId` is stuck?
 *
 * Pure so the routing rule is testable without D1: given the owner's graph, walk up one level.
 * `hopsUsed` is how many times this escalation has already climbed, so a chain cannot ping its
 * way up forever — at the cap the human is told, with the reason recorded.
 */
export function escalationTarget(
	edges: readonly SupervisionEdge[],
	instanceId: string,
	hopsUsed = 0,
): EscalationTarget {
	if (hopsUsed >= MAX_ESCALATION_HOPS) return { kind: "human", reason: "hops_exhausted" };
	const supervisor = supervisorOf(edges, instanceId);
	// A node with no supervisor IS the root; there is nobody left to absorb this.
	if (!supervisor) return { kind: "human", reason: "root" };
	return { kind: "supervisor", instanceId: supervisor, hops: hopsUsed + 1 };
}

/** The tree this instance belongs to — used to attribute an escalation to the whole run. */
export function escalationRoot(edges: readonly SupervisionEdge[], instanceId: string): string {
	return rootOf(edges, instanceId);
}

/**
 * The message a supervisor receives. Written for the SUPERVISOR's brain to act on, not for a
 * human to read: it names the subordinate and what it needs, because a supervisor that only
 * learns "something failed" cannot do anything useful with that.
 */
export function escalationNote(opts: {
	subordinateName: string;
	objective: string;
	reason: string;
	detail: string;
}): string {
	const detail = opts.detail?.trim() ? ` — ${opts.detail.trim()}` : "";
	return [
		`${opts.subordinateName} stopped and needs a decision (${opts.reason})${detail}.`,
		`Its objective was: ${opts.objective}`,
		`You can check it with check_delegation, give it a new goal with delegate_goal, or tell the owner if this needs them.`,
	].join("\n");
}
