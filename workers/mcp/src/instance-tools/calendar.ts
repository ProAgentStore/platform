import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The Google Calendar connector's OWNER side (#1313): see whether the account is connected and still
 * working, and grant / revoke one instance's EXACT calendars. The agent's own tools
 * (`calendar_list_granted_calendars`, `calendar_list_events`, `calendar_get_event`,
 * `calendar_reconcile_interview`) are read-only and act only on a granted calendar.
 *
 * Connecting the account is a browser sign-in with Google (Preferences → Connections); no tool here takes
 * or returns a credential.
 */
export function registerCalendarTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const tokenArg = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const instanceId = z.string().describe("Instance ID from my_instances");
	const err = (data: unknown) => (data as { error?: string }).error;
	// Paths are written out in full at each call: the MCP-parity check reads them as literals.

	server.tool(
		"calendar_connection_status",
		"Is Google Calendar connected to your account, and does the stored credential still work (`access`: ok | not_connected | revoked | unconfigured | error)? Checked live against Google, so a revoked connection reads `revoked`, not `connected`. `reach` counts the calendar grants that depend on it. Never returns a credential. Read-only.",
		{ token: tokenArg },
		async ({ token }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "calendar_connection_status", {});
			if (denied) return denied;
			const data = await authedCall("/v1/calendar/status?check=1", session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"list_instance_calendar_grants",
		"List the Google calendars one instance is granted, each with its stable grant `id`. An agent can read only a calendar listed here, by its exact calendar id. Read-only.",
		{ token: tokenArg, instance_id: instanceId },
		async ({ token, instance_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_calendar_grants", { instance_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/calendar/instances/${encodeURIComponent(instance_id)}/grants`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"grant_instance_calendar",
		"Grant one instance ONE exact Google calendar by its calendar id (for example betabuilders.org@gmail.com). It is checked with your connected Google account first: a calendar that account cannot read is refused and nothing is stored, as is a revoked or missing connection. `primary` is refused — name the calendar. Granting the same calendar again returns the SAME grant id. The agent gets read-only access to that calendar's events and nothing else: no other calendar, no create, change or delete. Refused when the instance's agent declares none of the calendar tools. WRITE: widens what the agent can read. Call with dry_run first.",
		{ token: tokenArg, instance_id: instanceId, calendar_id: z.string().describe("The exact calendar id."), dry_run: z.boolean().optional() },
		async ({ token, instance_id, calendar_id, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, calendar_id };
			const denied = await requirePermission(safetyFor(token), "write", "grant_instance_calendar", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "grant_instance_calendar", "grant one Google calendar to this instance", input, { endpoint: `/v1/calendar/instances/${encodeURIComponent(instance_id)}/grants`, method: "POST" });
			const data = await authedCall(`/v1/calendar/instances/${encodeURIComponent(instance_id)}/grants`, session, { method: "POST", body: JSON.stringify({ calendarId: calendar_id }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "grant_instance_calendar", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"revoke_instance_calendar_grant",
		"Revoke one instance's Google calendar grant by its id (from list_instance_calendar_grants). The agent immediately stops being able to read that calendar; a grant already gone is reported, not claimed as revoked. DESTRUCTIVE: requires confirm.",
		{
			token: tokenArg,
			instance_id: instanceId,
			grant_id: z.string().describe("Grant id from list_instance_calendar_grants."),
			confirm: z.string().optional().describe('Must be "revoke_instance_calendar_grant" to revoke.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, grant_id, confirm, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, grant_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "revoke_instance_calendar_grant", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "revoke_instance_calendar_grant", "revoke a Google calendar grant", input, { endpoint: `/v1/calendar/instances/${encodeURIComponent(instance_id)}/grants/${encodeURIComponent(grant_id)}`, method: "DELETE" });
			const unconfirmed = await requireConfirmation(safetyFor(token), "revoke_instance_calendar_grant", confirm, "revoke_instance_calendar_grant", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(`/v1/calendar/instances/${encodeURIComponent(instance_id)}/grants/${encodeURIComponent(grant_id)}`, session, { method: "DELETE" }, env)) as { success?: boolean; error?: string };
			if (!data.success) return text(`Error: ${data.error || "revoke failed"}`);
			await audit(safetyFor(token), { tool: "revoke_instance_calendar_grant", action: "completed", input });
			return text("Google Calendar grant revoked.");
		},
	);
}
