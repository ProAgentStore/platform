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
// Everything here is pure, and EVERY tile is derived from BOTH readings, so a disagreement is a
// test failure rather than a screenshot. That promise used to be written here while only the
// SYNTHESISED tile kept it — `machinesToShow` returned the Terminals list untouched whenever the
// pinned node was already on it, so every other tile was a single reading again (#531).
//
// ── Connectivity is not routing (#531)
//
// The two words this file has to keep apart:
//
//   CONNECTED  — this agent has a live relay socket on that machine. A fact about a WebSocket.
//   ATTACHED   — this agent's runner calls actually go there. A fact about ROUTING, decided by
//                `getBoundRunnerConn`: a pin is authoritative and never falls through, so with the
//                agent pinned to A and a live socket on B, B is connected and NOTHING runs on it.
//
// The tile asserted the second from the first (`instances[].connected`, itself a bare pin-blind
// `relayConnected`), so B's tile read "Attached · online" in green one line under a correctly
// pin-aware "Status: Offline". Both feeds are still pin-blind — `/v1/terminals/nodes` and
// `/v1/instances/:id/runner-node` each report a socket probe — so the pin has to be applied HERE,
// where the sentence is chosen, and the pin is already on hand: `machineTile` receives it.
//
// A pin names a HOSTNAME and a hostname moves under a machine (#379/#393), so "the pin excludes
// this tile" is never a string compare against the current name alone: an `aka` match, or the
// server's own `resolvedNode`, means the pin names THIS machine under a name it has retired, and
// the tile stays attached because the routing does too.

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
	/** Names this machine has also answered to, freshest first (#393). */
	aka?: string[];
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
 * Fold `/runner-node`'s reading of ONE machine into the Terminals row for it.
 *
 * Both endpoints answer "does this agent hold a socket there" with the same probe at different
 * moments, so a disagreement is a race, not a contradiction, and the merge is a union: a machine
 * seen live by either read is live. That is already the rule the synthesised tile used — this only
 * stops it being the rule for one tile out of N.
 *
 * Matched on the current name first, then on the machine's retired ones: `/runner-node` reports the
 * folded name AND, separately, the pinned name, which may be an `aka` of this same machine (#393).
 */
function mergeDetail(m: Machine, instanceId: string, detail: readonly NodeDetail[]): Machine {
	const d = detail.find((x) => x.node === m.node) ?? detail.find((x) => (m.aka || []).includes(x.node));
	if (!d) return m;
	const instances = [...(m.instances || [])];
	const at = instances.findIndex((i) => i.instanceId === instanceId);
	const socket = (at >= 0 && instances[at].connected) || d.connected === true;
	if (at >= 0) instances[at] = { ...instances[at], connected: socket };
	else if (socket) instances.push({ instanceId, connected: true });
	return { ...m, connected: m.connected || d.connected === true || d.nodeOnline === true, instances };
}

/**
 * The machines to render as "Runs on" tiles: all your `pags up` nodes, plus the pinned one if it
 * is not among them — so you always see what this agent is bound to.
 *
 * The synthesised entry is seeded from `nodesDetail`, which is the endpoint that knows about that
 * exact node. Asserting `connected:false` instead was the contradiction: `/runner-node` reports the
 * pinned node's liveness whether or not Terminals lists it, and the card already prints THAT answer
 * in the warning below the grid.
 *
 * "Not among them" is answered under EVERY name the machine has used (#531). Testing the current
 * name alone synthesised a second tile for a pin left on a retired hostname, so a renamed laptop
 * drew twice — one grey "Offline · Pinned" beside one green "Attached · Pinned", both about the
 * same machine, which is the disagreement this module exists to make impossible.
 */
export function machinesToShow(
	machines: readonly Machine[],
	runnerNode: string,
	instanceId: string,
	detail: readonly NodeDetail[] = [],
): Machine[] {
	const merged = machines.map((m) => mergeDetail(m, instanceId, detail));
	if (!runnerNode || machines.some((m) => m.node === runnerNode || (m.aka || []).includes(runnerNode))) return merged;
	const d = detail.find((x) => x.node === runnerNode);
	return [
		{
			node: runnerNode,
			connected: d?.connected === true || d?.nodeOnline === true,
			instances: d?.connected ? [{ instanceId, connected: true }] : [],
		},
		...merged,
	];
}

/**
 * What a tile says, in four states — two of which are "the machine is up".
 *
 *   attached  — this agent's socket is here AND the pin routes here. Work runs on this machine.
 *   connected — this agent's socket is here and the pin sends its work somewhere else. The
 *               machine is genuinely up for this agent; nothing of this agent's runs on it.
 *   online    — the machine is up for OTHER agents; this one never opened a socket on it.
 *   offline   — nothing is running there at all.
 */
export type TileTone = "attached" | "connected" | "online" | "offline";

export interface MachineTile {
	node: string;
	tone: TileTone;
	statusText: string;
	pinned: boolean;
	/** "local · v0.3.3 · seen 4m ago" */
	meta: string;
	/** "also RLs-MacBook-Air.local", or "" when this machine has only ever had one name. */
	alsoKnownAs: string;
}

/**
 * One machine tile: the dot's tone, the phrase under it, and whether this agent is pinned there.
 *
 * `resolvedNode` is `/runner-node`'s answer to "where does this pin ACTUALLY resolve" — the only
 * side holding the persisted machine id, so it is the one proof that two hostnames are one machine
 * when Terminals has not folded them. Optional, and only ever able to turn a tile MORE attached:
 * without it the tile falls back to the `aka` fold, which is the same fact by a weaker route.
 */
export function machineTile(m: Machine, instanceId: string, runnerNode: string, resolvedNode?: string | null): MachineTile {
	// CONNECTIVITY: this agent holds a relay socket on this machine. Both feeds report it with a
	// pin-blind probe, so on its own it says nothing about where work goes.
	const socket = (m.instances || []).some((i) => i.instanceId === instanceId && i.connected);
	// Pinned to THIS MACHINE — under any name it has used. A pin left on a hostname the machine
	// stopped using still routes here (`aliasNodesFor`), so testing the current name alone told
	// the user their agent was pinned somewhere else while it was in fact running right here.
	const pinned = runnerNode === m.node || (m.aka || []).includes(runnerNode);
	// ROUTING: does this agent's work reach this machine? `getBoundRunnerConn` is pin-authoritative
	// and never falls through, so a pin excludes every other machine however alive it is. Unpinned,
	// routing follows whichever machine holds a live socket — so the socket IS the answer (#531).
	const routesHere = !runnerNode || pinned || (!!resolvedNode && resolvedNode === m.node);
	const tone: TileTone = socket ? (routesHere ? "attached" : "connected") : m.connected ? "online" : "offline";
	return {
		node: m.node,
		tone,
		// The word says which fact it means. "Attached" is a claim about routing and is reserved for
		// a machine work actually reaches; a machine the pin excludes is described as connected and
		// told where the work went instead, so the reader learns why nothing runs here rather than
		// reading a green tile that contradicts the status line above it.
		statusText:
			tone === "attached"
				? "Attached · online"
				: tone === "connected"
					? `Connected · this agent runs on ${runnerNode}`
					: tone === "online"
						? "Online · agent not attached"
						: "Offline",
		pinned,
		meta: `${m.placement === "managed" ? "cloud" : "local"}${m.runnerVersion ? ` · v${m.runnerVersion}` : ""} · seen ${agoShort(m.lastSeenAt)}`,
		// Named rather than hidden: the pins, the relay and the session rows are all still keyed by
		// hostname, so these strings are what a stranded pin literally says. Seeing them is how a
		// user recognises their own laptop under last week's name instead of a machine they do not
		// know — the fold is only trustworthy if what it folded stays visible.
		alsoKnownAs: (m.aka || []).length ? `also ${(m.aka || []).join(" · ")}` : "",
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
