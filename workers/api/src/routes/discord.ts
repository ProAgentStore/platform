// Discord bot connection and per-instance channel grants.
//
// A bot token is an account-level credential. A channel grant is a separate, instance-level
// boundary, so connecting a bot never lets every subscribed agent read or post everywhere it can.
import { requireReleaseNotesEligible } from "../lib/release-notes-eligibility.js";
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { clipMarked } from "../lib/clip-marked.js";
import { connectorGrantReach, deleteConnectorGrant, listConnectorGrants, revokeUserConnectorGrants, revokeUserConnectorResourceGrants, upsertConnectorGrant } from "../lib/connector-grants.js";
import { connectorClient } from "../lib/connectors/client.js";
import { DISCORD_AGENT_GRANT, DISCORD_NOT_CONNECTED, DISCORD_RELEASE_GRANT, discordFailure } from "../lib/connectors/discord.js";
import { logEvent } from "../lib/events.js";
import { hasUserProviderKey, upsertUserProviderKey } from "../lib/user-api-key-store.js";
import { connectorRefusalFor } from "../lib/instance-connector-access.js";
import { safeFetch } from "../lib/ssrf.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { DiscordBot, DiscordBotConnectResponse, DiscordBotDisconnectResponse, DiscordBotStatusResponse, DiscordChannel, DiscordChannelDeleteResponse, DiscordChannelListResponse, DiscordGrantListResponse, DiscordGrantResponse, DiscordGuild, DiscordGuildListResponse, DiscordManagedChannel, DiscordManagedChannelResponse, DiscordChannelAccessEntry, DiscordChannelAccessResponse, DiscordMember, DiscordMemberAccessResponse, DiscordMemberListResponse } from "../agent-types.js";

export const discordRoutes = new Hono<{ Bindings: Env }>();

const API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{16,22}$/;
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT
const CATEGORY_CHANNEL_TYPE = 4; // GUILD_CATEGORY

function requireSnowflake(value: string | undefined, label: string): string {
	const id = value?.trim() ?? "";
	if (!SNOWFLAKE.test(id)) throw new HttpError(400, `${label} must be a Discord snowflake.`);
	return id;
}

async function botToken(env: Env, userId: string): Promise<string> {
	if (!(await hasUserProviderKey(env, userId, "discord"))) throw new HttpError(409, DISCORD_NOT_CONNECTED);
	return connectorClient(env, "discord", { userId }).token();
}

