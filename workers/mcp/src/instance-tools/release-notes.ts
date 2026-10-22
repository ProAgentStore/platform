import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Release notes (#1216, #1217): one note per coder run that ships to the default branch, posted to
 * the instance's granted Discord and Slack channels. These tools read and set WHO receives them —
 * on/off and which granted channels — send a test note, and run the Slack bot's owner lifecycle,
 * which mirrors the Discord one (`instance-tools/discord.ts`). The account-wide default is the
 * `releaseNotes` section of set_account_preferences.
 *
 * The Slack bot token goes IN through `connect_slack_bot` and is never returned; the `input` handed
 * to audit and dry-run records only that a token was supplied, never its value.
 */
export function registerReleaseNotesTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const tokenArg = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const instanceId = z.string().describe("Instance ID from my_instances");
	const err = (data: unknown) => (data as { error?: string }).error;
	// Paths are written out in full at each call: the MCP-parity check reads them as literals.

	server.tool(
		"get_instance_release_notes",
		"Coding agents only — any other instance answers with an unsupported-feature error (#1286). Read one instance's release-notes setting: `settings` (what the instance itself stored — `enabled` and `channels`, each absent when inherited), `account` (the account default from get_account_preferences), and `effective` — `enabled` with `enabledFrom` (instance | account | platform), and every Discord and Slack channel granted to the instance with `selected` (whether it receives the notes) and its `grantId`. `missing` lists chosen grant ids that were since revoked. Read-only.",
		{ token: tokenArg, instance_id: instanceId },
		async ({ token, instance_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_instance_release_notes", { instance_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/release-notes`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"set_instance_release_notes",
		"Coding agents only — any other instance answers with an unsupported-feature error (#1286). Set whether one instance posts release notes, and to which of its granted channels. Patch per field: omit a field to keep it. `enabled` true/false sets it for this instance; null returns it to the account default. `channels` is a list of `grantId`s from get_instance_release_notes (Discord and Slack alike); null means every granted channel. A grant id this instance does not hold is refused and nothing is saved. Returns the same shape as get_instance_release_notes. Call with dry_run first.",
		{
			token: tokenArg,
			instance_id: instanceId,
			enabled: z.boolean().nullable().optional().describe("true/false for this instance; null follows the account default; omit to keep."),
			channels: z.array(z.string()).nullable().optional().describe("Grant ids that receive the notes; null for every granted channel; omit to keep."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, enabled, channels, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const body: Record<string, unknown> = {};
			if (enabled !== undefined) body.enabled = enabled;
			if (channels !== undefined) body.channels = channels;
			const input = { instance_id, ...body };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_release_notes", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "set_instance_release_notes", "change who receives this instance's release notes", input, { endpoint: `/v1/instances/${encodeURIComponent(instance_id)}/release-notes`, method: "PUT", body });
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/release-notes`, session, { method: "PUT", body: JSON.stringify(body) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "set_instance_release_notes", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"send_test_release_note",
		"Coding agents only — any other instance answers with an unsupported-feature error (#1286). Post a TEST release note to one channel granted to this instance (its `grantId` from get_instance_release_notes), to check the channel works before a run depends on it. Sent whether or not release notes are on or the channel is chosen — it tests the channel. A grant this instance does not hold is refused; a failed post returns the provider's reason (e.g. the Slack bot is not in the channel). WRITE: posts a message to the channel.",
		{ token: tokenArg, instance_id: instanceId, grant_id: z.string().describe("Channel grant id from get_instance_release_notes."), dry_run: z.boolean().optional() },
		async ({ token, instance_id, grant_id, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, grant_id };
			const denied = await requirePermission(safetyFor(token), "write", "send_test_release_note", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "send_test_release_note", "post a test release note to one granted channel", input, { endpoint: `/v1/instances/${encodeURIComponent(instance_id)}/release-notes/test`, method: "POST" });
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/release-notes/test`, session, { method: "POST", body: JSON.stringify({ grantId: grant_id }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "send_test_release_note", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"slack_bot_status",
		"Is a Slack bot connected to your account, does its token still work (checked live against Slack), and which workspace is it in (`bot.team`, `bot.teamId`)? `oauthConfigured` says whether \"Add to Slack\" is available here; `reach` counts the channel grants that depend on the bot. Never returns the token. Read-only.",
		{ token: tokenArg },
		async ({ token }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "slack_bot_status", {});
			if (denied) return denied;
			const data = await authedCall("/v1/slack/bot", session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"connect_slack_bot",
		"Connect or rotate your Slack BOT token — the Bot User OAuth Token (xoxb-…) from api.slack.com/apps → your app → OAuth & Permissions, with the scopes chat:write, channels:read and groups:read. It is checked against Slack before it is stored — a user token or a rejected one is refused — and stored encrypted; no tool ever returns it. A token for a bot in a DIFFERENT workspace revokes every Slack channel grant (`revoked`). Connecting grants no instance anything: grant channels with grant_instance_slack_channel. Call with dry_run first.",
		{
			token: tokenArg,
			bot_token: z.string().min(1).max(512).describe("The Slack bot token (xoxb-…). Stored encrypted; never shown again by any tool."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, bot_token, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { token_supplied: true };
			const denied = await requirePermission(safetyFor(token), "write", "connect_slack_bot", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "connect_slack_bot", "verify the token with Slack, then store it as your Slack bot", input, { endpoint: "/v1/slack/bot", method: "PUT" });
			const data = await authedCall("/v1/slack/bot", session, { method: "PUT", body: JSON.stringify({ token: bot_token }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "connect_slack_bot", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"disconnect_slack_bot",
		"Remove your Slack bot token AND every Slack channel grant on every instance (`revoked` counts them) — a later reconnect does not restore them. Release notes stop reaching Slack. DESTRUCTIVE: requires confirm.",
		{
			token: tokenArg,
			confirm: z.string().optional().describe('Must be "disconnect_slack_bot" to disconnect.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, confirm, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "destructive", "disconnect_slack_bot", {});
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "disconnect_slack_bot", "remove the Slack bot token and every Slack channel grant", {}, { endpoint: "/v1/slack/bot", method: "DELETE" });
			const unconfirmed = await requireConfirmation(safetyFor(token), "disconnect_slack_bot", confirm, "disconnect_slack_bot", {});
			if (unconfirmed) return unconfirmed;
			const data = await authedCall("/v1/slack/bot", session, { method: "DELETE" }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "disconnect_slack_bot", action: "completed", input: {}, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_slack_channels",
		"List the public and private channels your connected Slack bot can see (`isMember`: whether the bot is in it — Slack refuses posts from a bot that is not). Seeing a channel here gives no instance anything — grant it with grant_instance_slack_channel. One page of up to 200; `hasMore` says when there are more. Read-only.",
		{ token: tokenArg },
		async ({ token }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_slack_channels", {});
			if (denied) return denied;
			const data = await authedCall("/v1/slack/channels", session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"list_instance_slack_grants",
		"List the Slack channels one instance is granted, each with its stable grant `id` — what set_instance_release_notes, send_test_release_note and revoke_instance_slack_grant take. Read-only.",
		{ token: tokenArg, instance_id: instanceId },
		async ({ token, instance_id }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_slack_grants", { instance_id });
			if (denied) return denied;
			const data = await authedCall(`/v1/slack/instances/${encodeURIComponent(instance_id)}/grants`, session, {}, env);
			return err(data) ? text(`Error: ${err(data)}`) : jsonText(data);
		},
	);

	server.tool(
		"grant_instance_slack_channel",
		"Grant one instance one Slack channel (id from list_slack_channels) to receive its release notes. The channel is checked with your bot first; an archived or unknown one is refused. A channel the bot is not in is granted with `botInChannel:false` and a `note` — invite the bot there (/invite @bot) or its posts are refused. Granting the same channel again returns the SAME grant id. WRITE: lets the platform post this instance's release notes there. Call with dry_run first.",
		{ token: tokenArg, instance_id: instanceId, channel_id: z.string().describe("Channel id (C… or G…) from list_slack_channels."), dry_run: z.boolean().optional() },
		async ({ token, instance_id, channel_id, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, channel_id };
			const denied = await requirePermission(safetyFor(token), "write", "grant_instance_slack_channel", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "grant_instance_slack_channel", "grant a Slack channel to this instance", input, { endpoint: `/v1/slack/instances/${encodeURIComponent(instance_id)}/grants`, method: "POST" });
			const data = await authedCall(`/v1/slack/instances/${encodeURIComponent(instance_id)}/grants`, session, { method: "POST", body: JSON.stringify({ channelId: channel_id }) }, env);
			if (err(data)) return text(`Error: ${err(data)}`);
			await audit(safetyFor(token), { tool: "grant_instance_slack_channel", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"revoke_instance_slack_grant",
		"Revoke one instance's Slack channel grant by its id (from list_instance_slack_grants). Release notes stop going there; a grant already gone is reported, not claimed as revoked. DESTRUCTIVE: requires confirm.",
		{
			token: tokenArg,
			instance_id: instanceId,
			grant_id: z.string().describe("Grant id from list_instance_slack_grants."),
			confirm: z.string().optional().describe('Must be "revoke_instance_slack_grant" to revoke.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, grant_id, confirm, dry_run }) => {
			const session = tokenFor(token);
			if (!session) return authRequired();
			const input = { instance_id, grant_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "revoke_instance_slack_grant", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(token), "revoke_instance_slack_grant", "revoke a Slack channel grant", input, { endpoint: `/v1/slack/instances/${encodeURIComponent(instance_id)}/grants/${encodeURIComponent(grant_id)}`, method: "DELETE" });
			const unconfirmed = await requireConfirmation(safetyFor(token), "revoke_instance_slack_grant", confirm, "revoke_instance_slack_grant", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(`/v1/slack/instances/${encodeURIComponent(instance_id)}/grants/${encodeURIComponent(grant_id)}`, session, { method: "DELETE" }, env)) as { success?: boolean; error?: string };
			if (!data.success) return text(`Error: ${data.error || "revoke failed"}`);
			await audit(safetyFor(token), { tool: "revoke_instance_slack_grant", action: "completed", input });
			return text("Slack grant revoked.");
		},
	);
}
