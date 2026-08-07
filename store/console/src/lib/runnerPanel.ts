// What the Runner card SAYS about the machines an agent can run on.
//
// The card reads two endpoints that answer overlapping questions from different places:
//
//   /v1/terminals/nodes      — the user's machines, ACROSS every agent. Machine-level `connected`,
//                              plus a per-instance `connected` for the agents it serves. It drops
//                              a node that serves no runner-using agent and holds no session.
//   /v1/instances/:id/runner-node — THIS agent's view: `connected` (this agent's own relay socket
//                              on that node) and `nodeOnline` (the machine is up for ANY agent).
//                              It always includes the pinned node, even one this agent has never
//                              registered on.
//
// Three sentences were then derived from them, each next to where it rendered: the status line at
// the top of the card, the tile per machine, and the warning under the grid. The tile read only
// the first endpoint, the other two only the second — and where the endpoints' inclusion rules
// differ, the card contradicted itself on screen. A pinned machine missing from the Terminals list
// was synthesised as `{connected:false}` — a flat assertion, not an observation — so the grid
// showed a grey **Offline** tile directly above "⚠ <node> is online, but this agent isn't attached
// to it yet", and above a status line that could already read **Online**.
//
// That is the same defect #305 found in the Coding tab: a green "Ready" under "your machine isn't
// connected". A reader cannot arbitrate between two statements a page makes about one fact, so the
// page must not make two.
//
// Everything here is pure, and the tile is derived from BOTH readings, so a disagreement is a test
// failure rather than a screenshot.

/** One entry of `nodesDetail` from `GET /v1/instances/:id/runner-node`. */
export interface NodeDetail {
	node: string;
	/** THIS agent's own relay socket on that machine. */
	connected: boolean;
	/** The machine runs a runner for ANY of your agents. Absent on older responses. */
	nodeOnline?: boolean;
}

/** One of the user's machines, from `GET /v1/terminals/nodes`. */
export interface Machine {
	node: string;
	placement?: string;
	runnerVersion?: string;
	lastSeenAt?: string | null;
	connected: boolean;
	instances?: Array<{ instanceId: string; connected: boolean; bound?: boolean }>;
}

/**
 * Compact relative time for a machine's last-seen.
 *
 * Bands FLOOR rather than round. Rounding put 59.5 minutes in the minutes band as "60m ago" and
 * 23.99 hours in the hours band as "24h ago" — a unit the band above exists to express, printed by
 * the band below it. Same reason 90 seconds is "1m ago" and not "2m ago": the number is a floor of
 * elapsed time, so rounding it up says more time has passed than has.
 */
export function agoShort(iso?: string | null): string {
	if (!iso) return "never";
	// D1 writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker; `Date.parse` would read that as
	// local time and report a machine seen seconds ago as hours stale.
	const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
	// Not "": an unparseable stamp used to render the tile's meta line as "local · v0.1 · seen "
	// with nothing after it, which reads as a truncated page rather than a missing value.
	if (Number.isNaN(t)) return "unknown";
	const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The machines to render as "Runs on" tiles: all your `pags up` nodes, plus the pinned one if it
 * is not among them — so you always see what this agent is bound to.
 *
 * The synthesised entry is seeded from `nodesDetail`, which is the endpoint that knows about that
 * exact node. Asserting `connected:false` instead was the contradiction: `/runner-node` reports the
 * pinned node's liveness whether or not Terminals lists it, and the card already prints THAT answer
 * in the warning below the grid.
 */
export function machinesToShow(
	machines: readonly Machine[],
	runnerNode: string,
	instanceId: string,
	detail: readonly NodeDetail[] = [],
): Machine[] {
	if (!runnerNode || machines.some((m) => m.node === runnerNode)) return [...machines];
	const d = detail.find((x) => x.node === runnerNode);
	return [
		{
			node: runnerNode,
			connected: d?.connected === true || d?.nodeOnline === true,
			instances: d?.connected ? [{ instanceId, connected: true }] : [],
		},
		...machines,
	];
}

export type TileTone = "attached" | "online" | "offline";

export interface MachineTile {
	node: string;
	tone: TileTone;
	statusText: string;
	pinned: boolean;
	/** "local · v0.3.3 · seen 4m ago" */
	meta: string;
}

/** One machine tile: the dot's tone, the phrase under it, and whether this agent is pinned there. */
export function machineTile(m: Machine, instanceId: string, runnerNode: string): MachineTile {
	const attached = (m.instances || []).some((i) => i.instanceId === instanceId && i.connected);
	const tone: TileTone = attached ? "attached" : m.connected ? "online" : "offline";
	return {
		node: m.node,
		tone,
		statusText: attached ? "Attached · online" : m.connected ? "Online · agent not attached" : "Offline",
		pinned: runnerNode === m.node,
		meta: `${m.placement === "managed" ? "cloud" : "local"}${m.runnerVersion ? ` · v${m.runnerVersion}` : ""} · seen ${agoShort(m.lastSeenAt)}`,
	};
}

/**
 * Why the pinned machine is not serving this agent — or null when nothing is wrong.
 *
 *   renamed      — the pin names a hostname the machine has stopped using, and the SAME machine
 *                  is here under a new one, so routing already resolves through it (#379). Nothing
 *                  is broken; saying "offline" here would be a warning about a state the user is
 *                  not in, over an agent that is working.
 *   not_attached — the machine is up for other agents but never opened this agent's socket.
 *                  `pags up` is the WRONG advice here, which is exactly the confusing case.
 *   offline      — nothing is running there at all.
 *
 * `resolvedNode` comes from `/runner-node`, which is the only side that can prove two names are
 * one machine — it holds the persisted machine id. The card must not try to infer it from names.
 */
export function pinnedWarning(
	runnerNode: string,
	detail: readonly NodeDetail[],
	resolvedNode?: string | null,
): "renamed" | "not_attached" | "offline" | null {
	if (!runnerNode) return null;
	const d = detail.find((x) => x.node === runnerNode);
	if (!d || d.connected) return null;
	if (resolvedNode && resolvedNode !== runnerNode) return "renamed";
	return d.nodeOnline === true ? "not_attached" : "offline";
}

export interface RunnerReading {
	/** Is THIS agent's runner live? */
	online: boolean;
	/** The machine it is (or would be) running on. */
	node: string;
	/** The pinned machine is up for some agent, even if not this one. */
	pinnedNodeOnline: boolean;
}

/**
 * The status line at the top of the card.
 *
 * `/runtime/status` carries the answer at `relay.connected`, and the machine name at
 * `relay.runnerNode` — there is no top-level `connected`, and reading the top-level keys made the
 * panel say "Offline" permanently. The pinned node's own `connected` is the same RelayDO truth and
 * stands in until the probe lands, so the line does not open on a false negative.
 */
export function runnerReading(
	runtimeInfo: Record<string, unknown> | null,
	detail: readonly NodeDetail[],
	runnerNode: string,
): RunnerReading {
	const relay = (runtimeInfo as { relay?: { connected?: boolean; runnerNode?: string | null } } | null)?.relay;
	const pinned = detail.find((d) => d.node === runnerNode);
	return {
		online: relay?.connected === true || pinned?.connected === true,
		node: relay?.runnerNode || runnerNode || "",
		pinnedNodeOnline: pinned?.nodeOnline === true,
	};
}
