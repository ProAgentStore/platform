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

type DiscordReply = { ok: true; data: unknown } | { ok: false; status: number; message: string };

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
		const data = await res.json().catch(() => null) as { message?: unknown } | null;
		if (!res.ok) {
			const detail = typeof data?.message === "string" ? data.message : "request failed";
			return { ok: false, status: res.status, message: discordFailure(res.status, detail).message };
		}
		return { ok: true, data };
	} catch {
		return { ok: false, status: 0, message: "Discord could not be reached." };
	}
}

/**
 * Post one message to a channel with the bot token — the agent's `discord_send_message` and the
 * platform's own release notes (#1216) send through this one path.
 */
export async function postDiscordMessage(token: string, channelId: string, content: string): Promise<{ ok: true; messageId: string | null } | { ok: false; status: number; message: string }> {
	const result = await discordRequest(token, `/channels/${channelId}/messages`, {
		method: "POST",
		// Agents must name mentions deliberately in a later, reviewed capability. A plain send
		// cannot turn untrusted text into a mass ping.
		body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
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
	const token = await botToken(ctx);
	if (!token) return { content: DISCORD_NOT_CONNECTED, success: false };
	const result = await postDiscordMessage(token, granted.channelId, content);
	if (!result.ok) return { content: result.message, success: false };
	return { content: JSON.stringify({ sent: true, channelId: granted.channelId, messageId: result.messageId }, null, 2), success: true };
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

export const DISCORD_CONNECTOR: Connector = {
	id: "discord",
	label: "Discord bot",
	auth: "token",
	scopes: { read: true, write: true },
	writeMeaning: "Send messages and add reactions as the Discord bot you connected, but only in the channels you granted to this agent. Messages cannot be unsent through this connector.",
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
			name: "discord_send_message",
			description: "Send one message as the connected Discord bot to a channel explicitly granted to this agent. Mentions are disabled for safety. WRITE — the message is really sent.",
			jsonSchema: { type: "object", properties: { grantId: { type: "string" }, content: { type: "string" } }, required: ["grantId", "content"] },
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
