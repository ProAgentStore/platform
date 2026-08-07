import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { relayConnected } from "../lib/runner-client.js";
import { lastTerminal } from "../lib/coding-timeline.js";
import { parseBoundRunnerNode } from "../lib/runtime-nodes.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import type { Env } from "../types.js";

/**
 * Terminals / nodes — a PLATFORM-level view of the user's connected CLIs (machines running
 * `pags up`), across ALL agents. A node is owned by the user, not any one agent; several
 * agents can share it. Today a node is recorded per-instance in `instance_runtime_nodes`
 * (multiplexed `pags up` registers each active instance), so the machine view is those rows
 * grouped by `runner_node`. Read-only transparency: status, sessions, tmux tail, logs.
 */
export const terminalRoutes = new Hono<{ Bindings: Env }>();

interface NodeRow {
	instance_id: string;
	runner_node: string;
	placement: string;
	runner_version: string;
	status: string;
	last_seen_at: string | null;
	updated_at: string;
	/** The stable identity (#379), NULL for a row written before it existed or by an older CLI. */
	machine_id: string | null;
	instance_config: string | null;
	agent_name: string | null;
	agent_slug: string | null;
	agent_category: string | null;
	agent_config: string | null;
}

interface SessionRow {
	id: string;
	instance_id: string;
	repo_id: string;
	runner_node: string | null;
	client_type: string;
	status: string;
	issue_number: number | null;
	issue_title: string | null;
	updated_at: string;
	repo_name: string | null;
}

export interface TerminalInstance {
	instanceId: string;
	name: string;
	agentSlug: string | null;
	status: string;
	connected: boolean;
	/** True when this instance is PINNED to run on this machine (config.runnerNode). A
	 *  bound instance routes its runner calls here even when another node is also connected. */
	bound: boolean;
	/** The runner runtime this agent uses ("coding" | "browser"). Runner-less agents
	 *  (runtime:null — chat/RAG/connector) are excluded from the list entirely. */
	runtime: "browser" | "coding";
}

export interface TerminalSession {
	sessionId: string;
	instanceId: string;
	repoId: string;
	repoName: string | null;
	engine: string;
	status: string;
	issueNumber?: number;
	issueTitle?: string;
	updatedAt: string;
	terminalTail?: string | null;
}

export interface TerminalNode {
	/** The machine's CURRENT name — the hostname of its freshest registration. */
	node: string;
	/** The stable identity that folded this machine's names together, null when it has none. */
	machineId: string | null;
	/**
	 * Names this machine has ALSO answered to, freshest first, excluding `node` (#393).
	 *
	 * Not decoration: the pins, the relay DO and `coding_sessions.runner_node` are all still keyed
	 * by hostname, so these strings are what a stranded pin actually says. Showing them is how a
	 * user recognises "my laptop, under the name it used last week" instead of an unknown machine.
	 */
	aka: string[];
	placement: string;
	runnerVersion: string;
	lastSeenAt: string | null;
	/** Live: any (instance,node) relay socket is up. */
	connected: boolean;
	/** Agents/instances this machine serves. */
	instances: TerminalInstance[];
	/** Coding sessions pinned to this machine. */
	sessions: TerminalSession[];
}

/** A user-facing name for an instance: its renamed displayName, else the agent name/slug. */
function instanceName(cfg: string | null, agentName: string | null, agentSlug: string | null): string {
	try {
		const c = JSON.parse(cfg || "{}") as { displayName?: string };
		if (typeof c.displayName === "string" && c.displayName.trim()) return c.displayName.trim();
	} catch {
		/* fall through */
	}
	return agentName || agentSlug || "Agent";
}

/** Epoch ms for a stamp, 0 when it cannot be parsed — so a bad date never wins "freshest". */
function stampMs(value: string | null | undefined): number {
	const t = Date.parse(String(value ?? "").replace(" ", "T").replace(/Z?$/, "Z"));
	return Number.isFinite(t) ? t : 0;
}

