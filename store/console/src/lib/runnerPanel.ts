import { type MachineResources, tileHealth, warningHead } from "./machineHealth";

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
	/** What the machine is doing (#924); null when its CLI predates the sample. */
	resources?: MachineResources | null;
	/** Features its CLI is too old for (#859); `[]` when current. */
	runnerBehind?: string[] | null;
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
	/** "load 0.4/core · 2 of ~4 sessions", or "" when the machine reported no sample (#929). */
	health: string;
	/** Warning heads ("CPU saturated") — the full sentences are on the Terminals page. */
	alerts: string[];
	/** Its CLI is too old for a platform feature (#859). */
	outdated: boolean;
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
		// A machine about to drop its relays looks like any other green tile without these (#929).
		health: tileHealth(m.resources),
		alerts: (m.resources?.warnings ?? []).map(warningHead),
		outdated: !!m.runnerBehind?.length,
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

// ── What a pin move or a reattach actually did (#932) ───────────────────────────────────────────
//
// `PUT …/runner-node` answers `{runnerNode, attachment}` and `POST …/runner-attach` answers the
// attachment itself (workers/api/src/routes/instances-runner-attach.ts). The card discarded both and
// printed "Pinned to X" for every outcome — including a pin that saved but did not attach, and one
// whose confirmation timed out — so a move that had not happened read as done.

/** The attachment either route answers with (`RepinAttachment` / `AgentAttachment`, both optional-heavy). */
export interface AttachResult {
	node?: string;
	attached?: boolean;
	/** The 15s confirmation window closed before the outcome was known (#887, #922). */
	unconfirmed?: boolean;
	/** The server's sentence: the cause when it did not attach, or what is still open. */
	detail?: string;
	/** Stale sockets cleared from the agent's slot (runner-attach only). */
	evicted?: number;
}

export interface MoveOutcome {
	/** `ok` = done; `pending` = not confirmed yet, re-check; `warn` = it did not attach. */
	tone: "ok" | "pending" | "warn";
	text: string;
	/** Offer "Reattach on <node>" — the remote `pags up --force` for this one agent. */
	offerReattach: boolean;
}

/**
 * The server's `detail`, said to the person reading the card. It is written for MCP callers and
 * names their tools; on this card the same actions are a button and a refresh.
 */
export function humanDetail(detail: string | undefined): string {
	return (detail ?? "")
		.replace(/\bCall force_runner_attach\b/g, "Use Reattach")
		.replace(/\bforce_runner_attach\b/g, "Reattach")
		.replace(/\bcall runner_update\b/g, "update its CLI")
		.replace(/\s*Call instance_runner_node to [^.]*\.?/g, "")
		.replace(/;?\s*instance_runner_node shows where it is attached\.?/g, ".")
		.replace(/\s+\./g, ".")
		.trim();
}

/** `PUT /v1/instances/:id/runner-node`'s answer: the saved pin and what the move did. */
export interface PinResponse {
	runnerNode: string | null;
	attachment?: AttachResult | null;
}

/** What `PUT /v1/instances/:id/runner-node` did, for the line under the machine grid. */
export function pinOutcome(node: string, resp: Partial<PinResponse> | null | undefined): MoveOutcome {
	if (!node) return { tone: "ok", text: "Set to automatic — calls go to whichever machine holds a live runner.", offerReattach: false };
	const a = resp?.attachment;
	// An older API answered without `attachment`: the pin is saved and that is all it said.
	if (!a) return { tone: "ok", text: `Pinned to ${node}.`, offerReattach: false };
	if (a.attached && !a.unconfirmed) return { tone: "ok", text: `Moved to ${node} — this agent is attached there now.`, offerReattach: false };
	if (a.attached) return { tone: "pending", text: `Attached on ${node}. Other machines still let go of it on their own poll — this card re-checks.`, offerReattach: false };
	if (a.unconfirmed) return { tone: "pending", text: `Pinned to ${node}; not confirmed yet whether it attached — this card re-checks in a few seconds.`, offerReattach: false };
	const why = humanDetail(a.detail);
	return { tone: "warn", text: `Pinned to ${node}, but this agent didn't attach there.${why ? ` ${why}` : ""}`, offerReattach: true };
}

/** What `POST /v1/instances/:id/runner-attach` did. */
export function reattachOutcome(node: string, a: AttachResult | null | undefined): MoveOutcome {
	if (a?.attached) {
		const cleared = a.evicted ? ` (cleared ${a.evicted} stale connection${a.evicted === 1 ? "" : "s"})` : "";
		return { tone: "ok", text: `Reattached on ${node}${cleared}.`, offerReattach: false };
	}
	if (a?.unconfirmed) return { tone: "pending", text: `Asked ${node} to attach this agent; not confirmed yet — this card re-checks in a few seconds.`, offerReattach: false };
	const why = humanDetail(a?.detail);
	return { tone: "warn", text: `Couldn't attach on ${node}.${why ? ` ${why}` : ""}`, offerReattach: false };
}

/**
 * Show the Reattach button? When the pinned machine is up but this agent is not attached to it —
 * the case a stale or duplicate socket causes, and the one where "restart pags up" was the only
 * advice even though the platform can do the takeover remotely — or when a move just said so.
 */
export function canReattach(runnerNode: string, warning: ReturnType<typeof pinnedWarning>, last: MoveOutcome | null): boolean {
	return !!runnerNode && (warning === "not_attached" || last?.offerReattach === true);
}

/** `POST /v1/terminals/nodes/:node/update`'s answer (worker: `RunnerUpdateResult`). */
export interface RunnerUpdateResponse {
	action: "up-to-date" | "refused" | "scheduled" | "restarted" | "would-update" | "unsupported" | "unreachable" | "failed";
	detail?: string;
}

/** The line under the card after an update — the server's own sentence, in the console's words. */
export function updateOutcome(res: RunnerUpdateResponse): { tone: "ok" | "pending" | "warn"; text: string } {
	// The update detail is written for MCP callers too; on this card "poll" and "call again" are a refresh.
	const text =
		humanDetail(res.detail)
			.replace(/\bCall runner_update again afterwards\b/g, "Refresh afterwards")
			.replace(/\bpoll list_runner_nodes\b/g, "refresh this page")
			.replace(/\bcoding_diagnostics\b/g, "the agent's diagnostics") || res.action;
	if (res.action === "restarted" || res.action === "up-to-date") return { tone: "ok", text };
	if (res.action === "scheduled" || res.action === "would-update") return { tone: "pending", text };
	return { tone: "warn", text };
}
