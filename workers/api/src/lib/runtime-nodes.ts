/**
 * One row of `instance_runtimes` (the legacy default registration) or of
 * `instance_runtime_nodes` (one per machine). Both tables carry the same columns, which is why one
 * type serves both.
 *
 * Lives here rather than in the route module so that `lib/runtime-response.ts` — the serialiser
 * split out of it — can name its own input without importing a routes module back. That edge was a
 * static import cycle, and `import-graph.test.ts` failed on it.
 */
export interface RuntimeRow {
	instance_id: string;
	user_id: string;
	placement: string;
	endpoint_url: string;
	token_ciphertext: ArrayBuffer | Uint8Array | null;
	token_dek_wrapped: ArrayBuffer | Uint8Array | null;
	token_iv: ArrayBuffer | Uint8Array | null;
	token_plaintext: string | null;
	capabilities: string;
	runner_version: string;
	runner_node: string;
	/** Stable machine identity (#379). Only on `instance_runtime_nodes`, and null until the
	 *  machine has registered with a CLI that mints one. */
	machine_id?: string | null;
	status: string;
	last_seen_at: string | null;
	created_at: string;
	updated_at: string;
}

export function normalizeRunnerNode(value: unknown): string {
	return String(value || "").trim().slice(0, 120);
}

export function relayNameForInstance(instanceId: string, runnerNode?: string | null): string {
	const node = normalizeRunnerNode(runnerNode);
	return node ? `${instanceId}:node:${node}` : instanceId;
}

/** Pull `config.runnerNode` out of an instance config JSON string (the machine this
 *  instance is pinned to). "" = auto (use the legacy default / last-registered runner). */
export function parseBoundRunnerNode(configJson: string | null | undefined): string {
	try {
		const cfg = JSON.parse(configJson || "{}") as { runnerNode?: unknown };
		return normalizeRunnerNode(cfg.runnerNode);
	} catch {
		return "";
	}
}

/** The node an instance is pinned to run on (empty = auto). A platform primitive:
 *  ANY agent instance — not just Coder — can be bound to a specific machine. */
export async function readInstanceRunnerNode(
	env: { DB: D1Database },
	instanceId: string,
	userId: string,
): Promise<string> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string | null }>();
	return parseBoundRunnerNode(row?.config);
}
