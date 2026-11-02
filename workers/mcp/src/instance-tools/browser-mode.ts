import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Per-instance browser visibility, with template inheritance (#1429). */
export function registerBrowserModeTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const address = {
		token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
	};
	server.tool(
		"get_instance_browser_mode",
		"Mode-only compatibility tool; use get_instance_browser_settings for browser/profile choices. Read browser visibility for one instance: mode (its override), agentDefault, effective and source (instance, agent or runner). headed opens a visible browser on the machine; headless has no desktop window. null effective means the runner fallback decides. Read-only; does not launch a browser.",
		address,
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_browser_mode", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-mode`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
	server.tool(
		"set_instance_browser_mode",
		"Mode-only compatibility tool; use set_instance_browser_settings for browser/profile choices. Set one instance's browser visibility override: headed opens a visible browser on its machine, headless runs without a desktop window, null inherits the agent template default (then the runner fallback). Takes effect on a new browser session; does not interrupt an active task or restart the shared runner. Read get_instance_browser_mode first; preview with dry_run.",
		{
			...address,
			mode: z.enum(["headed", "headless"]).nullable().describe("headed = visible browser; headless = no desktop window; null = inherit the agent default."),
			dry_run: z.boolean().optional().describe("Preview the change without saving it."),
		},
		async ({ token, instance_id, mode, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, mode };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_browser_mode", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/browser-mode`;
			if (dry_run) return dryRun(safetyFor(token), "set_instance_browser_mode", `set browser mode to ${mode ?? "inherit"}`, input, { endpoint, method: "PUT", body: { mode } });
			const data = (await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify({ mode }) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_instance_browser_mode", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
