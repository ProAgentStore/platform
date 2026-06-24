import { decryptKey } from "./crypto.js";
import type { Env } from "../types.js";

/** A resolved connection to a user's local browser runner (over the tunnel). */
export interface RunnerConn {
	endpointUrl: string;
	token: string;
	instanceId: string;
}

/**
 * Resolve the connected runner for an instance and decrypt its bearer token.
 * Returns null when no runner is online. Shared by the apply workflow and the
 * agent tools so there's one place that knows how to reach the runner.
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
	return { endpointUrl: row.endpoint_url.replace(/\/$/, ""), token, instanceId };
}

/** POST a JSON request to a runner endpoint with the instance auth headers. */
export async function callRunner<T = unknown>(conn: RunnerConn, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-PAGS-Instance-Id": conn.instanceId,
	};
	if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
	const res = await fetch(`${conn.endpointUrl}${path}`, {
		method: "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`Runner ${path} → ${res.status}: ${detail.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}
