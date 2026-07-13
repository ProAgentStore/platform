import { decryptKey } from "./crypto.js";
import { normalizeRunnerNode, readInstanceRunnerNode, relayNameForInstance } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** A resolved connection to a user's local browser runner (via WebSocket relay). */
export interface RunnerConn {
	endpointUrl: string;
	token: string;
	instanceId: string;
	userId: string;
	env: Env;
	runnerNode?: string;
	relayName: string;
}

/**
 * Resolve the connected runner for an instance and decrypt its bearer token.
 * Returns null when no runner is online.
 */
export async function getRunnerConn(env: Env, instanceId: string, userId: string, runnerNode?: string | null): Promise<RunnerConn | null> {
	const node = normalizeRunnerNode(runnerNode);
	const row = await env.DB.prepare(
		node
			? "SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv, runner_node FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3 AND status != 'offline'"
			: "SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv, runner_node FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2 AND status != 'offline'",
	)
		.bind(...(node ? [instanceId, userId, node] : [instanceId, userId]))
		.first<{
			endpoint_url: string;
			token_plaintext: string | null;
			token_ciphertext: ArrayBuffer | null;
			token_dek_wrapped: ArrayBuffer | null;
			token_iv: ArrayBuffer | null;
			runner_node?: string | null;
		}>();
	if (!row?.endpoint_url) return null;

	let token = row.token_plaintext || "";
	if (!token && row.token_ciphertext && row.token_dek_wrapped && row.token_iv && env.KEY_ENCRYPTION_KEY) {
		try {
			token = await decryptKey(
				new Uint8Array(row.token_ciphertext),
				new Uint8Array(row.token_dek_wrapped),
				new Uint8Array(row.token_iv),
				env.KEY_ENCRYPTION_KEY,
			);
		} catch {
			/* fall through with empty token */
		}
	}
	const resolvedNode = normalizeRunnerNode(row.runner_node || node);
	return {
		endpointUrl: row.endpoint_url.replace(/\/$/, ""),
		token,
		instanceId,
		userId,
		env,
		runnerNode: resolvedNode || undefined,
		relayName: relayNameForInstance(instanceId, resolvedNode),
	};
}

/**
 * Resolve the runner for an instance honoring its node binding (`config.runnerNode`).
 * This is the connection any non-coding feature (chat tools, apply, etc.) should use so
 * that a user with several machines can say "this agent runs on that machine" and have it
 * respected. When pinned to a node that is online → use it; otherwise fall back to the
 * legacy default runtime (last-registered), so pinning never strands a working runner.
 */
export async function getBoundRunnerConn(env: Env, instanceId: string, userId: string): Promise<RunnerConn | null> {
	const node = await readInstanceRunnerNode(env, instanceId, userId).catch(() => "");
	if (node) {
		const pinned = await getRunnerConn(env, instanceId, userId, node);
		if (pinned) return pinned;
	}
	return getRunnerConn(env, instanceId, userId);
}

export async function relayConnected(env: Env, instanceId: string, runnerNode?: string | null): Promise<boolean> {
	try {
		if (!env.RELAY) return false;
		const stub = env.RELAY.get(env.RELAY.idFromName(relayNameForInstance(instanceId, runnerNode)));
		const res = await stub.fetch(new Request("https://relay/status"));
		if (!res.ok) return false;
		const data = (await res.json()) as { connected?: boolean };
		return data.connected === true;
	} catch {
		return false;
	}
}

/**
 * Live check: is a runner WebSocket actually connected for this instance right now?
 * Queries the RelayDO (authoritative — it holds the socket), NOT the DB `status`
 * column, which can read "active"/"online" after an unclean disconnect. Cheap: the DO
 * is hibernated when idle. Returns false on any error (treat unknown as offline).
 */
export async function isRunnerOnline(env: Env, instanceId: string, runnerNode?: string | null): Promise<boolean> {
	return relayConnected(env, instanceId, runnerNode);
}

/** Short timeout for READ-type runner commands (terminal capture, snapshots, status). A
 *  connected-but-hung runner (process wedged without closing the WS) would otherwise hold the
 *  request for the full DEFAULT_TIMEOUT_MS (120s) — a ~1.5-3s capture poll must fail fast and
 *  free the socket instead of stacking 2-minute waits in the RelayDO. Mutating commands
 *  (act/clone/start) keep the long default. */
export const READ_TIMEOUT_MS = 10_000;

/** Send a command to the runner via the WebSocket relay DO. `opts.timeoutMs` caps how long
 *  the relay waits for the runner's reply (defaults to the DO's 120s); pass READ_TIMEOUT_MS
 *  for reads so a hung runner can't wedge the UI. */
export async function callRunner<T = unknown>(conn: RunnerConn, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
	if (!conn.env.RELAY) throw new Error("RELAY binding not configured");
	const stub = conn.env.RELAY.get(conn.env.RELAY.idFromName(conn.relayName || conn.instanceId));
	const res = await stub.fetch(new Request("https://relay/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ method: "POST", path, body, timeoutMs: opts?.timeoutMs }),
	}));
	if (res.status === 503) throw new Error("No runner connected — run `pags up`");
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`Runner ${path} → ${res.status}: ${detail.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}
