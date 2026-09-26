/**
 * A repin that MOVES the agent, not just the record (#850).
 *
 * `PUT …/runner-node` wrote the pin and stopped. Every `pags up` re-reads pins on a 20s poll, so the
 * new machine did pick the agent up eventually — but nothing said so, a caller acting straight away
 * (`coding_loop_start`) met the old routing, and a runner started with `--instance` never polls at
 * all. The owner's only remedy was a terminal on the target machine.
 *
 * Here the repin finishes the move itself, through the relay sockets that already exist:
 *
 *   1. ATTACH — any socket this owner holds on the target machine carries a membership-sync
 *      command to the `pags up` running there, which re-reads its agents and opens this one's
 *      socket now. The pin is already written, so the runner reads the new placement.
 *   2. DETACH — every OTHER machine where this agent still holds a socket gets the same command
 *      over that socket, and lets the agent go (it is pinned elsewhere now).
 *   3. VERIFY — the answer is the relay's, not the runner's: `attached` is true only when this
 *      agent's own socket is live on the target (or on a proven alias of it, #379).
 *
 * A runner too old to answer the command still attaches on its own poll, which is why a missing
 * reply waits out one poll interval before answering `attached: false`.
 */
import { aliasNodesFor, type NodeRegistration } from "./machine-identity.js";
import { callRunner, evictStaleRunnerSocket, getRunnerConnIgnoringLiveness, relayConnected, type RunnerConn } from "./runner-client.js";
import { RunnerUnreachableError } from "./runner-unreachable.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** The CLI answers this path itself (`packages/cli/src/commands/runner/relay.ts`); change both. */
export const MEMBERSHIP_SYNC_PATH = "/pags/membership/sync";
/** Long enough for a sync that registers and attaches; short enough to keep a repin interactive. */
const SYNC_TIMEOUT_MS = 15_000;
/** How long a runner that ANSWERED gets to open the socket it just attached. */
const OPEN_WAIT_MS = 8_000;
/** How long a runner that could not answer gets: one 20s discovery poll, plus a margin. */
const POLL_WAIT_MS = 22_000;

export interface RepinAttachment {
	/** The machine the pin names. */
	node: string;
	/** This agent's own socket is live on that machine now. */
	attached: boolean;
	/** Machines this agent was connected on that let it go in this call. */
	detachedFrom: string[];
	/** Machines still holding a socket for it — they drop it on their next poll (the pin moved). */
	stillAttachedOn: string[];
	/** One sentence for the owner when `attached` is false; absent when it is true. */
	detail?: string;
}

export interface RepinDeps {
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/** What {@link attachAgentOnNode} achieved on one machine, and — when it did not — the specific reason. */
export interface AgentAttachment {
	node: string;
	/** This agent's own socket answers on that machine now. */
	attached: boolean;
	/** Stale sockets cleared from the agent's slot there so a runner could take it (#856). */
	evicted: number;
	/** The actionable sentence when `attached` is false. */
	detail?: string;
}

/** The runner-reply shape of a targeted membership sync (#856). Older CLIs answer without `holding`. */
interface SyncReply {
	holding?: boolean;
}

/** The owner's node registrations — the map from a machine's names to the agents holding sockets there. */
export async function nodeRegistrations(env: Env, userId: string): Promise<NodeRegistration[]> {
	const { results } = await env.DB.prepare(
		`SELECT runner_node AS node, machine_id AS machineId, instance_id AS instanceId, last_seen_at AS lastSeenAt
		 FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node IS NOT NULL AND runner_node != ''
		 ORDER BY updated_at DESC LIMIT 200`,
	)
		.bind(userId)
		.all<NodeRegistration>()
		.catch(() => ({ results: [] as NodeRegistration[] }));
	return results ?? [];
}

/**
 * Get THIS agent a live socket on THIS machine, or say exactly why not (#850, #856).
 *
 *   1. The agent's own slot is PROBED — a real ping, not the optimistic `/status` — and a slot held by
 *      a socket nobody answers behind (a frozen or duplicate runner) is cleared, so the machine's
 *      runner is not refused 4409 when it connects. A socket that answers is the agent, attached.
 *   2. The machine's `pags up` is asked, over any socket of this owner's that ANSWERS there, to attach
 *      this agent by name: it un-blocks it, drops a handle that is not delivering, and reconnects it —
 *      with `force=1` when {@link AgentAttachOptions.force} (the remote `pags up --force`). A frozen
 *      carrier is skipped for the next one; it was stopping at the first (#856, pink-laptop).
 *   3. The relay is asked again whether a socket now answers.
 */
export interface AgentAttachOptions extends RepinDeps {
	/** Take the slot even from a runner still answering in it — only on an explicit request. */
	force: boolean;
	/** Registrations already read by the caller. */
	rows?: NodeRegistration[];
}

export async function attachAgentOnNode(env: Env, instanceId: string, userId: string, node: string, opts: AgentAttachOptions): Promise<AgentAttachment> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	const rows = opts.rows ?? (await nodeRegistrations(env, userId));
	// The target MACHINE, by every name it is provably known by — the runner there answers to any of them.
	const targetNames = new Set([node, ...aliasNodesFor(node, rows)]);
	const attachedOnTarget = async () => {
		for (const n of targetNames) if (await relayConnected(env, instanceId, n)) return true;
		return false;
	};

	// 1. The agent's own slot: attached already, or cleared of whatever stale socket held it.
	let evicted = 0;
	for (const n of targetNames) {
		const verdict = await evictStaleRunnerSocket(env, instanceId, n);
		if (verdict.alive && !opts.force) return { node, attached: true, evicted };
		evicted += verdict.evicted;
	}

