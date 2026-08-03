// The supervision graph (#183) — who supervises whom, as data rather than as one agent's
// hardcoded structure.
//
// This module is PURE: the rules that decide whether a proposed edge is legal, with no D1 and no
// env. That matters because these rules are the safety boundary. Two levels of hierarchy written
// by a human in code are safe by inspection; N levels assembled by configuration are not, and the
// failure modes (a cycle, a tower, a fan-out) all cost real money in a loop. Every rule here is
// enforced at WIRING time, when the human is present — not at 3am when the chain runs.

/** A directed supervision edge. Both instances belong to the same owner (enforced in the store). */
export interface SupervisionEdge {
	supervisorInstanceId: string;
	subordinateInstanceId: string;
}

/** Caps. Deliberately conservative: a supervision tree that needs more than this is far more
 *  likely a misconfiguration than a real org chart, and the cost of being wrong compounds. */
export const MAX_DEPTH = 4;
export const MAX_SUBORDINATES = 12;

/** Adjacency: supervisor → subordinates. Built once per validation so the walks below are cheap. */
function adjacency(edges: readonly SupervisionEdge[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const e of edges) {
		const list = out.get(e.supervisorInstanceId);
		if (list) list.push(e.subordinateInstanceId);
		else out.set(e.supervisorInstanceId, [e.subordinateInstanceId]);
	}
	return out;
}

/** Everything reachable downward from `start`, following supervisor → subordinate. Iterative and
 *  visited-guarded so a graph that is ALREADY cyclic (bad historical data) cannot hang the walk. */
export function reachableFrom(edges: readonly SupervisionEdge[], start: string): Set<string> {
	const adj = adjacency(edges);
	const seen = new Set<string>();
	const stack = [...(adj.get(start) ?? [])];
	while (stack.length) {
		const node = stack.pop() as string;
		if (seen.has(node)) continue;
		seen.add(node);
		for (const next of adj.get(node) ?? []) if (!seen.has(next)) stack.push(next);
	}
	return seen;
}

/**
 * Would adding supervisor → subordinate close a loop?
 *
 * True when the proposed subordinate can already reach the supervisor, i.e. the supervisor is
 * downstream of its own would-be subordinate. A cycle is not a hypothetical: it is an unbounded
 * delegation loop that spends the user's money until something else stops it.
 */
export function wouldCreateCycle(
	edges: readonly SupervisionEdge[],
	supervisorInstanceId: string,
	subordinateInstanceId: string,
): boolean {
	if (supervisorInstanceId === subordinateInstanceId) return true;
	return reachableFrom(edges, subordinateInstanceId).has(supervisorInstanceId);
}

/** Longest downward chain starting at `start`, counting edges (a leaf is 0). Visited-guarded per
 *  path so an already-cyclic graph terminates instead of recursing forever. */
export function depthBelow(edges: readonly SupervisionEdge[], start: string): number {
	const adj = adjacency(edges);
	const walk = (node: string, onPath: Set<string>): number => {
		let best = 0;
		for (const next of adj.get(node) ?? []) {
			if (onPath.has(next)) continue; // defensive: pre-existing cycle
			onPath.add(next);
			best = Math.max(best, 1 + walk(next, onPath));
			onPath.delete(next);
		}
		return best;
	};
	return walk(start, new Set([start]));
}

/** Longest upward chain ending at `node` — how deep this node already sits under other
 *  supervisors. Needed because a new edge extends the tree in BOTH directions. */
export function depthAbove(edges: readonly SupervisionEdge[], node: string): number {
	const reversed = edges.map((e) => ({
		supervisorInstanceId: e.subordinateInstanceId,
		subordinateInstanceId: e.supervisorInstanceId,
	}));
	return depthBelow(reversed, node);
}

export type EdgeRejection =
	| "self"
	| "duplicate"
	| "cycle"
	| "too_deep"
	| "too_many_subordinates"
	| "multiple_supervisors";

export interface EdgeValidation {
	ok: boolean;
	reason?: EdgeRejection;
	/** Human-readable, safe to show in the console next to the wiring form. */
	message?: string;
}

/**
 * Is this edge legal to add?
 *
 * `edges` is the owner's CURRENT graph (their edges only — cross-tenant nodes can never appear,
 * which is what keeps this from leaking another user's topology).
 */
export function validateEdge(
	edges: readonly SupervisionEdge[],
	supervisorInstanceId: string,
	subordinateInstanceId: string,
): EdgeValidation {
	if (!supervisorInstanceId || !subordinateInstanceId) {
		return { ok: false, reason: "self", message: "Both a supervisor and a subordinate are required." };
	}
	if (supervisorInstanceId === subordinateInstanceId) {
		return { ok: false, reason: "self", message: "An agent cannot supervise itself." };
	}
	if (edges.some((e) => e.supervisorInstanceId === supervisorInstanceId && e.subordinateInstanceId === subordinateInstanceId)) {
		return { ok: false, reason: "duplicate", message: "That agent is already supervised by this one." };
	}
	// One supervisor per subordinate. Two managers for one worker makes "who is accountable for
	// this result" and "whose budget paid for it" unanswerable — and the escalation ladder (#157)
	// has no single parent to climb to.
	const existingParent = edges.find((e) => e.subordinateInstanceId === subordinateInstanceId);
	if (existingParent) {
		return {
			ok: false,
			reason: "multiple_supervisors",
			message: "That agent already reports to another supervisor. Remove the existing link first.",
		};
	}
	if (wouldCreateCycle(edges, supervisorInstanceId, subordinateInstanceId)) {
		return { ok: false, reason: "cycle", message: "That would create a supervision loop — the agents would delegate to each other forever." };
	}
	const fanout = edges.filter((e) => e.supervisorInstanceId === supervisorInstanceId).length;
	if (fanout >= MAX_SUBORDINATES) {
		return {
			ok: false,
			reason: "too_many_subordinates",
			message: `A supervisor can oversee at most ${MAX_SUBORDINATES} agents.`,
		};
	}
	// The new edge joins the chain ABOVE the supervisor to the chain BELOW the subordinate, so
	// the resulting height is both plus the edge itself.
	const height = depthAbove(edges, supervisorInstanceId) + 1 + depthBelow(edges, subordinateInstanceId);
	if (height > MAX_DEPTH) {
		return {
			ok: false,
			reason: "too_deep",
			message: `Supervision can be at most ${MAX_DEPTH} levels deep; that would make it ${height}.`,
		};
	}
	return { ok: true };
}

/** Direct subordinates of a supervisor, in insertion order. */
export function subordinatesOf(edges: readonly SupervisionEdge[], supervisorInstanceId: string): string[] {
	return edges.filter((e) => e.supervisorInstanceId === supervisorInstanceId).map((e) => e.subordinateInstanceId);
}

/** The single supervisor of an instance, or null at the root. Used to climb the escalation
 *  ladder (#157) and to attribute spend to the tree that started the work (#184). */
export function supervisorOf(edges: readonly SupervisionEdge[], subordinateInstanceId: string): string | null {
	return edges.find((e) => e.subordinateInstanceId === subordinateInstanceId)?.supervisorInstanceId ?? null;
}

/** Walk to the top of the tree — the node whose budget and trace the whole delegation belongs to.
 *  Guarded so bad data cannot spin. */
export function rootOf(edges: readonly SupervisionEdge[], instanceId: string): string {
	const seen = new Set<string>([instanceId]);
	let node = instanceId;
	for (;;) {
		const parent = supervisorOf(edges, node);
		if (!parent || seen.has(parent)) return node;
		seen.add(parent);
		node = parent;
	}
}
