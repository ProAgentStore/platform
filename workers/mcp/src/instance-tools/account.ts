import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Account-level reads that are not scoped to any one instance — plan, spend, which BYOK
 * keys exist, whether Gmail is connected — plus the candidate Profile write.
 *
 * They live with the instance tools because that is what a caller is doing when it needs
 * them ("chat says BYOK is required — do I have a key?"). Nothing here can reveal a secret
 * value; `keys_status` returns provider names only, by design.
 */
export function registerAccountTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"billing_status",
		"Read your billing/plan status (free vs Pro, whether the paywall is enforced, whether a billing account exists). Upgrades happen in the console (browser redirect).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/billing/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"usage_summary",
		"Token usage + ESTIMATED value across all your agents, broken down by agent, model, activity (chat/apply/coding/voice/…) and PAYER, over a time range. Every dollar figure is tokens x published list price — ours for platform calls, Claude Code's own arithmetic for coding-engine rows — so none of it is a bill. `totals.chargedCostMicros` is the part someone is actually charged; the rest (a coding engine on a subscription, or one whose payer we could not establish) is real tokens at a notional price. History starts when tracking was enabled.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			range: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Time window (default 30d)."),
		},
		async ({ token, range }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const q = range ? `?range=${encodeURIComponent(range)}` : "";
			const data = await authedCall(`/v1/usage${q}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"keys_status",
		"Which AI providers have a BYOK key stored for your account (names only — values are never exposed). Useful when chat says BYOK is required.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/keys/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"email_status",
		"Gmail connection status for the email-access tool (configured? connected?). Connect/disconnect happens in the console.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/email/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"update_profile",
		"Update your structured candidate Profile / Job Preferences (string fields only; used by the apply pipeline). Read get_profile first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			fields: z.record(z.string()).describe("Field name → value (e.g. full_name, phone, city; empty string clears a field)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, fields, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { fields: Object.keys(fields) };
			const denied = await requirePermission(safetyFor(token), "write", "update_profile", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "update_profile", "update candidate profile fields", input, {
					endpoint: "/v1/profile",
					method: "PUT",
				});
			}
			const data = await authedCall(
				"/v1/profile",
				sessionToken,
				{ method: "PUT", body: JSON.stringify(fields) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "update_profile", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);
}
