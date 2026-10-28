// Discord bot connector. A user supplies a bot token into the encrypted vault under
// provider "discord"; each instance is then granted individual text channels.  This is
// deliberately a bot integration, never automation of a normal Discord account.
import { listConnectorGrants } from "../connector-grants.js";
import { clipMarked } from "../clip-marked.js";
import { safeFetch } from "../ssrf.js";
import type { Connector, RegistryToolCtx, ToolDef } from "./types.js";

const API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{16,22}$/;
const MAX_MESSAGE_LENGTH = 2_000;

type DiscordReply = { ok: true; data: unknown } | { ok: false; status: number; message: string; /** Discord's own error code (50001 Missing Access, ...), when it sent one. */ code?: number };

/**
 * The two kinds of Discord channel grant (#1218), told apart by `resourceType`.
 *
 * `discord_channel` is the AGENT's grant: the channel its Discord tools may read and post in. Granting one
 * requires that the agent declares those tools. `discord_release_channel` is the PLATFORM's: the channel a
 * release note (#1216) is posted to. It needs no tools — a coder declares none — and the agent's tools can
 * never use it: {@link grantedChannel} refuses any grant that is not `discord_channel`, and the listing below
 * leaves it out. So giving a coder a release-notes channel gives it no Discord reach, now or if its owner
 * later declares the tools.
 */
export const DISCORD_AGENT_GRANT = "discord_channel";
export const DISCORD_RELEASE_GRANT = "discord_release_channel";

export const DISCORD_NOT_CONNECTED = "No Discord bot is connected. Connect one with the MCP tool connect_discord_bot, or in Profile → API Keys → Discord bot token.";

/**
 * One wording for a Discord refusal (#1132), shared by the agent's tools and the owner's setup
 * routes, with the status the platform answers with. Discord's 401 is NEVER passed on as a 401: it
 * means the STORED BOT TOKEN was reset or revoked, and a 401 from this API reads as "your PAGS session
 * expired" — the console signs the owner out on it.
 */
export function discordFailure(status: number, detail: string): { status: 403 | 404 | 409 | 429 | 502; message: string } {
	if (status === 401) return { status: 409, message: `Discord rejected the connected bot token — it was reset or revoked. Reconnect the bot with connect_discord_bot. (Discord: ${detail})` };
	if (status === 403) return { status: 403, message: `The bot lacks access or permission there. In Discord, give the bot's role View Channel, Read Message History and Send Messages on that channel. (Discord: ${detail})` };
	if (status === 404) return { status: 404, message: `Discord has no such server, channel or message visible to this bot. (Discord: ${detail})` };
	if (status === 429) return { status: 429, message: `Discord rate-limited the bot — retry shortly. (Discord: ${detail})` };
	return { status: 502, message: `Discord returned ${status}: ${detail}` };
}

function snowflake(value: unknown): string | null {
	const id = String(value ?? "").trim();
	return SNOWFLAKE.test(id) ? id : null;
}

async function grantedChannel(ctx: RegistryToolCtx, grantId: unknown): Promise<{ channelId: string } | { error: string }> {
	const id = String(grantId ?? "").trim();
	if (!id) return { error: "grantId is required. Use discord_list_granted_channels first." };
	if (!ctx.connectorClient) return { error: "Discord connector client is unavailable." };
	try {
		const grant = await ctx.connectorClient("discord").requireGrant(id);
		if (grant.resourceType === DISCORD_RELEASE_GRANT) return { error: "This Discord grant is reserved for release notes (the platform posts there); it is not a channel this agent can read or post in." };
		if (grant.resourceType !== DISCORD_AGENT_GRANT || !snowflake(grant.resourceId)) {
			return { error: "This Discord grant is not a text-channel grant." };
		}
		return { channelId: grant.resourceId };
	} catch (error) {
		const status = (error as { status?: unknown } | null)?.status;
		// requireGrant answers 403 for an unknown id — the grant was revoked, or never existed for THIS
		// instance. Say which to do next rather than a generic "not allowed".
		if (status === 403) return { error: `This agent holds no Discord grant "${id}" — it was revoked or belongs to another agent. Call discord_list_granted_channels for the current grants.` };
		return { error: error instanceof Error ? error.message : "This agent has not been granted that Discord channel." };
	}
}

