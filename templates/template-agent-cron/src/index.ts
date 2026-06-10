/**
 * AGENTNAME — a scheduled ProAgentStore worker.
 *
 * Runs on a cron schedule (default: daily at 8am UTC).
 * Use for: daily digests, monitoring, batch processing, data pipelines.
 */

type Env = Record<string, never>;

export default {
	async scheduled(event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {
		console.log(
			`AGENTNAME cron fired: ${event.cron} at ${new Date().toISOString()}`,
		);

		// Add scheduled logic here. If this cron needs AI, call a user-owned
		// provider credential from your app config instead of a platform binding.
	},

	async fetch(_request: Request, _env: Env) {
		return new Response(
			JSON.stringify({ agent: "AGENTNAME", type: "cron", status: "ok" }),
			{
				headers: { "Content-Type": "application/json" },
			},
		);
	},
};
