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