async function botToken(ctx: RegistryToolCtx): Promise<string | null> {
	try {
		return (await ctx.connectorClient?.("discord").token()) || null;
	} catch {
		return null;
	}
}

async function discordRequest(token: string, path: string, init: RequestInit = {}): Promise<DiscordReply> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bot ${token}`);
	headers.set("Accept", "application/json");
	if (init.body) headers.set("Content-Type", "application/json");
	try {
		const res = await safeFetch(`${API}${path}`, { ...init, headers });
		const data = await res.json().catch(() => null) as { message?: unknown; code?: unknown } | null;
		if (!res.ok) {
			const detail = typeof data?.message === "string" ? data.message : "request failed";
			return { ok: false, status: res.status, message: discordFailure(res.status, detail).message, ...(typeof data?.code === "number" ? { code: data.code } : {}) };
		}
		return { ok: true, data };
	} catch {
		return { ok: false, status: 0, message: "Discord could not be reached." };
	}
}

/**
 * Post one message to a channel with the bot token — the agent's `discord_send_message` and the
 * platform's own release notes (#1216) send through this one path.
 *
 * With `replyToMessageId` (#1273) the message is a threaded reply to that message in the same channel (`message_reference`).
 * The reply never pings: `parse: []` already blocks every mention and `replied_user: false` turns off the reply's own ping to
 * the author. `fail_if_not_exists` makes a missing or deleted target an error, not a quiet plain channel message.
 */
export async function postDiscordMessage(token: string, channelId: string, content: string, replyToMessageId?: string): Promise<{ ok: true; messageId: string | null } | { ok: false; status: number; message: string }> {
	const result = await discordRequest(token, `/channels/${channelId}/messages`, {
		method: "POST",
		// Agents must name mentions deliberately in a later, reviewed capability. A plain send
		// cannot turn untrusted text into a mass ping.
		body: JSON.stringify(
			replyToMessageId
				? { content, allowed_mentions: { parse: [], replied_user: false }, message_reference: { message_id: replyToMessageId, channel_id: channelId, fail_if_not_exists: true } }
				: { content, allowed_mentions: { parse: [] } },
		),
	});
	if (!result.ok) return result;
	const id = (result.data as { id?: unknown } | null)?.id;
	return { ok: true, messageId: typeof id === "string" ? id : null };
}

const listGrantedChannels: ToolDef["handler"] = async (ctx) => {
	if (!ctx.instanceId || !ctx.userId) return { content: "Discord channel grants are available only from a subscribed agent instance.", success: false };
	// Only the AGENT's grants: a release-notes channel (#1218) is the platform's, not a channel to act in.
	const grants = (await listConnectorGrants(ctx.env, ctx.instanceId, ctx.userId, "discord")).filter((g) => g.resourceType === DISCORD_AGENT_GRANT);
	return {
		content: JSON.stringify({ channels: grants.map((g) => ({ grantId: g.id, channelId: g.resourceId, name: g.resourceName, url: g.resourceUrl ?? null })) }, null, 2),
		success: true,
	};
};

const readMessages: ToolDef["handler"] = async (ctx, input) => {
	const granted = await grantedChannel(ctx, input.grantId);
	if ("error" in granted) return { content: granted.error, success: false };
	const token = await botToken(ctx);
	if (!token) return { content: DISCORD_NOT_CONNECTED, success: false };
	const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || 20), 1), 50);
	const result = await discordRequest(token, `/channels/${granted.channelId}/messages?limit=${limit}`);
	if (!result.ok) return { content: result.message, success: false };
	// The shared tool-result cap applies after this; this local cap avoids spending an entire
	// model turn on a single verbose channel history.
	return { content: clipMarked(JSON.stringify(result.data, null, 2), 48_000, { within: true, what: "characters of Discord history" }), success: true };
};

const sendMessage: ToolDef["handler"] = async (ctx, input) => {
	const granted = await grantedChannel(ctx, input.grantId);
	if ("error" in granted) return { content: granted.error, success: false };
	const content = String(input.content ?? "").trim();
	if (!content) return { content: "content is required.", success: false };
	if (content.length > MAX_MESSAGE_LENGTH) return { content: `Discord messages are limited to ${MAX_MESSAGE_LENGTH} characters.`, success: false };
	// Optional: reply to one message in this channel. Only a string id counts: a JSON number past 2^53 has already lost digits and would name a different message. A malformed id is refused before the bot token is read.
	const raw = input.replyToMessageId;
	const replyTo = raw === undefined || raw === null || raw === "" ? null : typeof raw === "string" ? snowflake(raw) : null;
	if (raw !== undefined && raw !== null && raw !== "" && !replyTo) return { content: "replyToMessageId must be a Discord message id (a string of 16-22 digits).", success: false };
	const token = await botToken(ctx);
	if (!token) return { content: DISCORD_NOT_CONNECTED, success: false };
	const result = await postDiscordMessage(token, granted.channelId, content, replyTo ?? undefined);
	if (!result.ok) return { content: result.message, success: false };
	return { content: JSON.stringify({ sent: true, channelId: granted.channelId, messageId: result.messageId, ...(replyTo ? { repliedTo: replyTo } : {}) }, null, 2), success: true };
};

/** Emoji listed per message, and how many of them have their reacting users fetched: bounds the Discord calls one tool call can make (#1274). */
const MAX_REACTION_EMOJIS = 20;
const MAX_EMOJIS_WITH_USERS = 10;
const DEFAULT_USERS_PER_EMOJI = 25;
const MAX_USERS_PER_EMOJI = 200;
const USERS_PAGE = 100;

type ReactionSummary = { count: number; me: boolean; emoji: { id: string | null; name: string | null } };

/** The path segment Discord wants for an emoji: the character itself, or `name:id` for a custom one. */
const reactionPathEmoji = (e: ReactionSummary["emoji"]): string | null => (e.id ? `${e.name ?? "_"}:${e.id}` : e.name || null);

/**
 * Who reacted with one emoji, by Discord's GET reactions endpoint — paged with `after` until `want` users or the end.
 * Only ids, names and the bot flag are kept; a reacting user's other fields are not passed on.
 */
async function reactingUsers(token: string, channelId: string, messageId: string, emoji: string, want: number): Promise<{ users: Array<{ id: string; username: string | null; bot: boolean }>; error?: string }> {
	const users: Array<{ id: string; username: string | null; bot: boolean }> = [];
	let after = "";
	while (users.length < want) {
		const limit = Math.min(USERS_PAGE, want - users.length);
		const page = await discordRequest(token, `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=${limit}${after ? `&after=${after}` : ""}`);
		if (!page.ok) return { users, error: page.message };
		const batch = Array.isArray(page.data) ? (page.data as Array<{ id?: unknown; username?: unknown; bot?: unknown }>) : [];
		for (const u of batch) {
			const id = snowflake(u.id);
			if (id) users.push({ id, username: typeof u.username === "string" ? u.username : null, bot: u.bot === true });
		}
		const last = snowflake(batch.at(-1)?.id);
		if (batch.length < limit || !last) break;
		after = last;
	}
	return { users };
}

const readReactions: ToolDef["handler"] = async (ctx, input) => {
	const granted = await grantedChannel(ctx, input.grantId);
	if ("error" in granted) return { content: granted.error, success: false };
	const messageId = snowflake(input.messageId);
	if (typeof input.messageId !== "string" || !messageId) return { content: "messageId must be a Discord message id (a string of 16-22 digits).", success: false };
	const includeUsers = input.includeUsers !== false;
	const perEmoji = Math.min(Math.max(Math.trunc(Number(input.usersPerEmoji) || DEFAULT_USERS_PER_EMOJI), 1), MAX_USERS_PER_EMOJI);
	const token = await botToken(ctx);
	if (!token) return { content: DISCORD_NOT_CONNECTED, success: false };
	const message = await discordRequest(token, `/channels/${granted.channelId}/messages/${messageId}`);
	if (!message.ok) return { content: message.message, success: false };
	const all = ((message.data as { reactions?: unknown } | null)?.reactions ?? []) as ReactionSummary[];
	const listed = Array.isArray(all) ? all.slice(0, MAX_REACTION_EMOJIS) : [];
	const reactions = [];
	for (const [i, r] of listed.entries()) {
		const path = reactionPathEmoji(r.emoji ?? { id: null, name: null });
		const row: Record<string, unknown> = { emoji: path, custom: !!r.emoji?.id, count: Number(r.count) || 0, botReacted: r.me === true };
		if (includeUsers && path && i < MAX_EMOJIS_WITH_USERS) {
			const who = await reactingUsers(token, granted.channelId, messageId, path, Math.min(perEmoji, Number(r.count) || perEmoji));
			row.users = who.users;
			row.usersComplete = !who.error && who.users.length >= (Number(r.count) || 0);
			if (who.error) row.usersError = who.error;
		}
		reactions.push(row);
	}
	return {
		content: JSON.stringify({ channelId: granted.channelId, messageId, reactions, emojiCount: all.length, ...(all.length > listed.length ? { emojiOmitted: all.length - listed.length } : {}), ...(includeUsers && listed.length > MAX_EMOJIS_WITH_USERS ? { usersOmittedAfterEmoji: MAX_EMOJIS_WITH_USERS } : {}) }, null, 2),
		success: true,
	};
};

const addReaction: ToolDef["handler"] = async (ctx, input) => {
	const granted = await grantedChannel(ctx, input.grantId);
	if ("error" in granted) return { content: granted.error, success: false };
	const messageId = snowflake(input.messageId);
	const emoji = String(input.emoji ?? "").trim();
	if (!messageId || !emoji || emoji.length > 128) return { content: "A Discord messageId and emoji are required.", success: false };
	const token = await botToken(ctx);
	if (!token) return { content: DISCORD_NOT_CONNECTED, success: false };
	const result = await discordRequest(token, `/channels/${granted.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: "PUT" });
	return result.ok
		? { content: JSON.stringify({ reacted: true, channelId: granted.channelId, messageId, emoji }), success: true }
		: { content: result.message, success: false };
};

