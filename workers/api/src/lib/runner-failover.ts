// Assisted failover for a pinned agent whose machine is down (#1179).
//
// A pin is authoritative and fails CLOSED by design (`getBoundRunnerConn`): if no name of the pinned machine holds a live socket, the
// agent is unreachable rather than quietly run somewhere the owner did not choose. That stays. What was missing was any help getting out
// of it — the owner whose Mac mini died, with nine pinned agents and another machine idle, was told only that the pinned machine was
// offline. This names the machines that could take the agent and the one action that repins it.
//
// It SUGGESTS and never acts: nothing is repinned here, a pin changes only when the owner (or an agent on their behalf) calls
// `PUT /v1/instances/:id/runner-node`, and automatic failover is not offered — it would have to be an explicit per-agent opt-in.
// Pure over the rows the routing view already computed, so it costs no extra read and cannot disagree with that view.

export interface FailoverNodeFact {
	displayName: string | null;
	machineId: string | null;
	node: string;
	/** THIS agent holds a live socket on the machine. */
	connected: boolean;
	/** The machine is up for some agent of the owner's. */
	nodeOnline: boolean;
	/** An old registration under this name. Not a reason to hide the machine: it may be up under another name (#949), and `nodeOnline` already says so. */
	stale?: unknown;
}

export interface FailoverCandidate {
	displayName: string | null;
	machineId: string | null;
	node: string;
	/** This agent already has a socket there: a repin lands without a new attach. */
	attached: boolean;
	/** The value for `set_instance_runner_node`'s `runner_node` (and "Runs on"): the owner's name for it, else its id, else its hostname. */
	repinTo: string;
}

export interface FailoverSuggestion {
	pinned: string;
	candidates: FailoverCandidate[];
	/** One sentence naming the situation and the action; says plainly that nothing was changed. */
	message: string;
}

export function failoverSuggestion(input: { pinned: string | null | undefined; pinnedMachineId?: string | null; nodes: readonly FailoverNodeFact[]; resolvedNode?: string | null }): FailoverSuggestion | null {
	const pinned = (input.pinned ?? "").trim();
	if (!pinned) return null; // automatic: routing already follows whichever machine is live
	const own = input.nodes.find((n) => n.node === pinned);
	if (own?.connected || input.resolvedNode) return null; // the pinned machine answers (under this name or another)
	const candidates = input.nodes
		.filter((n) => n.node !== pinned && (n.connected || n.nodeOnline) && !(input.pinnedMachineId && n.machineId === input.pinnedMachineId))
		.sort((a, b) => Number(b.connected) - Number(a.connected))
		.map((n): FailoverCandidate => ({ displayName: n.displayName, machineId: n.machineId, node: n.node, attached: n.connected, repinTo: n.displayName || n.machineId || n.node }));
	const down = `This agent is pinned to ${pinned}, which isn't connected, so it is not running.`;
	if (!candidates.length) {
		return { pinned, candidates, message: `${down} No other machine of yours is online to take it — start the runner on ${pinned} (\`pags up\`), or bring another machine up and repin then.` };
	}
	const first = candidates[0];
	const label = first.displayName || first.node;
	return {
		pinned,
		candidates,
		message:
			`${down} ${label} is online${first.attached ? " and already attached to this agent" : ""}: repin it with set_instance_runner_node (runner_node "${first.repinTo}") or "Runs on" in the console` +
			`${candidates.length > 1 ? `; ${candidates.length - 1} other machine${candidates.length > 2 ? "s are" : " is"} listed in candidates` : ""}. Nothing was repinned — a pin changes only when you change it, so the agent stays stopped until then.`,
	};
}

/** The response field: `{ failover }` when there is a suggestion, nothing otherwise — an agent that is fine gains no key. */
export function failoverField(input: Parameters<typeof failoverSuggestion>[0]): { failover?: FailoverSuggestion } {
	const f = failoverSuggestion(input);
	return f ? { failover: f } : {};
}
