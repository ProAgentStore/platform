// Discord bot connection and per-instance channel grants.
//
// A bot token is an account-level credential. A channel grant is a separate, instance-level
// boundary, so connecting a bot never lets every subscribed agent read or post everywhere it can.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { clipMarked } from "../lib/clip-marked.js";
import { deleteConnectorGrant, listConnectorGrants, upsertConnectorGrant } from "../lib/connector-grants.js";
import { connectorClient } from "../lib/connectors/client.js";
import { connectorRefusalFor } from "../lib/instance-connector-access.js";
import { safeFetch } from "../lib/ssrf.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { DiscordChannel, DiscordChannelListResponse, DiscordGrantListResponse, DiscordGrantResponse, DiscordGuild, DiscordGuildListResponse } from "../agent-types.js";

export const discordRoutes = new Hono<{ Bindings: Env }>();

const API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{16,22}$/;
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT

function requireSnowflake(value: string | undefined, label: string): string {
	const id = value?.trim() ?? "";
	if (!SNOWFLAKE.test(id)) throw new HttpError(400, `${label} must be a Discord snowflake.`);
	return id;
}

async function botToken(env: Env, userId: string): Promise<string> {
	return connectorClient(env, "discord", { userId }).token();
}

async function discordJson(token: string, path: string): Promise<unknown> {
	let response: Response;
	try {
		response = await safeFetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}`, Accept: "application/json" } });
	} catch {
		throw new HttpError(502, "Discord could not be reached.");
	}
	const body = await response.json().catch(() => null) as { message?: unknown } | null;
	if (!response.ok) {
		const message = typeof body?.message === "string" ? body.message : "request failed";
		throw new HttpError(response.status === 401 ? 401 : 502, `Discord returned ${response.status}: ${message}`);
	}
	return body;
}

/** List guilds visible to the owner’s connected bot, for the channel-grant picker. */
discordRoutes.get("/guilds", async (c) => {
	const session = await requireUser(c);
	const data = await discordJson(await botToken(c.env, session.uid), "/users/@me/guilds");
	const guilds: DiscordGuild[] = Array.isArray(data)
		? data.flatMap((g) => {
			if (!g || typeof g !== "object") return [];
			const row = g as { id?: unknown; name?: unknown };
			return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [];
		})
		: [];
	return c.json({ guilds } satisfies DiscordGuildListResponse);
});

/** List only text channels the bot can see in one selected guild. */
discordRoutes.get("/guilds/:guildId/channels", async (c) => {
	const session = await requireUser(c);
	const guildId = requireSnowflake(c.req.param("guildId"), "guildId");
	const data = await discordJson(await botToken(c.env, session.uid), `/guilds/${guildId}/channels`);
	const channels: DiscordChannel[] = Array.isArray(data)
		? data.flatMap((channel) => {
			if (!channel || typeof channel !== "object") return [];
			const row = channel as { id?: unknown; name?: unknown; type?: unknown; guild_id?: unknown };
			return typeof row.id === "string" && typeof row.name === "string" && typeof row.type === "number" && TEXT_CHANNEL_TYPES.has(row.type)
				? [{ id: row.id, name: row.name, type: row.type, guildId: typeof row.guild_id === "string" ? row.guild_id : guildId }]
				: [];
		})
		: [];
	return c.json({ channels } satisfies DiscordChannelListResponse);
});

discordRoutes.get("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ grants: await listConnectorGrants(c.env, instanceId, session.uid, "discord") } satisfies DiscordGrantListResponse);
});

/**
 * Grant a text channel after asking Discord for its metadata with the owner’s bot token. The
 * caller supplies an id only to choose a channel in the picker; the verified metadata is what
 * becomes the durable grant.
 */
discordRoutes.post("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
	const refusal = await connectorRefusalFor(c.env, "discord", instanceId, session.uid, instance.config);
	if (refusal) throw new HttpError(403, refusal);
	const body = (await c.req.json().catch(() => ({}))) as { channelId?: string };
	const channelId = requireSnowflake(body.channelId, "channelId");
	const data = await discordJson(await botToken(c.env, session.uid), `/channels/${channelId}`);
	if (!data || typeof data !== "object") throw new HttpError(502, "Discord returned no channel metadata.");
	const channel = data as { id?: unknown; name?: unknown; type?: unknown; guild_id?: unknown };
	if (channel.id !== channelId || typeof channel.name !== "string" || typeof channel.type !== "number" || !TEXT_CHANNEL_TYPES.has(channel.type)) {
		throw new HttpError(400, "Grant a Discord text or announcement channel that the bot can access.");
	}
	const guildId = typeof channel.guild_id === "string" && SNOWFLAKE.test(channel.guild_id) ? channel.guild_id : null;
	const grant = await upsertConnectorGrant(c.env, instanceId, session.uid, {
		provider: "discord",
		resourceId: channelId,
		resourceName: clipMarked(`#${channel.name}`, 500, { within: true, what: "characters in Discord channel name" }),
		resourceType: "discord_channel",
		resourceUrl: guildId ? `https://discord.com/channels/${guildId}/${channelId}` : null,
	});
	return c.json({ grant } satisfies DiscordGrantResponse, 201);
});

discordRoutes.delete("/instances/:instanceId/grants/:grantId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await deleteConnectorGrant(c.env, instanceId, session.uid, "discord", c.req.param("grantId"));
	return c.json({ success: true });
});
