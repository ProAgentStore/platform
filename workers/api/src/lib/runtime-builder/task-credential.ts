const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A Website Builder task's run-scoped broker credential (#841) never lands in `instance_runtime_tasks`,
 * which boards and MCP read. A current runner removes it on arrival; one older than that returns the
 * task input as PAGS sent it, so it is removed here as well.
 */
export function withoutBrokerCredential(task: Record<string, unknown>): Record<string, unknown> {
	const input = isRecord(task.input) ? task.input : null;
	if (!input || !isRecord(input.broker) || !("token" in input.broker)) return task;
	const { token: _token, ...broker } = input.broker;
	return { ...task, input: { ...input, broker } };
}