// ── members of one server (#1387) ───────────────────────────────────────────────────────────────────────────────────────────────────
const DEFAULT_MEMBERS = 100;
const MAX_MEMBERS = 1_000;
const MAX_ROLES_LOOKUPS = 5;

/** What the owner must do when Discord will not list members. Shown for any 403 from the members endpoint, which is how a missing intent surfaces. */
export const DISCORD_MEMBERS_INTENT_HELP =
	"Discord would not list this server's members. The bot needs the privileged Server Members Intent: in the Discord Developer Portal open the application, then Bot, then Privileged Gateway Intents, turn on SERVER MEMBERS INTENT and save. (If it is already on, the bot is not in this server or lacks access to it.)";

/** The servers (guild ids) this instance may list: those holding one of its OWN granted channels — never a guild the owner's bot is merely in. */
async function grantedGuilds(ctx: RegistryToolCtx, token: string): Promise<Set<string>> {
	const guilds = new Set<string>();
	if (!ctx.instanceId || !ctx.userId) return guilds;
	const grants = (await listConnectorGrants(ctx.env, ctx.instanceId, ctx.userId, "discord")).filter((g) => g.resourceType === DISCORD_AGENT_GRANT);
	let lookups = 0;
	for (const g of grants) {
		const fromUrl = /^https:\/\/discord\.com\/channels\/(\d{16,22})\/\d{16,22}$/.exec(g.resourceUrl ?? "")?.[1];
		if (fromUrl) {
			guilds.add(fromUrl);
			continue;
		}
		// A grant made before its URL was recorded: ask Discord which server the channel is in, a few times at most.
		const channel = snowflake(g.resourceId);
		if (!channel || lookups++ >= MAX_ROLES_LOOKUPS) continue;
		const found = await discordRequest(token, `/channels/${channel}`);
		const guildId = found.ok ? snowflake((found.data as { guild_id?: unknown } | null)?.guild_id) : null;
		if (guildId) guilds.add(guildId);
	}
	return guilds;
}