/**
 * Pure: fold per-instance node registrations + node-pinned sessions into machine-centric node
 * objects. `connected` flags default false — the route fills them from live relay checks.
 * Exported for tests (the grouping/dedup is the tricky part).
 *
 * ── Grouped by MACHINE, not by hostname (#393)
 *
 * A registration is keyed by `os.hostname()`, which moves under a machine (#379), so one laptop
 * held three rows — `Mac`, `RLs-MacBook-Air.local`, `RLs-MacBook-Air` — and this page rendered it
 * as three machines, two of them permanently offline. `/v1/instances/:id/runner-node` already
 * folds by `machine_id`; this endpoint did not, so the "Runs on" dropdown showed one machine while
 * the tiles beside it showed three. Two surfaces, one question, two answers.
 *
 * Rows WITHOUT a `machine_id` stay separate, keyed by hostname as before: without the proof they
 * are separate, which is the same fail-closed rule `foldNodesByMachine` and `aliasNodesFor` apply.
 * Two different machines therefore never merge — identity is the UUID each one persists, never the
 * name — and a machine that has never run a CLI new enough to mint one is unaffected.
 *
 * The group's `node` is the name from its FRESHEST registration, and that is also the name whose
 * relay socket the route probes. Not an approximation: every heartbeat updates `last_seen_at` for
 * the name the machine is registering under right now, so the freshest name IS the live one.
 */
export function groupTerminalNodes(nodeRows: NodeRow[], sessionRows: SessionRow[]): TerminalNode[] {
	const byKey = new Map<string, TerminalNode>();
	/** hostname → group key, so a session (keyed by hostname) reaches its machine. */
	const keyForName = new Map<string, string>();
	/** Freshness of the row that named each group, so a later row can rename it. */
	const nameStamp = new Map<string, number>();

	for (const r of nodeRows) {
		if (!r.runner_node) continue;
		const machineId = (r.machine_id ?? "").trim();
		const key = machineId || `node:${r.runner_node}`;
		let n = byKey.get(key);
		if (!n) {
			n = {
				node: r.runner_node,
				machineId: machineId || null,
				aka: [],
				placement: r.placement,
				runnerVersion: r.runner_version,
				lastSeenAt: r.last_seen_at,
				connected: false,
				instances: [],
				sessions: [],
			};
			byKey.set(key, n);
			nameStamp.set(key, stampMs(r.last_seen_at));
		} else if (r.runner_node !== n.node) {
			// A second name for the same machine. The freshest registration owns the display name
			// and the version/placement that go with it; the other name becomes an alias.
			const stamp = stampMs(r.last_seen_at);
			if (stamp > (nameStamp.get(key) ?? 0)) {
				if (!n.aka.includes(n.node)) n.aka.push(n.node);
				n.node = r.runner_node;
				n.placement = r.placement;
				n.runnerVersion = r.runner_version;
				n.lastSeenAt = r.last_seen_at;
				nameStamp.set(key, stamp);
				n.aka = n.aka.filter((a) => a !== r.runner_node);
			} else if (!n.aka.includes(r.runner_node)) {
				n.aka.push(r.runner_node);
			}
		}
		keyForName.set(r.runner_node, key);

		if (!n.instances.some((i) => i.instanceId === r.instance_id)) {
			// Only list agents that actually USE a local runner. `pags up` (multiplexed)
			// registers EVERY active instance, but chat/RAG/connector agents (runtime:null)
			// never touch the CLI — listing them under a "terminal" is misleading. Gate on the
			// resolved runtime capability so only coding/browser agents appear.
			const runtime = agentCapabilities({ slug: r.agent_slug, category: r.agent_category, config: r.agent_config }).runtime;
			if (!runtime) continue;
			// Bound = this instance is pinned to THIS MACHINE (not merely served by it) — under ANY
			// of its names. A pin left on a hostname the machine has stopped using still routes
			// here (`aliasNodesFor`), so rendering it as unbound would contradict what happens.
			const pin = parseBoundRunnerNode(r.instance_config);
			n.instances.push({ instanceId: r.instance_id, name: instanceName(r.instance_config, r.agent_name, r.agent_slug), agentSlug: r.agent_slug, status: r.status, connected: false, bound: !!pin && pin === r.runner_node, runtime });
		}
	}

	// Second pass for the pin: a row is visited once per (instance, name), so an instance pinned to
	// an OLDER name of this machine may have been added from the row carrying its CURRENT one.
	for (const [name, key] of keyForName) {
		const n = byKey.get(key);
		if (!n) continue;
		for (const r of nodeRows) {
			if (r.runner_node !== name) continue;
			const pin = parseBoundRunnerNode(r.instance_config);
			if (!pin) continue;
			const target = byKey.get(keyForName.get(pin) ?? "");
			if (target !== n) continue;
			const inst = n.instances.find((i) => i.instanceId === r.instance_id);
			if (inst) inst.bound = true;
		}
	}

	for (const s of sessionRows) {
		if (!s.runner_node) continue;
		const n = byKey.get(keyForName.get(s.runner_node) ?? "");
		if (!n) continue; // a session whose machine no longer has a registration row
		n.sessions.push({ sessionId: s.id, instanceId: s.instance_id, repoId: s.repo_id, repoName: s.repo_name, engine: s.client_type, status: s.status, issueNumber: s.issue_number ?? undefined, issueTitle: s.issue_title ?? undefined, updatedAt: s.updated_at });
	}
	// Drop machines that ended up with no runner-using agents AND no sessions — i.e. a node
	// that (via an older, over-eager `pags up`) only registered chat/RAG agents that don't
	// need a runner. Nothing runner-related lives there, so it's noise on a "Terminals" view.
	return [...byKey.values()].filter((n) => n.instances.length > 0 || n.sessions.length > 0);
}

