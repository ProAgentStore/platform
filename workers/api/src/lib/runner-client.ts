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
 * This is the connection every runner feature (chat tools, apply, coding) should use so a
 * user with several machines can say "this agent runs on that machine" and have it respected
 * CONSISTENTLY. When pinned, that machine is **authoritative**: we do NOT silently fall back
 * to another node when it's offline — doing so would run the agent somewhere the user didn't
 * choose and misreport "online" for the wrong machine. Pinned + offline → null (the agent is
 * offline; the user can start that machine or repin). Unpinned → the legacy default runtime.
 */
export async function getBoundRunnerConn(env: Env, instanceId: string, userId: string): Promise<RunnerConn | null> {
	const node = await readInstanceRunnerNode(env, instanceId, userId).catch(() => "");
	if (node) {
		// Pinned = authoritative: only that machine, and only if its relay socket is ACTUALLY
		// live. We can't trust the DB `status` column — it's never cleared when a runner drops
		// (RelayDO.webSocketClose doesn't touch D1), so a machine that closed its laptop still
		// reads `registered`. The RelayDO is the only source of truth. Pinned + dead → offline.
		if (!(await relayConnected(env, instanceId, node).catch(() => false))) return null;
		return getRunnerConn(env, instanceId, userId, node);
	}
	// Unpinned: route to whichever registered machine holds a LIVE relay socket right now —
	// not whatever the stale `instance_runtimes` default points at. A second `pags up` overwrites
	// that default row (to the newest machine) BEFORE its socket is up and it's never cleared on
	// disconnect, so trusting it silently repoints an unpinned agent at an offline machine.
	return getLiveRunnerConn(env, instanceId, userId);
}

/**
 * Resolve a runner connection to a machine whose relay socket is CONNECTED right now. Prefers
 * the legacy default runtime (the common single-machine + old-client case), else scans the
 * user's registered nodes for a live one. Returns null if nothing is actually connected. This
 * is the antidote to the stale-`status` column: routing follows the socket, not the DB row.
 */
async function getLiveRunnerConn(env: Env, instanceId: string, userId: string): Promise<RunnerConn | null> {
	const def = await getRunnerConn(env, instanceId, userId);
	if (def && (await relayConnected(env, instanceId, def.runnerNode ?? null).catch(() => false))) return def;
	// Default is stale/offline — scan the per-machine node registrations for a live socket.
	const { results } = await env.DB.prepare(
		"SELECT DISTINCT runner_node FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node IS NOT NULL AND runner_node != '' ORDER BY updated_at DESC",
	).bind(instanceId, userId).all<{ runner_node: string }>().catch(() => ({ results: [] as { runner_node: string }[] }));
	for (const r of results ?? []) {
		const node = normalizeRunnerNode(r.runner_node);
		if (!node) continue;
		if (await relayConnected(env, instanceId, node).catch(() => false)) {
			return getRunnerConn(env, instanceId, userId, node);
		}
	}
	return null;
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
