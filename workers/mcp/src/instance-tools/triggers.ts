import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import { type InstanceToolsCtx, normalizeTriggerConfig, triggerConfigSchema } from "./shared.js";

/**
 * Webhook, cron and connector-sync triggers — the scheduled and event-driven edges into an
 * instance.
 *
 * The trigger CONFIG is a closed schema (`triggerConfigSchema` + `normalizeTriggerConfig`
 * in `shared.ts`), not a free-form object: a trigger names an action the API knows how to
 * run, so a caller cannot express work through it that no route implements.
 */
export function registerTriggerTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"list_instance_triggers",
		"List webhook, cron, and connector-sync triggers configured on a subscribed private instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_triggers", { instance_id });
			if (denied) return denied;
			const data = await authedCall(
				`/v1/triggers?instanceId=${encodeURIComponent(instance_id)}`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"create_instance_trigger",
		"Create a webhook, cron, or connector-sync trigger on a subscribed private instance. Use sync_connector with config.provider and config.grant_id for Google Drive or Zoho WorkDrive folder syncs. An action the instance's agent cannot perform (e.g. run_browse without a BROWSER_TASK workflow) is refused with 400 and the missing capability, rather than saved as a trigger that would silently never run.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			name: z.string().describe("Human-readable trigger name."),
			type: z.enum(["webhook", "cron"]).describe("Webhook exposes a capability URL; cron runs on a schedule."),
			action: z.enum(["create_task", "add_knowledge", "log_event", "sync_connector", "run_pipeline", "insert_record", "run_browse"]),
			schedule: z.string().optional().describe("Required for cron. Examples: @daily, @hourly, every 15 minutes, 0 8 * * *"),
			config: triggerConfigSchema,
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, name, type, action, schedule, config, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const body = {
				instanceId: instance_id,
				name,
				type,
				action,
				schedule,
				config: normalizeTriggerConfig(config),
			};
			const input = { instance_id, name, type, action, schedule, config: body.config };
			const denied = await requirePermission(safetyFor(token), "write", "create_instance_trigger", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "create_instance_trigger", "create instance trigger", input, {
					endpoint: "/v1/triggers",
					method: "POST",
					body,
				});
			}
			const data = await authedCall(
				"/v1/triggers",
				sessionToken,
				{ method: "POST", body: JSON.stringify(body) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_instance_trigger", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"run_instance_trigger",
		"Manually run one configured instance trigger now. This can create tasks, add knowledge, or sync a granted connector folder.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			trigger_id: z.string(),
			payload: z.record(z.unknown()).optional().describe("Optional payload for create_task/add_knowledge/log_event webhook-style triggers."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, trigger_id, payload, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { trigger_id, payloadKeys: Object.keys(payload || {}) };
			const denied = await requirePermission(safetyFor(token), "runtime", "run_instance_trigger", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "run_instance_trigger", "run instance trigger now", input, {
					endpoint: `/v1/triggers/${trigger_id}/run`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/triggers/${trigger_id}/run`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(payload || { manual: true }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "run_instance_trigger", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_trigger_events",
		"Read recent event history for one configured instance trigger, including received/running/succeeded/failed entries.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			trigger_id: z.string(),
			limit: z.coerce.number().int().min(1).max(200).optional(),
		},
		async ({ token, trigger_id, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_trigger_events", { trigger_id, limit });
			if (denied) return denied;
			const qs = limit ? `?limit=${limit}` : "";
			const data = await authedCall(`/v1/triggers/${trigger_id}/events${qs}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_trigger",
		"Delete a configured instance trigger. This removes its event history and connector sync ledger.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			trigger_id: z.string(),
			confirm: z.string().optional().describe('Must be "delete_instance_trigger" to delete a trigger.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, trigger_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { trigger_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_trigger", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_trigger", "delete instance trigger", input, {
					endpoint: `/v1/triggers/${trigger_id}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_trigger", confirm, "delete_instance_trigger", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/triggers/${trigger_id}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_trigger", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
	// ── Building a trigger, rather than writing one blind (#613) ───────────────
	//
	// `create_instance_trigger` could always WRITE a trigger; nothing could check one first.
	// These two are what the console's trigger form is built from: the action vocabulary
	// judged against THIS agent, and a preview that says what would actually be stored.
	// Both are reads — `preview_instance_trigger` is a POST because its input is a whole
	// draft config, not because it changes anything: the route computes and returns, and is
	// deliberately non-throwing so a caller sees ALL the problems at once.

	server.tool(
		"list_trigger_actions",
		"The trigger action vocabulary, annotated for ONE instance: every action with `available` and, when false, the reason this agent would refuse it. Read this before create_instance_trigger — an action the agent cannot perform is stored happily and then never works, and this is the call that says so in advance. The reason sentence is the same one the save path and the console picker use.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances — required; the vocabulary is judged per agent. Copy it exactly."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/triggers/actions?instanceId=${encodeURIComponent(instance_id)}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"preview_instance_trigger",
		"Check a trigger BEFORE creating it. Returns `{schedule, timezone, jitterMinutes, runs, issues, error}`: `runs` is the next few fire times in the trigger's own timezone, `issues` lists every part of the config that would be stored and then ignored (in the words the save path uses), and `error` is set when the schedule itself will not parse. Name `instance_id` and it also checks the action against that agent, so \"it would be stored and never work\" is caught here too. Changes nothing — this is a computation, and it reports every problem rather than stopping at the first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().optional().describe("Check the action against this agent as well. Omit to validate the schedule and config alone."),
			type: z.enum(["cron", "webhook"]).optional().describe("Trigger type. Omit for webhook; `runs` is only computed for cron."),
			action: z.string().optional().describe("Action the trigger would run, e.g. create_task (see list_trigger_actions). Omit for create_task."),
			schedule: z.string().optional().describe("Cron expression to preview, e.g. `0 9 * * 1-5`."),
			config: triggerConfigSchema.optional().describe("The trigger config as it would be saved (timezone, jitterMinutes, and the action's own fields)."),
			count: z.coerce.number().int().min(1).max(5).optional().describe("How many upcoming run times to return, 1-5. Omit for 3."),
		},
		async ({ token, instance_id, type, action, schedule, config, count }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const body: Record<string, unknown> = {};
			if (instance_id !== undefined) body.instanceId = instance_id;
			if (type !== undefined) body.type = type;
			if (action !== undefined) body.action = action;
			if (schedule !== undefined) body.schedule = schedule;
			if (config !== undefined) body.config = normalizeTriggerConfig(config);
			if (count !== undefined) body.count = count;
			const data = await authedCall("/v1/triggers/preview", sessionToken, { method: "POST", body: JSON.stringify(body) }, env);
			return jsonText(data);
		},
	);
}