const listMembers: ToolDef["handler"] = async (ctx, input) => {
	if (!ctx.instanceId || !ctx.userId) return { content: "Discord members are available only from a subscribed agent instance.", success: false };
	const guildId = snowflake(input.guildId);
	if (typeof input.guildId !== "string" || !guildId) return { content: "guildId must be a Discord server id (a string of 16-22 digits). The server of one of this agent's granted channels is in discord_list_granted_channels (url).", success: false };
	let after = "";
	if (input.after !== undefined && input.after !== null && input.after !== "") {
		const a = typeof input.after === "string" ? snowflake(input.after) : null;
		if (!a) return { content: "after must be a Discord user id (the next_after of the previous page).", success: false };
		after = a;
	}
	const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || DEFAULT_MEMBERS), 1), MAX_MEMBERS);
	const token = await botToken(ctx);
	if (!token) return { content: DISCORD_NOT_CONNECTED, success: false };
	// Authorization: only a server that holds a channel this instance was granted. The owner's bot may be in many more.
	if (!(await grantedGuilds(ctx, token)).has(guildId)) {
		return { content: `This agent holds no Discord channel grant in server ${guildId}, so it may not list that server's members. Grant one of its channels to this agent first (grant_instance_discord_channel).`, success: false };
	}
	const page = await discordRequest(token, `/guilds/${guildId}/members?limit=${limit}${after ? `&after=${after}` : ""}`);
	if (!page.ok) return { content: page.status === 403 ? DISCORD_MEMBERS_INTENT_HELP : page.message, success: false };
	// Role names, when the bot can read them; the ids are returned either way.
	const rolesReply = await discordRequest(token, `/guilds/${guildId}/roles`);
	const roleNames = new Map<string, string>();
	if (rolesReply.ok && Array.isArray(rolesReply.data)) for (const r of rolesReply.data as Array<{ id?: unknown; name?: unknown }>) if (typeof r.id === "string" && typeof r.name === "string") roleNames.set(r.id, r.name);
	const raw = Array.isArray(page.data) ? (page.data as Array<{ user?: { id?: unknown; username?: unknown; global_name?: unknown; bot?: unknown }; nick?: unknown; roles?: unknown; joined_at?: unknown }>) : [];
	const members = raw.flatMap((m) => {
		const id = snowflake(m.user?.id);
		if (!id) return [];
		const roleIds = Array.isArray(m.roles) ? m.roles.filter((r): r is string => typeof r === "string") : [];
		// Only these fields are passed on: avatar, flags, email and the rest of what Discord sends stay behind.
		return [
			{
				userId: id,
				username: typeof m.user?.username === "string" ? m.user.username : null,
				globalName: typeof m.user?.global_name === "string" ? m.user.global_name : null,
				nick: typeof m.nick === "string" ? m.nick : null,
				bot: m.user?.bot === true,
				roleIds,
				roles: roleIds.map((r) => roleNames.get(r) ?? null),
				joinedAt: typeof m.joined_at === "string" ? m.joined_at : null,
			},
		];
	});
	// Discord pages members by ascending user id: a full page may have more after it, a short one is the end.
	const last = members.at(-1)?.userId ?? null;
	return { content: JSON.stringify({ guildId, next_after: raw.length >= limit && last ? last : null, count: members.length, members }, null, 2), success: true };
};

