import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { relayConnected } from "../lib/runner-client.js";
import { lastTerminal } from "../lib/coding-timeline.js";
import { normalizeRunnerNode, parseBoundRunnerNode } from "../lib/runtime-nodes.js";
import { adoptableIdByName, identityHint, machineNamesFor, normalizeMachineId } from "../lib/machine-identity.js";
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
	/**
	 * Why this machine has NO stable identity, in a sentence the user can act on — null when it
	 * has one (#393).
	 *
	 * Without it, a runner too old to mint an id is indistinguishable on screen from one that has
	 * the feature and found nothing to merge: the machine simply keeps showing up under its old
	 * names and the fix looks like it did nothing. `runner_version` is already on the row, so this
	 * is a read, not new plumbing.
	 */
	identityHint: string | null;
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

	// An UNIDENTIFIED row adopts the identity of its hostname — but only when that hostname is
	// unambiguous.
	//
	// Why adopting at all: there is one row per (instance, hostname), and a `pags up` stamps the id
	// on the instances it registers, so an instance it did not attach this session keeps NULL under
	// the very same hostname. Reading the id off whichever row arrived first split one machine in
	// two, and when the NULL row came first it folded nothing. Found in production, not in review:
	// `/runner-node` folded while this endpoint did not, on the same rows.
	//
	// Why only when unambiguous: a hostname is not an identity and must never transfer one. Two
	// laptops both called `Mac` — each serving different instances — are two machines, and merging
	// them is the exact failure the fold exists to avoid, in mirror image. When a name carries more
	// than one id, the identified rows keep their own and the unidentified ones stay on the name,
	// which is the honest answer: we know those two are separate and we do not know about the rest.
	//
	// The rule lives in `lib/machine-identity.ts` because "forget this machine" (#393) has to answer
	// exactly the same name→machine question, and two copies of this rule drifting apart is the
	// defect class this whole file is about.
	const idByName = adoptableIdByName(nodeRows.map((r) => ({ node: r.runner_node, machineId: r.machine_id ?? null })));
	const adoptableId = (name: string): string => idByName.get(name) ?? "";

	for (const r of nodeRows) {
		if (!r.runner_node) continue;
		// Validated with the SHARED rule, not a bare `.trim()`. Registration stores an id only
		// through `normalizeMachineId` (instances.ts), and `aliasNodesFor`/`foldNodesByMachine`
		// read it back through the same gate — so a value they would reject must not fold here
		// either, or this page and the routing beside it disagree again, which is #393 itself.
		const machineId = normalizeMachineId(r.machine_id) || adoptableId(r.runner_node);
		const key = machineId || `node:${r.runner_node}`;
		let n = byKey.get(key);
		if (!n) {
			n = {
				node: r.runner_node,
				machineId: machineId || null,
				aka: [],
				identityHint: null,
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
	// Why an unidentified machine has no id, said out loud (#393). Computed against the group's
	// FRESHEST registration, which is the version actually running there — an old row left behind
	// by a CLI the machine has since upgraded past must not keep prescribing an upgrade.
	for (const n of byKey.values()) n.identityHint = identityHint(n.machineId, n.runnerVersion);

	// Drop machines that ended up with no runner-using agents AND no sessions — i.e. a node
	// that (via an older, over-eager `pags up`) only registered chat/RAG agents that don't
	// need a runner. Nothing runner-related lives there, so it's noise on a "Terminals" view.
	return [...byKey.values()].filter((n) => n.instances.length > 0 || n.sessions.length > 0);
}

// ── Forget this machine (#393) ───────────────────────────────────────────────────────────────
//
// A node row is created on register and never removed — not on disconnect, not ever. So a laptop
// that was renamed by DHCP leaves its old names on the account permanently, listed as offline
// machines their owner recognises as their own, and the only remedy on offer was to edit D1 by
// hand.
//
// Deliberately a USER action with a confirmation, never a cron and never a delete-on-stale sweep:
// a laptop that is merely closed must not lose its registrations, and the timer that decides
// "stale" cannot tell those two apart.

/** Something that still points at a machine, so a forget would take working state with it. */
export interface ForgetBlocker {
	kind: "pin" | "session";
	/** The instance (pin) or session id. */
	id: string;
	/** What to call it on screen. */
	label: string;
	/** Which of the machine's names it points at — the string the user has to repoint. */
	node: string;
}

export type ForgetVerdict = { ok: true } | { ok: false; reason: "connected" | "pinned" | "sessions"; message: string };

/**
 * May this machine be forgotten? Pure, because every arm of it is a refusal a user will read.
 *
 * Deleting a node row does not delete what REFERENCES it. The pins live in
 * `agent_instances.config.runnerNode` and the sessions in `coding_sessions.runner_node`, so
 * removing the row orphans them: the agent is still pinned to a name, still unroutable, and now
 * with less evidence on screen than before. Worse, the row is the proof — `aliasNodesFor` reads
 * `machine_id` off exactly these rows to route a stranded pin onto the name the machine wears now,
 * so deleting them can BREAK an agent that #379 had already healed. Refusing while a pin remains
 * is not caution, it is the invariant.
 *
 * Ended sessions do not block. They are history, they cannot be resumed onto a machine, and
 * `groupTerminalNodes` already tolerates a session whose machine has no registration row. Blocking
 * on them would mean a laptop with a long history could never be forgotten at all — which is the
 * state this ticket is about.
 *
 * A CONNECTED machine is refused before anything else: it is registering right now and would
 * reappear within the heartbeat, so the button would look broken rather than refused.
 */
export function diagnoseForget(connected: boolean, blockers: readonly ForgetBlocker[]): ForgetVerdict {
	if (connected) return { ok: false, reason: "connected", message: "This machine is connected right now — stop `pags up` on it first, or it will re-register immediately." };
	const pins = blockers.filter((b) => b.kind === "pin");
	if (pins.length) {
		const names = pins.map((p) => `${p.label} (pinned to ${p.node})`).join(", ");
		return { ok: false, reason: "pinned", message: `${pins.length} agent${pins.length === 1 ? " is" : "s are"} pinned to run on this machine: ${names}. Repoint ${pins.length === 1 ? "it" : "them"} on the agent's Settings tab first — forgetting the machine now would leave ${pins.length === 1 ? "it" : "them"} pinned to a name nothing can resolve.` };
	}
	const sessions = blockers.filter((b) => b.kind === "session");
	if (sessions.length) {
		return { ok: false, reason: "sessions", message: `${sessions.length} coding session${sessions.length === 1 ? " is" : "s are"} still open on this machine (${sessions.map((s) => s.label).join(", ")}). End ${sessions.length === 1 ? "it" : "them"} first.` };
	}
	return { ok: true };
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

/**
 * Forget a machine: drop its registrations, under every name it has answered to.
 *
 * Addressed by ONE of its names and resolved to the machine, so a folded laptop is forgotten whole
 * — forgetting a single name of it would leave the tile on screen minus some of its rows, which is
 * a worse state than the one being cleaned up.
 *
 * Only `instance_runtime_nodes` is touched. `instance_runtimes` (the one legacy default row per
 * instance) is left alone: it is overwritten by the next `pags up` and deleting it would strip an
 * instance of its runtime registration outright, which is a much larger claim than "this laptop is
 * gone". Ended `coding_sessions` keep their `runner_node` string as history.
 */
terminalRoutes.delete("/nodes/:node", async (c) => {
	const session = await requireUser(c);
	const uid = session.uid;
	const target = normalizeRunnerNode(c.req.param("node"));

	const rows = (await c.env.DB.prepare(
		"SELECT instance_id, runner_node, machine_id, last_seen_at FROM instance_runtime_nodes WHERE user_id = ?1",
	).bind(uid).all<{ instance_id: string; runner_node: string; machine_id: string | null; last_seen_at: string | null }>()).results ?? [];

	const resolved = machineNamesFor(target, rows.map((r) => ({ node: r.runner_node, machineId: r.machine_id, instanceId: r.instance_id, lastSeenAt: r.last_seen_at })));
	if (!resolved.ok) {
		return resolved.reason === "unknown"
			? c.json({ error: "No machine is registered under that name." }, 404)
			: c.json({ error: `More than one machine has registered as "${target}", so this name does not identify one. Rename one of them, or leave them.`, reason: "ambiguous" }, 409);
	}
	const names = new Set(resolved.names);

	// What still points here. Both reads are user-scoped and small (an account's instances and its
	// OPEN sessions), so they are filtered in JS — a pin lives inside a config JSON blob, which is
	// not something to match on in SQL.
	const blockers: ForgetBlocker[] = [];

	const instances = (await c.env.DB.prepare(
		`SELECT i.id, i.config, a.name AS agent_name, a.slug AS agent_slug
		 FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id
		 WHERE i.user_id = ?1`,
	).bind(uid).all<{ id: string; config: string | null; agent_name: string | null; agent_slug: string | null }>()).results ?? [];
	for (const i of instances) {
		const pin = parseBoundRunnerNode(i.config);
		if (pin && names.has(pin)) blockers.push({ kind: "pin", id: i.id, label: instanceName(i.config, i.agent_name, i.agent_slug), node: pin });
	}

	const openSessions = (await c.env.DB.prepare(
		`SELECT s.id, s.runner_node, s.status, r.name AS repo_name
		 FROM coding_sessions s LEFT JOIN coding_repos r ON r.id = s.repo_id
		 WHERE s.user_id = ?1 AND s.status IN ('active', 'suspended') AND s.runner_node IS NOT NULL`,
	).bind(uid).all<{ id: string; runner_node: string | null; status: string; repo_name: string | null }>()).results ?? [];
	for (const s of openSessions) {
		const node = normalizeRunnerNode(s.runner_node);
		if (node && names.has(node)) blockers.push({ kind: "session", id: s.id, label: s.repo_name || s.id, node });
	}

	// Live, not the DB `status` column — which is never cleared on disconnect and would refuse to
	// forget a machine that has been off for weeks.
	const probeIds = [...new Set(rows.filter((r) => names.has(normalizeRunnerNode(r.runner_node))).map((r) => r.instance_id))].slice(0, 25);
	const probes = await Promise.all(probeIds.map(async (id) => {
		for (const name of names) if (await relayConnected(c.env, id, name).catch(() => false)) return true;
		return false;
	}));

	const verdict = diagnoseForget(probes.some(Boolean), blockers);
	if (!verdict.ok) return c.json({ error: verdict.message, reason: verdict.reason, blockers }, 409);

	// One statement per name rather than a built IN list: the names are user data and this keeps
	// every value a bound parameter.
	let removed = 0;
	for (const name of names) {
		const res = await c.env.DB.prepare("DELETE FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node = ?2").bind(uid, name).run();
		removed += res.meta?.changes ?? 0;
	}
	return c.json({ forgotten: [...names], registrationsRemoved: removed });
});