	// 2. Ask the machine's runner, through the first of this owner's sockets there that answers.
	const carriers = await liveCarriers(env, userId, rows, targetNames);
	if (carriers.length === 0) {
		return { node, attached: false, evicted, detail: `No \`pags up\` is connected on ${node} to hand this agent to. Start it there; it takes the agent on its own once it is running.` };
	}
	let answered: SyncReply | null = null;
	let refusal = "";
	let unresponsive = 0;
	let oldRunner = false;
	for (const carrier of carriers) {
		try {
			answered = (await callRunner<SyncReply>(carrier, MEMBERSHIP_SYNC_PATH, { attach: instanceId, force: opts.force }, { timeoutMs: SYNC_TIMEOUT_MS })) ?? {};
			break;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (e instanceof RunnerUnreachableError) {
				unresponsive++;
				continue;
			}
			if (/--instance/.test(message)) {
				refusal = `The \`pags up\` on ${node} was started with --instance, so it serves only that agent. Restart it there without --instance.`;
				break;
			}
			// A runner that predates the control command forwards it and 404s — it still attaches on its own poll.
			if (/→ 404/.test(message)) {
				oldRunner = true;
				break;
			}
			refusal = `The \`pags up\` on ${node} could not be asked to attach this agent (${message}).`;
		}
	}
	if (refusal && !answered && !oldRunner) return { node, attached: false, evicted, detail: refusal };
	if (!answered && !oldRunner) {
		return {
			node,
			attached: false,
			evicted,
			detail: `Every relay socket \`pags up\` holds on ${node} is connected but not answering (${unresponsive} tried) — the runner there is frozen or gone, so nothing on that machine can be asked to attach this agent. Restart \`pags up\` on ${node}.`,
		};
	}

	// 3. The relay's answer, after the runner has had time to open the socket.
	const waitUntil = now() + (answered ? OPEN_WAIT_MS : POLL_WAIT_MS);
	let attached = await attachedOnTarget();
	while (!attached && now() < waitUntil) {
		await sleep(1_000);
		attached = await attachedOnTarget();
	}
	if (attached) return { node, attached, evicted };
	const refused = answered?.holding === false;
	return {
		node,
		attached,
		evicted,
		detail: opts.force
			? refused
				? `The \`pags up\` on ${node} did not take this agent even when forced — it is not one that machine may run (pinned to another machine, paused, or without a runtime).`
				: `The \`pags up\` on ${node} was told to take this agent over and no live socket appeared — check that machine's runner window for a relay error.`
			: `The \`pags up\` on ${node} ${oldRunner ? "is too old to be asked and has not attached this agent on its own poll" : "did not attach this agent"}. Call force_runner_attach to take its slot on ${node} over — the remote \`pags up --force\` for this one agent.`,
	};
}

export async function attachOnRepin(env: Env, instanceId: string, userId: string, node: string, deps: RepinDeps = {}): Promise<RepinAttachment> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const rows = await nodeRegistrations(env, userId);
	const targetNames = new Set([node, ...aliasNodesFor(node, rows)]);
	const waitFor = async (check: () => Promise<boolean>, ms: number) => {
		const until = now() + ms;
		while (!(await check())) {
			if (now() >= until) return false;
			await sleep(1_000);
		}
		return true;
	};

	// 1. Attach on the target — without force: a repin moves the agent, it does not take a slot another
	// runner still answers in. When that is what stands in the way, the detail names the tool that does.
	const { attached, detail } = await attachAgentOnNode(env, instanceId, userId, node, { force: false, rows, sleep, now });

	// 2. Detach from every other machine that still holds this agent. Its own socket carries the
	// request, so the reply is usually lost to the detach it caused — the relay is asked instead.
	const detachedFrom: string[] = [];
	const stillAttachedOn: string[] = [];
	const ownNodes = [...new Set(rows.filter((r) => r.instanceId === instanceId).map((r) => normalizeRunnerNode(r.node)))];
	for (const stale of ownNodes.filter((n) => n && !targetNames.has(n))) {
		if (!(await relayConnected(env, instanceId, stale))) continue;
		const conn = await getRunnerConnIgnoringLiveness(env, instanceId, userId, stale).catch(() => null);
		if (conn) await callRunner(conn, MEMBERSHIP_SYNC_PATH, {}, { timeoutMs: SYNC_TIMEOUT_MS }).catch(() => undefined);
		const gone = await waitFor(async () => !(await relayConnected(env, instanceId, stale)), OPEN_WAIT_MS);
		(gone ? detachedFrom : stillAttachedOn).push(stale);
	}

	return { node, attached, detachedFrom, stillAttachedOn, ...(attached ? {} : { detail }) };
}

/**
 * Every socket this owner's agents hold on the target machine that the relay believes live — the ways
 * in to its runner, freshest first. A list, not the first: `relayConnected` is optimistic, so one of
 * them may be a frozen peer that only the command's own probe exposes (#856).
 */
async function liveCarriers(env: Env, userId: string, rows: readonly NodeRegistration[], targetNames: ReadonlySet<string>): Promise<RunnerConn[]> {
	const out: RunnerConn[] = [];
	const seen = new Set<string>();
	for (const r of rows) {
		const n = normalizeRunnerNode(r.node);
		const key = `${r.instanceId}:${n}`;
		if (!r.instanceId || !targetNames.has(n) || seen.has(key)) continue;
		seen.add(key);
		if (!(await relayConnected(env, r.instanceId, n))) continue;
		const conn = await getRunnerConnIgnoringLiveness(env, r.instanceId, userId, n).catch(() => null);
		if (conn) out.push(conn);
	}
	return out;
}