async function discordJson(token: string, path: string, init: { method?: string; body?: unknown; reason?: string } = {}): Promise<unknown> {
	let response: Response;
	const headers: Record<string, string> = { Authorization: `Bot ${token}`, Accept: "application/json" };
	if (init.body !== undefined) headers["Content-Type"] = "application/json";
	// Shown in the server's own audit log, so a human there can see which tool made the change.
	if (init.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(init.reason);
	try {
		response = await safeFetch(`${API}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
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
	const rows = (Array.isArray(data) ? data : []).filter((channel): channel is { id?: unknown; name?: unknown; type?: unknown; guild_id?: unknown; parent_id?: unknown } => !!channel && typeof channel === "object");
	// #1413: same-named channels (#ideas under several categories) are told apart by their category.
	const categories = new Map(rows.flatMap((row) => (row.type === CATEGORY_CHANNEL_TYPE && typeof row.id === "string" && typeof row.name === "string" ? [[row.id, row.name] as const] : [])));
	const channels: DiscordChannel[] = rows.flatMap((row) => {
		if (!(typeof row.id === "string" && typeof row.name === "string" && typeof row.type === "number" && TEXT_CHANNEL_TYPES.has(row.type))) return [];
		const category = typeof row.parent_id === "string" ? categories.get(row.parent_id) : undefined;
		return [{ id: row.id, name: row.name, type: row.type, guildId: typeof row.guild_id === "string" ? row.guild_id : guildId, ...(category ? { category } : {}) }];
	});
	return c.json({ channels } satisfies DiscordChannelListResponse);
});

// ── Channel management by the owner's bot (#1625) ───────────────────────────────────────────────────────────
// Owner-only, like the rest of this file: the owner's session acts with the owner's own bot, in a server
// that bot is in. Discord enforces the bot's Manage Channels permission; a refusal says to grant it.

const MANAGE_CHANNELS_HELP = "The bot lacks the Manage Channels permission there. In Discord, open Server Settings → Roles, pick the bot's role and turn on Manage Channels (or grant it on the category).";
const CHANNEL_NAME_MAX = 100;
const TOPIC_MAX = 1024;

/** A Discord call that manages channels: a 403 is about Manage Channels, not about reading or sending. */
async function manageJson(token: string, path: string, init: { method: string; body?: unknown; reason: string }): Promise<unknown> {
	try {
		return await discordJson(token, path, init);
	} catch (e) {
		if (e instanceof HttpError && e.status === 403) throw new HttpError(403, MANAGE_CHANNELS_HELP);
		throw e;
	}
}

function channelName(value: unknown): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!name || name.length > CHANNEL_NAME_MAX) throw new HttpError(400, `name must be 1-${CHANNEL_NAME_MAX} characters.`);
	return name;
}

function channelTopic(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length > TOPIC_MAX) throw new HttpError(400, `topic must be text of at most ${TOPIC_MAX} characters.`);
	return value;
}

/**
 * The category a channel goes under: `categoryId`, or `category` by name (case-insensitive) among the server's
 * categories. Neither → undefined (leave as is); `categoryId: ""` or `category: ""` → null (no category).
 * A name that matches none, or several, is refused rather than guessed.
 */
async function resolveCategory(token: string, guildId: string, body: { categoryId?: unknown; category?: unknown }): Promise<string | null | undefined> {
	if (body.categoryId === "" || body.category === "") return null;
	if (body.categoryId !== undefined && body.categoryId !== null) return requireSnowflake(String(body.categoryId), "categoryId");
	if (body.category === undefined || body.category === null) return undefined;
	if (typeof body.category !== "string") throw new HttpError(400, "category must be a category name.");
	const wanted = body.category.trim().toLowerCase();
	const rows = await discordJson(token, `/guilds/${guildId}/channels`);
	const matches = (Array.isArray(rows) ? rows : []).filter((r): r is { id: string; name: string } => !!r && typeof r === "object" && (r as { type?: unknown }).type === CATEGORY_CHANNEL_TYPE && typeof (r as { name?: unknown }).name === "string" && (r as { name: string }).name.trim().toLowerCase() === wanted && typeof (r as { id?: unknown }).id === "string");
	if (matches.length === 0) throw new HttpError(404, `No category named "${body.category}" in this server. list_discord_channels shows each channel's category.`);
	if (matches.length > 1) throw new HttpError(409, `Several categories are named "${body.category}"; pass categoryId instead (${matches.map((m) => m.id).join(", ")}).`);
	return matches[0].id;
}

type ChannelRow = { id?: unknown; name?: unknown; type?: unknown; guild_id?: unknown; parent_id?: unknown; topic?: unknown };

/** The channel as this API reports it: id, name, type, server, category id and topic. */
function channelView(row: ChannelRow, fallbackGuild?: string): DiscordManagedChannel {
	return {
		id: String(row.id ?? ""),
		name: String(row.name ?? ""),
		type: typeof row.type === "number" ? row.type : -1,
		guildId: typeof row.guild_id === "string" ? row.guild_id : (fallbackGuild ?? ""),
		categoryId: typeof row.parent_id === "string" ? row.parent_id : null,
		topic: typeof row.topic === "string" ? row.topic : null,
	};
}

/** A channel in a server (not a DM or thread); management is refused for anything else. */
async function guildChannel(token: string, channelId: string): Promise<DiscordManagedChannel> {
	const view = channelView((await discordJson(token, `/channels/${channelId}`)) as ChannelRow);
	if (!SNOWFLAKE.test(view.guildId) || view.id !== channelId) throw new HttpError(400, "That is not a channel in a Discord server.");
	return view;
}

/** Create a text channel (or, with `type: "category"`, a category) in one server the bot is in. */
discordRoutes.post("/guilds/:guildId/channels", async (c) => {
	const session = await requireUser(c);
	const guildId = requireSnowflake(c.req.param("guildId"), "guildId");
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; topic?: unknown; categoryId?: unknown; category?: unknown; type?: unknown };
	if (body.type !== undefined && body.type !== "text" && body.type !== "category") throw new HttpError(400, 'type must be "text" (the default) or "category".');
	const isCategory = body.type === "category";
	const name = channelName(body.name);
	const topic = channelTopic(body.topic);
	if (isCategory && (topic !== undefined || body.categoryId !== undefined || body.category !== undefined)) throw new HttpError(400, "A category takes only a name.");
	const token = await botToken(c.env, session.uid);
	const parentId = isCategory ? undefined : await resolveCategory(token, guildId, body);
	const created = (await manageJson(token, `/guilds/${guildId}/channels`, {
		method: "POST",
		reason: "ProAgentStore: create_discord_channel",
		body: { name, type: isCategory ? CATEGORY_CHANNEL_TYPE : 0, ...(topic !== undefined ? { topic } : {}), ...(parentId ? { parent_id: parentId } : {}) },
	})) as ChannelRow;
	const channel = channelView(created, guildId);
	await audit(c.env, session.uid, "discord.channel_create", `Created Discord ${isCategory ? "category" : "channel"} #${channel.name}`, { guildId, channelId: channel.id, categoryId: channel.categoryId });
	return c.json({ channel } satisfies DiscordManagedChannelResponse, 201);
});

/** Rename a channel, change its topic, or move it to another category (or out of one). */
discordRoutes.patch("/channels/:channelId", async (c) => {
	const session = await requireUser(c);
	const channelId = requireSnowflake(c.req.param("channelId"), "channelId");
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; topic?: unknown; categoryId?: unknown; category?: unknown };
	const token = await botToken(c.env, session.uid);
	const before = await guildChannel(token, channelId);
	const patch: Record<string, unknown> = {};
	if (body.name !== undefined) patch.name = channelName(body.name);
	const topic = channelTopic(body.topic);
	if (topic !== undefined) patch.topic = topic;
	const parentId = await resolveCategory(token, before.guildId, body);
	if (parentId !== undefined) patch.parent_id = parentId;
	if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to change: pass name, topic, categoryId or category.");
	const updated = channelView((await manageJson(token, `/channels/${channelId}`, { method: "PATCH", reason: "ProAgentStore: update_discord_channel", body: patch })) as ChannelRow, before.guildId);
	// A rename is mirrored onto this owner's grants, so list_instance_discord_grants shows the new name.
	if (updated.name && updated.name !== before.name) {
		await c.env.DB.prepare("UPDATE instance_connector_grants SET resource_name = ?1 WHERE user_id = ?2 AND provider = 'discord' AND resource_id = ?3").bind(`#${updated.name}`, session.uid, channelId).run();
	}
	await audit(c.env, session.uid, "discord.channel_update", `Updated Discord channel #${updated.name}`, { guildId: before.guildId, channelId, changed: Object.keys(patch) });
	return c.json({ channel: updated, previous: before } satisfies DiscordManagedChannelResponse);
});

/**
 * Delete a channel (or an empty category). Every grant of it, on every one of this owner's instances, goes in
 * the same step — a grant of a channel that no longer exists would only fail later. Not recoverable in Discord.
 */
discordRoutes.delete("/channels/:channelId", async (c) => {
	const session = await requireUser(c);
	const channelId = requireSnowflake(c.req.param("channelId"), "channelId");
	const token = await botToken(c.env, session.uid);
	const channel = await guildChannel(token, channelId);
	await manageJson(token, `/channels/${channelId}`, { method: "DELETE", reason: "ProAgentStore: delete_discord_channel" });
	const revokedGrants = await revokeUserConnectorResourceGrants(c.env, session.uid, "discord", channelId);
	await audit(c.env, session.uid, "discord.channel_delete", `Deleted Discord channel #${channel.name}`, { guildId: channel.guildId, channelId, revokedGrants });
	return c.json({ deleted: true, channel, revokedGrants } satisfies DiscordChannelDeleteResponse);
});

// ── Members and who can see a channel (#1633) ───────────────────────────────────────────────────────────────
// Creating a channel (#1625) lets nobody new in: a private check-in channel is useless until its person can see it.

const MEMBERS_INTENT_HELP = "Discord refused the member list. In the Developer Portal open your application → Bot and turn on Server Members Intent (a privileged intent), then retry.";
const MANAGE_PERMISSIONS_HELP = "The bot cannot change who can see that channel. In Discord give the bot's role Manage Roles (shown as Manage Permissions on a channel or category), or Administrator, and make sure the bot can itself see the channel.";
/** What a member overwrite lets a person do: View Channel, Send Messages, Read Message History, Add Reactions, Attach Files, Embed Links. */
const MEMBER_ALLOW = (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 6n) | (1n << 15n) | (1n << 14n);
const VIEW_CHANNEL = 1n << 10n;

type MemberRow = { user?: { id?: unknown; username?: unknown; global_name?: unknown; bot?: unknown }; nick?: unknown };

function memberView(row: MemberRow): DiscordMember | null {
	const u = row?.user;
	if (!u || typeof u.id !== "string" || typeof u.username !== "string") return null;
	return { id: u.id, username: u.username, globalName: typeof u.global_name === "string" ? u.global_name : null, nick: typeof row.nick === "string" ? row.nick : null, bot: u.bot === true };
}

/** One member of the server, or a 404 that says they are not in it. */
async function guildMember(token: string, guildId: string, userId: string): Promise<DiscordMember> {
	const row = await discordJson(token, `/guilds/${guildId}/members/${userId}`).catch((e: unknown) => {
		if (e instanceof HttpError && e.status === 404) throw new HttpError(404, `Discord user ${userId} is not a member of this server. They must join it before they can be given a channel.`);
		throw e;
	});
	const member = memberView(row as MemberRow);
	if (!member) throw new HttpError(502, "Discord returned no member.");
	return member;
}

/** Members of one server: everyone (up to `limit`, after `after`), or those whose username or nickname starts with `query`. */
discordRoutes.get("/guilds/:guildId/members", async (c) => {
	const session = await requireUser(c);
	const guildId = requireSnowflake(c.req.param("guildId"), "guildId");
	const query = c.req.query("query")?.trim() ?? "";
	if (query.length > 100) throw new HttpError(400, "query must be at most 100 characters.");
	const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 1000) || 1000, 1), 1000);
	const after = c.req.query("after");
	const path = query
		? `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=${limit}`
		: `/guilds/${guildId}/members?limit=${limit}${after ? `&after=${requireSnowflake(after, "after")}` : ""}`;
	const data = await discordJson(await botToken(c.env, session.uid), path).catch((e: unknown) => {
		if (e instanceof HttpError && e.status === 403) throw new HttpError(403, MEMBERS_INTENT_HELP);
		throw e;
	});
	const members = (Array.isArray(data) ? data : []).flatMap((row) => memberView(row as MemberRow) ?? []);
	return c.json({ members } satisfies DiscordMemberListResponse);
});

