import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The native Discord bot connector's OWNER lifecycle (#1132): connect / rotate / disconnect the bot,
 * see what it can reach, and grant / revoke one instance's channels. The agent's own tools
 * (`discord_list_granted_channels`, `discord_read_messages`, `discord_read_reactions`,
 * `discord_send_message`, `discord_add_reaction`) still act only on a granted channel, and a send still needs the instance's
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

	// ── #1625: the owner's bot manages channels (create / update / delete) ──
	const categoryArgs = {
		category: z.string().optional().describe('Category NAME to put the channel under, case-insensitive (the `category` field of list_discord_channels). "" = no category. Refused when no or several categories have that name.'),
		category_id: z.string().optional().describe('Category id instead of a name. "" = no category.'),
	};
	const categoryBody = (category?: string, category_id?: string) => ({ ...(category !== undefined ? { category } : {}), ...(category_id !== undefined ? { categoryId: category_id } : {}) });

	server.tool(
		"create_discord_channel",
		"Create a text channel (or, with type \"category\", a category) in one server your bot is in (guild_id from list_discord_guilds), optionally under a category and with a topic. Discord lower-cases text channel names and turns spaces into dashes. The bot needs Manage Channels there; the error says so when it is missing. Creating a channel grants no agent anything: grant it with grant_instance_discord_channel (channel.id). Not idempotent: calling twice makes two channels, so read list_discord_channels first. WRITE. Call with dry_run first.",
		{
			token: tokenArg,
			guild_id: z.string().describe("Server id from list_discord_guilds."),
			name: z.string().min(1).max(100).describe("Channel name, e.g. check-in-ana-lee."),
			type: z.enum(["text", "category"]).optional().describe("text (default) or category."),
			topic: z.string().max(1024).optional().describe("Optional channel topic (text channels only)."),
			...categoryArgs,
			dry_run: z.boolean().optional(),
		},
		async ({ token, guild_id, name, type, topic, category, category_id, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { guild_id, name, ...(type ? { type } : {}), ...(topic !== undefined ? { topic } : {}), ...categoryBody(category, category_id) };
			const denied = await requirePermission(safetyFor(token), "write", "create_discord_channel", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "create_discord_channel", `create Discord ${type === "category" ? "category" : "channel"} "${name}"`, input, { endpoint: `/v1/discord/guilds/${encodeURIComponent(guild_id)}/channels`, method: "POST" });
			const data = await authedCall(`/v1/discord/guilds/${encodeURIComponent(guild_id)}/channels`, session, { method: "POST", body: JSON.stringify({ name, ...(type ? { type } : {}), ...(topic !== undefined ? { topic } : {}), ...categoryBody(category, category_id) }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "create_discord_channel", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"update_discord_channel",
		"Rename a Discord channel, change its topic, or move it to another category (or out of one, with category \"\"). Only the fields you pass change. A rename also updates the channel's name on your instance grants. The result has the channel before (`previous`) and after. The bot needs Manage Channels. WRITE. Call with dry_run first.",
		{
			token: tokenArg,
			channel_id: z.string().describe("Channel id from list_discord_channels."),
			name: z.string().min(1).max(100).optional(),
			topic: z.string().max(1024).optional(),
			...categoryArgs,
			dry_run: z.boolean().optional(),
		},
		async ({ token, channel_id, name, topic, category, category_id, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const body = { ...(name !== undefined ? { name } : {}), ...(topic !== undefined ? { topic } : {}), ...categoryBody(category, category_id) };
			const input = { channel_id, ...body };
			const denied = await requirePermission(safetyFor(token), "write", "update_discord_channel", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "update_discord_channel", "change a Discord channel's name, topic or category", input, { endpoint: `/v1/discord/channels/${encodeURIComponent(channel_id)}`, method: "PATCH" });
			const data = await authedCall(`/v1/discord/channels/${encodeURIComponent(channel_id)}`, session, { method: "PATCH", body: JSON.stringify(body) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "update_discord_channel", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_discord_channel",
		"Delete one Discord channel (or an empty category) with your bot, and revoke every grant of it on all your instances in the same step (`revokedGrants`). Its messages are gone for good; Discord has no undo. The bot needs Manage Channels. DESTRUCTIVE: requires confirm. Call with dry_run first.",
		{
			token: tokenArg,
			channel_id: z.string().describe("Channel id from list_discord_channels."),
			confirm: z.string().optional().describe('Must be "delete_discord_channel" to delete.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, channel_id, confirm, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { channel_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_discord_channel", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "delete_discord_channel", "delete a Discord channel and revoke every grant of it", input, { endpoint: `/v1/discord/channels/${encodeURIComponent(channel_id)}`, method: "DELETE" });
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_discord_channel", confirm, "delete_discord_channel", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(`/v1/discord/channels/${encodeURIComponent(channel_id)}`, session, { method: "DELETE" }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "delete_discord_channel", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	// ── #1633: server members, and who can see a channel ──
	server.tool(
		"list_discord_members",
		"List members of one server your bot is in (guild_id from list_discord_guilds): each one's Discord user id, username, display name (`globalName`) and server nickname (`nick`). Pass `query` to find people whose username or nickname starts with it; without it, up to `limit` members (max 1000) in id order, continued with `after` (the last id you got). Use it to find a person's user id before set_discord_channel_member_access; a display name alone does not prove who someone is. Needs the bot's Server Members Intent; the error says so when it is off. Read-only.",
		{
			token: tokenArg,
			guild_id: z.string().describe("Server id from list_discord_guilds."),
			query: z.string().max(100).optional().describe("Start of a username or nickname, case-insensitive."),
			limit: z.coerce.number().int().min(1).max(1000).optional().describe("At most this many members (default 1000)."),
			after: z.string().optional().describe("Without query: list members after this user id."),
		},
		async ({ token, guild_id, query, limit, after }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_discord_members", { guild_id, query, limit, after });
			if (denied) return denied;
			const params = new URLSearchParams();
			if (query) params.set("query", query);
			if (limit) params.set("limit", String(limit));
			if (after) params.set("after", after);
			const qs = params.toString();
			const data = await authedCall(`/v1/discord/guilds/${encodeURIComponent(guild_id)}/members${qs ? `?${qs}` : ""}`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"get_discord_channel_access",
		"Who can see one Discord channel: its permission overwrites for @everyone, roles and individual members, each with a name and `view` (allow / deny / inherit for View Channel). A member listed with view \"allow\" can see the channel; with @everyone denied, nobody else can unless a role lets them. Use it to check a private channel after set_discord_channel_member_access. Read-only.",
		{ token: tokenArg, channel_id: z.string().describe("Channel id from list_discord_channels.") },
		async ({ token, channel_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_discord_channel_access", { channel_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/discord/channels/${encodeURIComponent(channel_id)}/access`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"set_discord_channel_member_access",
		"Give one server member access to one Discord channel with your bot (`access: \"grant\"`: View Channel, Send Messages, Read Message History, Add Reactions, Attach Files, Embed Links), or remove that member's own access (`\"remove\"`; roles and @everyone are untouched). The user must already be in the server (user_id from list_discord_members). The bot needs Manage Roles (Manage Permissions) there; the error says so when it is missing. Read the result back with get_discord_channel_access. WRITE. Call with dry_run first.",
		{
			token: tokenArg,
			channel_id: z.string().describe("Channel id from list_discord_channels."),
			user_id: z.string().describe("Discord user id from list_discord_members."),
			access: z.enum(["grant", "remove"]).describe("grant: let them see and post in the channel. remove: take their own access away."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, channel_id, user_id, access, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { channel_id, user_id, access };
			const denied = await requirePermission(safetyFor(token), "write", "set_discord_channel_member_access", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "set_discord_channel_member_access", `${access} a member's access to a Discord channel`, input, { endpoint: `/v1/discord/channels/${encodeURIComponent(channel_id)}/members/${encodeURIComponent(user_id)}`, method: "PUT" });
			const data = await authedCall(`/v1/discord/channels/${encodeURIComponent(channel_id)}/members/${encodeURIComponent(user_id)}`, session, { method: "PUT", body: JSON.stringify({ access }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "set_discord_channel_member_access", action: "completed", input, result: data });
			return jsonText(data);
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
