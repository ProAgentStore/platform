import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

export const websiteAccessSchema = z.object({
	mode: z.enum(["allow_all", "allowlist", "ask_once"]),
	domains: z.array(z.string().trim().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i)).max(100),
}).strict();

/** Browser choice, visibility and profile lifetime are independent owner settings (#1431). */
export function registerBrowserSettingsTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const address = {
		token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
	};
	server.tool(
		"get_instance_browser_settings",
		"Read one instance's configured browser choice, visibility, profile and website access policy, with each override, template default and inheritance source. Settings describe the NEXT browser session; use get_instance_browser_session to read the actual live session. Read-only; launches nothing.",
		address,
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_browser_settings", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-settings`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
	server.tool(
		"get_instance_browser_session",
		"Read the actual browser session evidence on this instance's runner, separate from its configured next-session settings. Reports the runner's answer, including no active session or unavailable runtime; launches no browser. Use get_instance_browser_settings for saved defaults.",
		address,
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_browser_session", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-settings/session`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_instance_browser_settings",
		"Change browser choice, visibility, profile lifetime and/or website access for one instance. Omitted fields are preserved; null independently clears that override to inherit the agent default, then the workflow/runner default. Explicit choices never silently fall back to a different browser. Firefox and WebKit mean Playwright's supported builds, not installed Firefox or Safari. Changes apply to the next session; active tasks keep their browser. Read the settings first; preview with dry_run. Starts nothing.",
		{
			...address,
			mode: z.enum(["headed", "headless"]).nullable().optional().describe("headed = visible browser; headless = no desktop window; null = inherit. Omit to preserve."),
			engine: z.enum(["chrome", "msedge", "chromium", "firefox", "webkit"]).nullable().optional().describe("Browser to launch: installed Chrome/Edge or Playwright Chromium/Firefox/WebKit; null = inherit. Omit to preserve."),
			profile_policy: z.enum(["persistent", "ephemeral"]).nullable().optional().describe("persistent = retain this instance's browser profile; ephemeral = fresh session removed on close; null = inherit the agent default, then the workflow default. Omit to preserve."),
			website_access: websiteAccessSchema.nullable().optional().describe("Per-agent website permission: allow_all opens HTTP(S) sites without asking; allowlist permits exact domains only; ask_once remembers owner allow/deny decisions for unknown sites. domains are exact hostnames, not parent-domain grants. Empty allowlist permits none. null inherits; omitted preserves. Requires CLI0.4.209; does not authorize submission or credentials."),
			dry_run: z.boolean().optional().describe("Preview the exact patch without saving it."),
		},
		async ({ token, instance_id, mode, engine, profile_policy, website_access, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const patch = { ...(mode !== undefined ? { mode } : {}), ...(engine !== undefined ? { engine } : {}), ...(profile_policy !== undefined ? { profile: profile_policy } : {}), ...(website_access !== undefined ? { websiteAccess: website_access } : {}) };
			const input = { instance_id, ...patch };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_browser_settings", input);
			if (denied) return denied;
			if (!Object.keys(patch).length) return text("Error: pass at least one of mode, engine, profile_policy or website_access to change.");
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/browser-settings`;
			if (dry_run) return dryRun(safetyFor(token), "set_instance_browser_settings", `update browser settings: ${Object.keys(patch).join(", ")}`, input, { endpoint, method: "PUT", body: patch });
			const data = (await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(patch) }, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "set_instance_browser_settings", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
