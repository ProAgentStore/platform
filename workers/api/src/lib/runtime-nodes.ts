export function normalizeRunnerNode(value: unknown): string {
	return String(value || "").trim().slice(0, 120);
}

export function relayNameForInstance(instanceId: string, runnerNode?: string | null): string {
	const node = normalizeRunnerNode(runnerNode);
	return node ? `${instanceId}:node:${node}` : instanceId;
}
