import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The native Discord bot connector's OWNER lifecycle (#1132): connect / rotate / disconnect the bot,
 * see what it can reach, and grant / revoke one instance's channels. The agent's own tools
 * (`discord_list_granted_channels`, `discord_read_messages`, `discord_send_message`,
 * `discord_add_reaction`) still act only on a granted channel, and a send still needs the instance's
 * Discord write consent (`set_instance_connector_consent`) — these tools set up the grant, never the
 * consent.
 *
 * The bot token goes IN through `connect_discord_bot` and is never returned by any tool; like
 * `create_http_profile` (#1123), the `input` handed to audit and dry-run records only that a token
 * was supplied, never its value, so the guarantee does not rest on the redactor matching a name.
 */
export function registerDiscordTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const tokenArg = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const instanceId = z.string().describe("Instance ID from my_instances");
	const err = (data: unknown) => (data as { error?: string }).error;
	// Paths are written out in full at each call: the MCP-parity check reads them as literals.

	server.tool(
		"discord_bot_status",
		"Is a Discord bot connected to your account, does its token still work (checked live against Discord), and which bot is it (`bot.id`, `bot.username`)? `reach` counts the channel grants that depend on it. Never returns the token. Read-only.",
		{ token: tokenArg },
		async ({ token }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "discord_bot_status", {});
			if (denied) return denied;
			const data = await authedCall("/v1/discord/bot", session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"connect_discord_bot",
		"Connect or rotate your Discord BOT token (Developer Portal → your application → Bot → Reset Token). It is checked against Discord before it is stored — a user-account token or a rejected one is refused — and stored encrypted; no tool ever returns it. Rotating to a token for the SAME bot keeps every channel grant; a token for a DIFFERENT bot revokes them all (`revoked`), because those channels were approved for the old bot. Connecting grants no agent anything: grant channels with grant_instance_discord_channel. Call with dry_run first.",
		{
			token: tokenArg,
			bot_token: z.string().min(1).max(512).describe("The Discord bot token. Stored encrypted; never shown again by any tool."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, bot_token, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { token_supplied: true };
			const denied = await requirePermission(safetyFor(token), "write", "connect_discord_bot", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "connect_discord_bot", "verify the token with Discord, then store it as your Discord bot", input, { endpoint: "/v1/discord/bot", method: "PUT" });
			const data = await authedCall("/v1/discord/bot", session, { method: "PUT", body: JSON.stringify({ token: bot_token }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "connect_discord_bot", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"disconnect_discord_bot",
		"Remove your Discord bot token AND every Discord channel grant on every instance (`revoked` counts them) — a later reconnect does not restore them. Every Discord agent stops being able to read or post. DESTRUCTIVE: requires confirm.",
		{
			token: tokenArg,
			confirm: z.string().optional().describe('Must be "disconnect_discord_bot" to disconnect.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, confirm, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "destructive", "disconnect_discord_bot", {});
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "disconnect_discord_bot", "remove the Discord bot token and every Discord channel grant", {}, { endpoint: "/v1/discord/bot", method: "DELETE" });
			const unconfirmed = await requireConfirmation(safetyFor(token), "disconnect_discord_bot", confirm, "disconnect_discord_bot", {});
			if (unconfirmed) return unconfirmed;
			const data = await authedCall("/v1/discord/bot", session, { method: "DELETE" }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "disconnect_discord_bot", action: "completed", input: {}, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_discord_guilds",
		"List the Discord servers your connected bot is a member of — the only servers it can grant channels from. Read-only.",
		{ token: tokenArg },
		async ({ token }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_discord_guilds", {});
			if (denied) return denied;
			const data = await authedCall("/v1/discord/guilds", session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"list_discord_channels",
		"List the text and announcement channels your connected bot can see in one server (from list_discord_guilds). Seeing a channel here does not let any agent use it — grant it with grant_instance_discord_channel. Read-only.",
		{ token: tokenArg, guild_id: z.string().describe("Server id from list_discord_guilds.") },
		async ({ token, guild_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_discord_channels", { guild_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/discord/guilds/${encodeURIComponent(guild_id)}/channels`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"list_instance_discord_grants",
		"List the Discord channels one instance is granted, each with its stable grant `id` — the `grantId` the agent's Discord tools take, and what revoke_instance_discord_grant takes. An agent can read or post only in a channel listed here with resourceType `discord_channel`; one with `discord_release_channel` is reserved for release notes (the platform posts there, the agent cannot). Read-only.",
		{ token: tokenArg, instance_id: instanceId },
		async ({ token, instance_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_discord_grants", { instance_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/discord/instances/${encodeURIComponent(instance_id)}/grants`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"grant_instance_discord_channel",
		"Grant one instance one Discord text or announcement channel (id from list_discord_channels). The channel is checked with your bot first: one it cannot see is refused (403) with the permissions to give it. Granting the same channel again returns the SAME grant id. Refused when the instance's agent does not declare the Discord tools — unless `purpose` is `release_notes`, which grants the channel to the platform's release notes only (resourceType `discord_release_channel`: the agent gets no reach, so a coder with no Discord tools can have one); every other check still applies, and a channel the agent already holds is returned unchanged. For the default purpose this allows reads; posting still needs the instance's Discord write consent (set_instance_connector_consent). WRITE: widens what the agent can read. Call with dry_run first.",
		{ token: tokenArg, instance_id: instanceId, channel_id: z.string().describe("Channel id from list_discord_channels."), purpose: z.enum(["agent", "release_notes"]).optional().describe("agent (default): a channel the agent's Discord tools may use. release_notes: a channel the platform posts release notes to; needs no Discord tools."), dry_run: z.boolean().optional() },
		async ({ token, instance_id, channel_id, purpose, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, channel_id, ...(purpose ? { purpose } : {}) };
			const denied = await requirePermission(safetyFor(token), "write", "grant_instance_discord_channel", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "grant_instance_discord_channel", "grant a Discord channel to this instance", input, { endpoint: `/v1/discord/instances/${encodeURIComponent(instance_id)}/grants`, method: "POST" });
			const data = await authedCall(`/v1/discord/instances/${encodeURIComponent(instance_id)}/grants`, session, { method: "POST", body: JSON.stringify({ channelId: channel_id, ...(purpose ? { purpose } : {}) }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "grant_instance_discord_channel", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"revoke_instance_discord_grant",
		"Revoke one instance's Discord channel grant by its id (from list_instance_discord_grants). The agent immediately stops being able to read or post there; a grant already gone is reported, not claimed as revoked. DESTRUCTIVE: requires confirm.",
		{
			token: tokenArg,
			instance_id: instanceId,
			grant_id: z.string().describe("Grant id from list_instance_discord_grants."),
			confirm: z.string().optional().describe('Must be "revoke_instance_discord_grant" to revoke.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, grant_id, confirm, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, grant_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "revoke_instance_discord_grant", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "revoke_instance_discord_grant", "revoke a Discord channel grant", input, { endpoint: `/v1/discord/instances/${encodeURIComponent(instance_id)}/grants/${encodeURIComponent(grant_id)}`, method: "DELETE" });
			const unconfirmed = await requireConfirmation(safetyFor(token), "revoke_instance_discord_grant", confirm, "revoke_instance_discord_grant", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(`/v1/discord/instances/${encodeURIComponent(instance_id)}/grants/${encodeURIComponent(grant_id)}`, session, { method: "DELETE" }, env)) as { success?: boolean; error?: string };
			if (!data.success) return text(`Error: ${data.error || "revoke failed"}`);
			await audit(safetyFor(token), { tool: "revoke_instance_discord_grant", action: "completed", input });
			return text("Discord grant revoked.");
		},
	);
}
