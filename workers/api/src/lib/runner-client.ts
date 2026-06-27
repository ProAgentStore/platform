import { decryptKey } from "./crypto.js";
import type { Env } from "../types.js";

/** A resolved connection to a user's local browser runner (over the tunnel). */
export interface RunnerConn {
	endpointUrl: string;
	token: string;
	instanceId: string;
	/** Carried so callRunner can re-resolve the URL if the runner reconnects. */
	userId: string;
	env: Env;
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
	return { endpointUrl: row.endpoint_url.replace(/\/$/, ""), token, instanceId, userId, env };
}

/** Wrapper to distinguish "relay returned a value" (even null/undefined) from "relay unavailable". */
type RelayResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Try sending a command through the WebSocket relay DO first; fall back to the
 * tunnel if no runner is connected via relay (503) or the RELAY binding doesn't
 * exist (old CLIs / local dev without the DO).
 */
async function callViaRelay<T>(conn: RunnerConn, path: string, body?: unknown): Promise<RelayResult<T>> {
	if (!conn.env.RELAY) return { ok: false };
	try {
		const stub = conn.env.RELAY.get(conn.env.RELAY.idFromName(conn.instanceId));
		const res = await stub.fetch(new Request("https://relay/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method: "POST", path, body }),
		}));
		if (res.status === 503) return { ok: false }; // no runner on relay -- fall through to tunnel
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`Relay ${path} → ${res.status}: ${detail.slice(0, 200)}`);
		}
		return { ok: true, value: (await res.json()) as T };
	} catch (err) {
		// If the relay itself errors (not 503), throw so the caller sees the real error
		if (err instanceof Error && err.message.startsWith("Relay ")) throw err;
		return { ok: false }; // relay unavailable -- fall through
	}
}

/** POST a JSON request to a runner endpoint with the instance auth headers. */
export async function callRunner<T = unknown>(conn: RunnerConn, path: string, body?: unknown): Promise<T> {
	// Try relay first (WebSocket path -- no tunnel needed)
	const relayResult = await callViaRelay<T>(conn, path, body);
	if (relayResult.ok) return relayResult.value;

	// Fall back to direct tunnel fetch
	const attempt = async (): Promise<T> => {
		const headers: Record<string, string> = { "Content-Type": "application/json", "X-PAGS-Instance-Id": conn.instanceId };
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
	};
	try {
		return await attempt();
	} catch (err) {
		// The runner's tunnel can drop and respawn with a NEW url (the watchdog
		// re-registers it WITHOUT killing the browser). Re-resolve the current url
		// from the DB and retry once — so an in-progress application continues on the
		// SAME live page instead of dying on a stale tunnel.
		const fresh = await getRunnerConn(conn.env, conn.instanceId, conn.userId).catch(() => null);
		if (fresh && fresh.endpointUrl !== conn.endpointUrl) {
			conn.endpointUrl = fresh.endpointUrl;
			conn.token = fresh.token;
			return await attempt();
		}
		throw err;
	}
}