export const DISCORD_CONNECTOR: Connector = {
	id: "discord",
	label: "Discord bot",
	auth: "token",
	scopes: { read: true, write: true },
	writeMeaning: "Send messages (optionally as a threaded reply to a message) and add reactions as the Discord bot you connected, but only in the channels you granted to this agent. Messages cannot be unsent through this connector.",
	grantModel: "instance-resource",
	tools: [
		{
			name: "discord_list_granted_channels",
			description: "List the Discord text channels this agent has been granted. Use the returned grantId for Discord reads and writes.",
			jsonSchema: { type: "object", properties: {} },
			tier: "connector",
			connector: "discord",
			scope: "read",
			mutates: false,
			untrustedOutput: false,
			handler: listGrantedChannels,
		},
		{
			name: "discord_read_messages",
			description: "Read up to 50 recent messages from one Discord channel explicitly granted to this agent.",
			jsonSchema: { type: "object", properties: { grantId: { type: "string" }, limit: { type: "number" } }, required: ["grantId"] },
			tier: "connector",
			connector: "discord",
			scope: "read",
			mutates: false,
			untrustedOutput: true,
			handler: readMessages,
		},
		{
			name: "discord_read_reactions",
			description: "Read the reactions on ONE message in a Discord channel explicitly granted to this agent: each emoji, its count, whether the bot reacted, and (includeUsers, default true) the users who reacted — up to usersPerEmoji each (default 25, max 200), for the first 10 emoji. Take messageId from discord_read_messages. Read-only.",
			jsonSchema: { type: "object", properties: { grantId: { type: "string" }, messageId: { type: "string" }, includeUsers: { type: "boolean" }, usersPerEmoji: { type: "number" } }, required: ["grantId", "messageId"] },
			tier: "connector",
			connector: "discord",
			scope: "read",
			mutates: false,
			untrustedOutput: true,
			handler: readReactions,
		},
		{
			name: "discord_list_members",
			description: "List the members of ONE Discord server (guildId) in which this agent holds a granted channel: user id, username, global name, server nick, bot flag, role ids and role names, and joined_at. Pages of up to 1000 (limit, default 100) in ascending user-id order; pass the returned next_after as `after` for the next page (null means that was the last). Needs the bot's Server Members Intent switched on in the Discord Developer Portal; the error says so when it is not. Read-only.",
			jsonSchema: { type: "object", properties: { guildId: { type: "string", description: "The server id; see the url of a channel in discord_list_granted_channels (discord.com/channels/<guildId>/<channelId>)." }, limit: { type: "number" }, after: { type: "string", description: "Optional. The next_after of the previous page." } }, required: ["guildId"] },
			tier: "connector",
			connector: "discord",
			scope: "read",
			mutates: false,
			untrustedOutput: true,
			handler: listMembers,
		},
		{
			name: "discord_send_message",
			description: "Send one message as the connected Discord bot to a channel explicitly granted to this agent. Pass replyToMessageId (a message id from discord_read_messages, in the same channel) to post it as a threaded reply to that message instead of a plain channel message; the reply does not ping its author. Mentions are disabled for safety. WRITE — the message is really sent.",
			jsonSchema: { type: "object", properties: { grantId: { type: "string" }, content: { type: "string" }, replyToMessageId: { type: "string", description: "Optional. Id of a message in this channel to reply to." } }, required: ["grantId", "content"] },
			tier: "connector",
			connector: "discord",
			scope: "write",
			mutates: true,
			untrustedOutput: true,
			handler: sendMessage,
		},
		{
			name: "discord_add_reaction",
			description: "Add one reaction as the connected Discord bot to a message in a channel explicitly granted to this agent. WRITE — the reaction is really added.",
			jsonSchema: { type: "object", properties: { grantId: { type: "string" }, messageId: { type: "string" }, emoji: { type: "string" } }, required: ["grantId", "messageId", "emoji"] },
			tier: "connector",
			connector: "discord",
			scope: "write",
			mutates: true,
			untrustedOutput: true,
			handler: addReaction,
		},
	],
};
