// Discord bot connection and per-instance channel grants.
//
// A bot token is an account-level credential. A channel grant is a separate, instance-level
// boundary, so connecting a bot never lets every subscribed agent read or post everywhere it can.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { clipMarked } from "../lib/clip-marked.js";
import { connectorGrantReach, deleteConnectorGrant, listConnectorGrants, revokeUserConnectorGrants, upsertConnectorGrant } from "../lib/connector-grants.js";
import { connectorClient } from "../lib/connectors/client.js";
import { DISCORD_AGENT_GRANT, DISCORD_NOT_CONNECTED, DISCORD_RELEASE_GRANT, discordFailure } from "../lib/connectors/discord.js";
import { logEvent } from "../lib/events.js";
import { hasUserProviderKey, upsertUserProviderKey } from "../lib/user-api-key-store.js";
import { connectorRefusalFor } from "../lib/instance-connector-access.js";
import { safeFetch } from "../lib/ssrf.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { DiscordBot, DiscordBotConnectResponse, DiscordBotDisconnectResponse, DiscordBotStatusResponse, DiscordChannel, DiscordChannelListResponse, DiscordGrantListResponse, DiscordGrantResponse, DiscordGuild, DiscordGuildListResponse } from "../agent-types.js";

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
	if (!(await hasUserProviderKey(env, userId, "discord"))) throw new HttpError(409, DISCORD_NOT_CONNECTED);
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
		const failure = discordFailure(response.status, typeof body?.message === "string" ? body.message : "request failed");
		throw new HttpError(failure.status, failure.message);
	}
	return body;
}

/** Who a token authenticates as. Only a BOT account is accepted: this connector never drives a person's account. */
async function botIdentity(token: string): Promise<DiscordBot> {
	const me = (await discordJson(token, "/users/@me")) as { id?: unknown; username?: unknown; bot?: unknown } | null;
	if (typeof me?.id !== "string" || typeof me.username !== "string") throw new HttpError(502, "Discord returned no bot identity.");
	if (me.bot !== true) throw new HttpError(400, "That token is not a Discord BOT token. Create a bot under your application at https://discord.com/developers/applications and use its token.");
	return { id: me.id, username: me.username };
}

/** The lifecycle audit row (#1132): ids and names only — never the token, never message content. */
const audit = (env: Env, uid: string, event: string, message: string, context: Record<string, unknown>, instanceId?: string) =>
	logEvent(env, { source: "discord", event, level: "info", message, userId: uid, instanceId, context });

/**
 * The connected bot: whether one is connected, and — checked live against Discord — whether its token
 * still works and who it is. Never the token. `reach` is how many channel grants depend on it.
 */
discordRoutes.get("/bot", async (c) => {
	const session = await requireUser(c);
	const reach = await connectorGrantReach(c.env, session.uid, "discord");
	if (!(await hasUserProviderKey(c.env, session.uid, "discord"))) {
		return c.json({ connected: false, valid: false, bot: null, reach } satisfies DiscordBotStatusResponse);
	}
	try {
		const bot = await botIdentity(await botToken(c.env, session.uid));
		return c.json({ connected: true, valid: true, bot, reach } satisfies DiscordBotStatusResponse);
	} catch (e) {
		if (!(e instanceof HttpError)) throw e;
		return c.json({ connected: true, valid: false, bot: null, error: e.message, reach } satisfies DiscordBotStatusResponse);
	}
});

/**
 * Connect or rotate the bot token. The token is checked against Discord BEFORE it is stored, so a
 * typo or a user token is refused instead of saved. The response names the bot, never the token.
 *
 * A rotation to a DIFFERENT bot — or from one whose identity can no longer be read — revokes every
 * Discord channel grant: the owner approved those channels for one bot, and a different bot can hold
 * different powers there (the #357 rule: a credential change must not silently re-arm old grants).
 */
discordRoutes.put("/bot", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
	const token = typeof body.token === "string" ? body.token.trim().replace(/^Bot\s+/i, "") : "";
	if (!token || token.length > 512 || /\s/.test(token)) throw new HttpError(400, "token must be one Discord bot token.");
	const bot = await botIdentity(token).catch((e: unknown) => {
		// Discord's 401 here is about the token being OFFERED, not one already stored.
		if (e instanceof HttpError && e.status === 409) throw new HttpError(400, "Discord rejected that token (401). Copy the bot token again from the Developer Portal → Bot → Reset Token.");
		throw e;
	});
	const had = await hasUserProviderKey(c.env, session.uid, "discord");
	let previous: DiscordBot | null = null;
	if (had) previous = await botIdentity(await botToken(c.env, session.uid)).catch(() => null);
	const changed = had && previous?.id !== bot.id;
	const revoked = changed ? await revokeUserConnectorGrants(c.env, session.uid, "discord") : { grants: 0, instances: 0 };
	await upsertUserProviderKey(c.env, session.uid, "discord", token);
	const event = !had ? "discord.bot_connect" : changed ? "discord.bot_replace" : "discord.bot_rotate";
	await audit(c.env, session.uid, event, `${had ? (changed ? "Replaced" : "Rotated") : "Connected"} Discord bot ${bot.username}`, { botId: bot.id, previousBotId: previous?.id ?? null, revokedGrants: revoked.grants });
	return c.json({ connected: true, rotated: had, bot, revoked } satisfies DiscordBotConnectResponse, had ? 200 : 201);
});