/** Who can see a channel: its permission overwrites, @everyone, roles and members, with names. */
discordRoutes.get("/channels/:channelId/access", async (c) => {
	const session = await requireUser(c);
	const channelId = requireSnowflake(c.req.param("channelId"), "channelId");
	const token = await botToken(c.env, session.uid);
	const row = (await discordJson(token, `/channels/${channelId}`)) as ChannelRow & { permission_overwrites?: unknown };
	const channel = channelView(row);
	if (!SNOWFLAKE.test(channel.guildId) || channel.id !== channelId) throw new HttpError(400, "That is not a channel in a Discord server.");
	const overwrites = (Array.isArray(row.permission_overwrites) ? row.permission_overwrites : []) as { id?: unknown; type?: unknown; allow?: unknown; deny?: unknown }[];
	const roles = overwrites.some((o) => o.type === 0) ? ((await discordJson(token, `/guilds/${channel.guildId}/roles`)) as { id?: unknown; name?: unknown }[]) : [];
	const roleNames = new Map((Array.isArray(roles) ? roles : []).flatMap((r) => (typeof r.id === "string" && typeof r.name === "string" ? [[r.id, r.name] as const] : [])));
	const access: DiscordChannelAccessEntry[] = [];
	for (const o of overwrites) {
		if (typeof o.id !== "string") continue;
		const allow = String(o.allow ?? "0");
		const deny = String(o.deny ?? "0");
		const view = (BigInt(allow) & VIEW_CHANNEL) !== 0n ? "allow" : (BigInt(deny) & VIEW_CHANNEL) !== 0n ? "deny" : "inherit";
		if (o.type === 1) {
			const member = await guildMember(token, channel.guildId, o.id).catch(() => null);
			access.push({ id: o.id, kind: "member", name: member?.username ?? null, view, allow, deny });
		} else {
			const everyone = o.id === channel.guildId;
			access.push({ id: o.id, kind: everyone ? "everyone" : "role", name: everyone ? "@everyone" : (roleNames.get(o.id) ?? null), view, allow, deny });
		}
	}
	return c.json({ channel, access } satisfies DiscordChannelAccessResponse);
});

