import { decryptKey } from "./crypto.js";
import type { Env } from "../types.js";

/** A resolved connection to a user's local browser runner (via WebSocket relay). */
export interface RunnerConn {
	endpointUrl: string;
	token: string;
	instanceId: string;
	userId: string;
	env: Env;
}

/**
 * Resolve the connected runner for an instance and decrypt its bearer token.
 * Returns null when no runner is online.
 */
export async function getRunnerConn(env: Env, instanceId: string, userId: string): Promise<RunnerConn | null> {
	const row = await env.DB.prepare(
		"SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2 AND status != 'offline'",
	)
		.bind(instanceId, userId)
		.first<{
			endpoint_url: string;
			token_plaintext: string | null;
			token_ciphertext: ArrayBuffer | null;
			token_dek_wrapped: ArrayBuffer | null;
			token_iv: ArrayBuffer | null;
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
	return { endpointUrl: row.endpoint_url.replace(/\/$/, ""), token, instanceId, userId, env };
}

/**
 * Live check: is a runner WebSocket actually connected for this instance right now?
 * Queries the RelayDO (authoritative — it holds the socket), NOT the DB `status`
 * column, which can read "active"/"online" after an unclean disconnect. Cheap: the DO
 * is hibernated when idle. Returns false on any error (treat unknown as offline).
 */
export async function isRunnerOnline(env: Env, instanceId: string): Promise<boolean> {
	try {
		if (!env.RELAY) return false;
		const stub = env.RELAY.get(env.RELAY.idFromName(instanceId));
		const res = await stub.fetch(new Request("https://relay/status"));
		if (!res.ok) return false;
		const data = (await res.json()) as { connected?: boolean };
		return data.connected === true;
	} catch {
		return false;
	}
}

/** Send a command to the runner via the WebSocket relay DO. */
export async function callRunner<T = unknown>(conn: RunnerConn, path: string, body?: unknown): Promise<T> {
	if (!conn.env.RELAY) throw new Error("RELAY binding not configured");
	const stub = conn.env.RELAY.get(conn.env.RELAY.idFromName(conn.instanceId));
	const res = await stub.fetch(new Request("https://relay/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ method: "POST", path, body }),
	}));
	if (res.status === 503) throw new Error("No runner connected — run `pags up`");
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`Runner ${path} → ${res.status}: ${detail.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}
