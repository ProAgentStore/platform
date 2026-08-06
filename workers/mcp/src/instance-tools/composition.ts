import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * How agents are wired to each other, and how one is given an objective.
 *
 * Two different couplings live here on purpose, so the difference stays visible:
 * SUPERVISION (#183) is one agent directing another and owning the result; CONNECTIONS
 * (#182, "the pump") are choreography — an agent announces a FACT and does not know who
 * consumes it. Loops are the third: an objective an instance works on by itself, durably.
 */
export function registerCompositionTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	// The supervision + pump tools existed only as HTTP routes, which meant assembling a
	// multi-agent system — the whole point of the supervision work — required curl or a SQL
	// migration. An agent platform whose composition step is not self-serve is not a platform.

	server.tool(
		"list_supervision",
		"List the agents a supervisor instance oversees (its direct reports). Supervision is how one agent delegates goals to others.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string(),
		},
		async ({ token, supervisor_instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_supervision", { supervisor_instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision`, sessionToken, {}, env));
		},
	);

	server.tool(
		"create_supervision",
		"Put one agent in charge of another: the supervisor may then delegate goals to the subordinate. Rejected if it would create a supervision loop, exceed the depth or fan-out limits, or give the subordinate a second supervisor.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string().describe("The instance that will delegate."),
			subordinate_instance_id: z.string().describe("The instance that will receive goals."),
		},
		async ({ token, supervisor_instance_id, subordinate_instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { supervisor_instance_id, subordinate_instance_id };
			const denied = await requirePermission(safetyFor(token), "write", "create_supervision", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ subordinateInstanceId: subordinate_instance_id }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_supervision", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_supervision",
		"Remove a supervision link so the supervisor can no longer delegate to that agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string(),
			supervision_id: z.string().describe("Link id from list_supervision."),
		},
		async ({ token, supervisor_instance_id, supervision_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { supervisor_instance_id, supervision_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_supervision", input);
			if (denied) return denied;
			return jsonText(await authedCall(
				`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision/${encodeURIComponent(supervision_id)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			));
		},
	);

	server.tool(
		"list_connections",
		"List the agent-to-agent event connections leaving an instance — how a fact it emits (e.g. lead.created) is routed to another agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_connections", { instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/connections`, sessionToken, {}, env));
		},
	);

	server.tool(
		"create_connection",
		"Route an event one agent emits to another agent — the 'pump'. Choreography, not supervision: the source announces a FACT and does not know who consumes it. Use supervision instead when one agent must direct another and own the result.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Source instance — the one that emits the event."),
			event_type: z.string().describe("The emitted fact, e.g. lead.created or site.live."),
			target_instance_id: z.string().describe("Instance that receives the payload."),
			action: z.string().describe("What the target does: run_pipeline | insert_record | create_task | add_knowledge."),
			config: z.record(z.unknown()).optional().describe("Action config (pipeline name, collection, filter, params)."),
		},
		async ({ token, instance_id, event_type, target_instance_id, action, config }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, event_type, target_instance_id, action };
			const denied = await requirePermission(safetyFor(token), "write", "create_connection", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/connections`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ eventType: event_type, targetInstanceId: target_instance_id, action, config: config ?? {} }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_connection", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"start_instance_loop",
		"Give an agent an objective and let it work autonomously on the server. Durable: it survives you closing the browser, and its spend is bounded by a budget. Returns a run id — poll it with check_instance_loop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			objective: z.string().describe("The outcome you want, in plain language."),
			max_iterations: z.number().optional().describe("Cap on steps (default 10, max 50)."),
		},
		async ({ token, instance_id, objective, max_iterations }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, objective, max_iterations };
			const denied = await requirePermission(safetyFor(token), "write", "start_instance_loop", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/loop`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ objective, maxIterations: max_iterations }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "start_instance_loop", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"check_instance_loop",
		"Check an autonomous run: status, how many steps it has taken, and why it stopped. Omit run_id to list recent runs for the instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string().optional(),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "check_instance_loop", { instance_id, run_id });
			if (denied) return denied;
			const path = run_id
				? `/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}`
				: `/v1/instances/${encodeURIComponent(instance_id)}/loop`;
			return jsonText(await authedCall(path, sessionToken, {}, env));
		},
	);

	server.tool(
		"stop_instance_loop",
		"Ask an autonomous run to stop. Cooperative: the step in flight finishes and settles its spend rather than being killed mid-way.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string(),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "stop_instance_loop", { instance_id, run_id });
			if (denied) return denied;
			return jsonText(await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			));
		},
	);
}