/**
 * Let one server member see and post in a channel (`access: "grant"`), or take that member overwrite away
 * (`"remove"`). Only the member's own overwrite changes; roles and @everyone are left as they are.
 */
discordRoutes.put("/channels/:channelId/members/:userId", async (c) => {
	const session = await requireUser(c);
	const channelId = requireSnowflake(c.req.param("channelId"), "channelId");
	const userId = requireSnowflake(c.req.param("userId"), "userId");
	const body = (await c.req.json().catch(() => ({}))) as { access?: unknown };
	if (body.access !== "grant" && body.access !== "remove") throw new HttpError(400, 'access must be "grant" or "remove".');
	const token = await botToken(c.env, session.uid);
	const channel = await guildChannel(token, channelId);
	const member = await guildMember(token, channel.guildId, userId);
	const reason = `ProAgentStore: set_discord_channel_member_access ${body.access}`;
	const change = body.access === "grant"
		? { method: "PUT", body: { type: 1, allow: MEMBER_ALLOW.toString(), deny: "0" }, reason }
		: { method: "DELETE", reason };
	await discordJson(token, `/channels/${channelId}/permissions/${userId}`, change).catch((e: unknown) => {
		if (e instanceof HttpError && e.status === 403) throw new HttpError(403, MANAGE_PERMISSIONS_HELP);
		throw e;
	});
	const access = body.access === "grant" ? "granted" : "removed";
	await audit(c.env, session.uid, `discord.member_access_${body.access}`, `${access === "granted" ? "Gave" : "Removed"} ${member.username} access to Discord channel #${channel.name}`, { guildId: channel.guildId, channelId, memberId: userId });
	return c.json({ channel, member, access } satisfies DiscordMemberAccessResponse);
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
	if (forReleaseNotes) await requireReleaseNotesEligible(c.env, instanceId, session.uid); // #1286: only a coder has release notes
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
