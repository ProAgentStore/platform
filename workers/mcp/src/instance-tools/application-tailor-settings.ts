import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Existing owner-scoped Tailor settings, separate from browser Runner policy and source-file selection. */
export function registerApplicationTailorSettings(server: McpServer, ctx: Pick<InstanceToolsCtx, "env" | "tokenFor" | "safetyFor">, pinnedInstanceId?: string): void {
	const { env, tokenFor, safetyFor } = ctx;
	const who: z.ZodRawShape = pinnedInstanceId ? {} : {
		token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		instance_id: z.string().describe("Application Tailor instance ID from my_instances, not the Application Runner or agent template."),
	};
	const identity = (input: Record<string, unknown>) => ({ instanceId: pinnedInstanceId ?? String(input.instance_id), token: pinnedInstanceId ? undefined : input.token as string | undefined });
	server.tool(
		"get_application_tailor_settings",
		"Read one Application Tailor's effective engine, subscription/machine authentication mode, source paths, workspace, retention and run/stall limits. These control document generation, not the Application Runner's browser model. Returns the existing owner-scoped settings; never reads source contents or credentials and never starts work.",
		who,
		async (input: Record<string, unknown>) => {
			const { instanceId, token } = identity(input);
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_application_tailor_settings", { instance_id: instanceId });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instanceId)}/application-tailor/settings`, session, {}, env));
		},
	);
	server.tool(
		"set_application_tailor_settings",
		"Patch one Application Tailor's document-generation engine, authentication mode, workspace or limits. Only supplied fields change; selecting codex or claude does not change the Application Runner engine. Uses the existing owner-scoped Tailor settings route and its validation. Local source-path writes are not exposed here; use the separate uploaded-source tools for uploaded selections. Does not start, retry or cancel any run, install a CLI, sign in, change credentials or authorize submission. Existing runs retain their frozen settings. Read back with get_application_tailor_settings. Use dry_run first.",
		{
			...who,
			settings: z.object({
				engine: z.enum(["claude", "codex"]).optional(),
				authMode: z.enum(["machine", "subscription"]).optional(),
				workspace: z.string().optional().describe("A folder under the machine home, written ~/…; no traversal."),
				retainDays: z.coerce.number().int().min(0).max(3650).optional(),
				maxMinutes: z.coerce.number().int().min(1).max(60).optional(),
				stallMinutes: z.coerce.number().int().min(1).max(60).nullable().optional(),
			}).strict().describe("Only the settings fields to change; omitted fields keep their current values."),
			dry_run: z.boolean().optional(),
		},
		async (input: Record<string, unknown>) => {
			const { instanceId, token } = identity(input);
			const session = tokenFor(token);
			if (!session) return authRequired();
			const auditInput = { instance_id: instanceId };
			const denied = await requirePermission(safetyFor(token), "write", "set_application_tailor_settings", auditInput);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instanceId)}/application-tailor/settings`;
			const settings = input.settings as Record<string, unknown>;
			if (input.dry_run) return dryRun(safetyFor(token), "set_application_tailor_settings", "patch one Application Tailor's settings without starting work", auditInput, { endpoint, method: "PUT", body: settings });
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instanceId)}/application-tailor/settings`, session, { method: "PUT", body: JSON.stringify(settings) }, env) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_application_tailor_settings", action: "completed", input: auditInput });
			return jsonText(data);
		},
	);
}