/** Disconnect: the token AND every Discord channel grant, on every agent (#357). Grants go first. */
discordRoutes.delete("/bot", async (c) => {
	const session = await requireUser(c);
	const revoked = await revokeUserConnectorGrants(c.env, session.uid, "discord");
	const res = await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = 'discord'").bind(session.uid).run();
	const disconnected = (res.meta?.changes ?? 0) > 0;
	if (disconnected || revoked.grants > 0) await audit(c.env, session.uid, "discord.bot_disconnect", "Disconnected the Discord bot", { revokedGrants: revoked.grants, revokedInstances: revoked.instances });
	return c.json({ disconnected, revoked } satisfies DiscordBotDisconnectResponse);
});

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
 *
 * `purpose` (#1218) says what the grant is FOR:
 *   - `agent` (the default): the channel the agent's Discord tools may read and post in. The agent must
 *     declare those tools, or the grant is refused — unchanged.
 *   - `release_notes`: the channel the PLATFORM posts a release note to (#1216). A coder declares no
 *     Discord tools, so the check above would refuse it; this purpose skips THAT check and nothing else
 *     (ownership, the connected bot and Discord's own view of the channel all still apply). The grant is
 *     stored as `discord_release_channel`, which the agent's tools refuse and do not list, so it gives the
 *     agent no reach. Asking for it on a channel the agent already holds returns that grant as it is —
 *     never a downgrade of the agent's access.
 */
discordRoutes.post("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { channelId?: string; purpose?: unknown };
	if (body.purpose !== undefined && body.purpose !== "agent" && body.purpose !== "release_notes") {
		throw new HttpError(400, 'purpose must be "agent" (the default: a channel the agent\'s Discord tools may use) or "release_notes" (a channel the platform posts release notes to).');
	}
	const forReleaseNotes = body.purpose === "release_notes";
	if (!forReleaseNotes) {
		const refusal = await connectorRefusalFor(c.env, "discord", instanceId, session.uid, instance.config);
		if (refusal) throw new HttpError(403, refusal);
	}
	const channelId = requireSnowflake(body.channelId, "channelId");
	const data = await discordJson(await botToken(c.env, session.uid), `/channels/${channelId}`);
	if (!data || typeof data !== "object") throw new HttpError(502, "Discord returned no channel metadata.");
	const channel = data as { id?: unknown; name?: unknown; type?: unknown; guild_id?: unknown };
	if (channel.id !== channelId || typeof channel.name !== "string" || typeof channel.type !== "number" || !TEXT_CHANNEL_TYPES.has(channel.type)) {
		throw new HttpError(400, "Grant a Discord text or announcement channel that the bot can access.");
	}
	const guildId = typeof channel.guild_id === "string" && SNOWFLAKE.test(channel.guild_id) ? channel.guild_id : null;
	const existing = (await listConnectorGrants(c.env, instanceId, session.uid, "discord")).find((g) => g.resourceId === channelId);
	if (forReleaseNotes && existing?.resourceType === DISCORD_AGENT_GRANT) {
		// The agent already holds this channel, and release notes read every Discord grant: nothing to add,
		// and converting it would take the agent's access away.
		return c.json({ grant: existing, note: "This channel is already granted to the agent, which includes release notes — nothing was changed." } satisfies DiscordGrantResponse, 200);
	}
	const resourceType = forReleaseNotes ? DISCORD_RELEASE_GRANT : DISCORD_AGENT_GRANT;
	const grant = await upsertConnectorGrant(c.env, instanceId, session.uid, {
		provider: "discord",
		resourceId: channelId,
		resourceName: clipMarked(`#${channel.name}`, 500, { within: true, what: "characters in Discord channel name" }),
		resourceType,
		resourceUrl: guildId ? `https://discord.com/channels/${guildId}/${channelId}` : null,
	});
	// A re-grant of a release-notes channel as the agent's own (an owner who has since given it the tools) upgrades
	// the same grant, so that is worth a line too.
	if (!existing || existing.resourceType !== resourceType) {
		await audit(c.env, session.uid, "discord.grant", `Granted Discord channel ${grant.resourceName}${forReleaseNotes ? " for release notes" : ""}`, { grantId: grant.id, channelId, guildId, purpose: forReleaseNotes ? "release_notes" : "agent" }, instanceId);
	}
	// Granting a channel twice returns the SAME grant id: the id is the stable handle the agent holds.
	return c.json({ grant } satisfies DiscordGrantResponse, existing ? 200 : 201);
});

discordRoutes.delete("/instances/:instanceId/grants/:grantId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const grantId = c.req.param("grantId");
	if (!(await deleteConnectorGrant(c.env, instanceId, session.uid, "discord", grantId))) {
		throw new HttpError(404, `This instance holds no Discord grant "${grantId}" — it was already revoked, or belongs to another instance.`);
	}
	await audit(c.env, session.uid, "discord.revoke", "Revoked a Discord channel grant", { grantId }, instanceId);
	return c.json({ success: true });
});
