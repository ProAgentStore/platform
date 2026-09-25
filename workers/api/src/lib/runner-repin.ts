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
import { callRunner, getRunnerConnIgnoringLiveness, relayConnected } from "./runner-client.js";
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

export async function attachOnRepin(env: Env, instanceId: string, userId: string, node: string, deps: RepinDeps = {}): Promise<RepinAttachment> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const { results } = await env.DB.prepare(
		`SELECT runner_node AS node, machine_id AS machineId, instance_id AS instanceId, last_seen_at AS lastSeenAt
		 FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node IS NOT NULL AND runner_node != ''
		 ORDER BY updated_at DESC LIMIT 200`,
	)
		.bind(userId)
		.all<NodeRegistration>()
		.catch(() => ({ results: [] as NodeRegistration[] }));
	const rows = results ?? [];
	// The target MACHINE, by every name it is provably known by — the runner there answers to any of them.
	const targetNames = new Set([node, ...aliasNodesFor(node, rows)]);
	const attachedOnTarget = async () => {
		for (const n of targetNames) if (await relayConnected(env, instanceId, n)) return true;
		return false;
	};
	const waitFor = async (check: () => Promise<boolean>, ms: number) => {
		const until = now() + ms;
		while (!(await check())) {
			if (now() >= until) return false;
			await sleep(1_000);
		}
		return true;
	};

	// 1. Attach on the target, over a socket some agent of this owner already holds there.
	let attached = await attachedOnTarget();
	let detail: string | undefined;
	if (!attached) {
		const carrier = await findCarrier(env, userId, rows, targetNames);
		if (!carrier) {
			detail = `No \`pags up\` is connected on ${node} to hand this agent to. Start it there; it takes the agent on its own once it is running.`;
		} else {
			const sync = await callRunner<{ error?: string }>(carrier, MEMBERSHIP_SYNC_PATH, {}, { timeoutMs: SYNC_TIMEOUT_MS }).then(
				() => ({ ok: true, error: "" }),
				(e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
			);
			// A scoped runner refused, by name — waiting would not change its answer.
			const scoped = /--instance/.test(sync.error);
			attached = scoped ? false : await waitFor(attachedOnTarget, sync.ok ? OPEN_WAIT_MS : POLL_WAIT_MS);
			if (!attached) {
				detail = scoped
					? `The \`pags up\` on ${node} was started with --instance, so it serves only that agent. Restart it there without --instance.`
					: `The \`pags up\` on ${node} did not attach this agent${sync.ok ? "" : ` (${sync.error})`}. Check that machine's runner window.`;
			}
		}
	}

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

/** A live socket on the target machine, held by ANY of this owner's agents — the way in to its runner. */
async function findCarrier(env: Env, userId: string, rows: readonly NodeRegistration[], targetNames: ReadonlySet<string>) {
	const seen = new Set<string>();
	for (const r of rows) {
		const n = normalizeRunnerNode(r.node);
		const key = `${r.instanceId}:${n}`;
		if (!r.instanceId || !targetNames.has(n) || seen.has(key)) continue;
		seen.add(key);
		if (!(await relayConnected(env, r.instanceId, n))) continue;
		const conn = await getRunnerConnIgnoringLiveness(env, r.instanceId, userId, n).catch(() => null);
		if (conn) return conn;
	}
	return null;
}