/** All the user's CLIs (machines), across every agent — connected or not. */
terminalRoutes.get("/nodes", async (c) => {
	const session = await requireUser(c);
	const uid = session.uid;

	const nodeRows = (await c.env.DB.prepare(
		`SELECT n.instance_id, n.runner_node, n.placement, n.runner_version, n.status, n.last_seen_at, n.updated_at,
		        n.machine_id,
		        i.config AS instance_config, a.name AS agent_name, a.slug AS agent_slug,
		        a.category AS agent_category, a.config AS agent_config
		 FROM instance_runtime_nodes n
		 JOIN agent_instances i ON i.id = n.instance_id
		 LEFT JOIN agents a ON a.id = i.agent_id
		 WHERE n.user_id = ?1
		 ORDER BY n.runner_node ASC, n.updated_at DESC`,
	).bind(uid).all<NodeRow>()).results;

	const sessionRows = (await c.env.DB.prepare(
		`SELECT s.id, s.instance_id, s.repo_id, s.runner_node, s.client_type, s.status, s.issue_number, s.issue_title, s.updated_at, r.name AS repo_name
		 FROM coding_sessions s
		 LEFT JOIN coding_repos r ON r.id = s.repo_id
		 WHERE s.user_id = ?1 AND s.runner_node IS NOT NULL AND s.runner_node != ''
		 ORDER BY s.updated_at DESC`,
	).bind(uid).all<SessionRow>()).results;

	const nodes = groupTerminalNodes(nodeRows, sessionRows);

	// Live status: a machine is connected if ANY of its (instance,node) relays holds a socket.
	// One check per instance the node serves (bounded), all in parallel.
	await Promise.all(nodes.map(async (n) => {
		const checks = await Promise.all(n.instances.slice(0, 25).map((i) => relayConnected(c.env, i.instanceId, n.node).catch(() => false)));
		n.instances.forEach((i, idx) => { i.connected = checks[idx] ?? false; });
		n.connected = checks.some(Boolean);
	}));

	// Cheap tmux peek: the last terminal snapshot tail for ACTIVE sessions (from the timeline,
	// no runner call), capped so a busy account can't fan out unboundedly.
	const active = nodes.flatMap((n) => n.sessions.filter((s) => s.status === "active")).slice(0, 12);
	const tails = new Map<string, string | null>();
	await Promise.all(active.map(async (s) => { tails.set(s.sessionId, await lastTerminal(c.env, s.sessionId).catch(() => null)); }));
	for (const n of nodes) for (const s of n.sessions) s.terminalTail = tails.get(s.sessionId) ?? null;

	return c.json({ nodes });
});
