// What a Discord grant reaches. Shared by the agent's Discord tools (discord.ts) and the search (discord-search.ts), so neither
// imports the other. No import from discord.ts: that file builds the connector from these.
import { safeFetch } from "../ssrf.js";

export const API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{16,22}$/;
/** GUILD_TEXT and GUILD_ANNOUNCEMENT: the channel types the grants and the agent's Discord tools deal in. */
export const TEXT_CHANNEL_TYPES = new Set([0, 5]);

/**
 * The kinds of Discord grant, told apart by `resourceType`.
 *
 * `discord_channel` is the AGENT's grant on one channel (its Discord tools may read and post there).
 * `discord_guild` (#1703) is the agent's grant on a whole SERVER: every text channel of it that the bot can see, including ones
 * created after the grant. Nothing is stored per channel; the channel is checked against the server when it is used.
 * `discord_release_channel` is the PLATFORM's, for release notes (#1218): the agent's tools refuse and never list it.
 */
export const DISCORD_AGENT_GRANT = "discord_channel";
export const DISCORD_GUILD_GRANT = "discord_guild";
export const DISCORD_RELEASE_GRANT = "discord_release_channel";

export function snowflake(value: unknown): string | null {
	const id = String(value ?? "").trim();
	return SNOWFLAKE.test(id) ? id : null;
}

/** The server id in a channel grant's url (`https://discord.com/channels/<guild>/<channel>`), when it was recorded. */
export function guildOfGrantUrl(url: string | null | undefined): string | null {
	return /^https:\/\/discord\.com\/channels\/(\d{16,22})\/\d{16,22}$/.exec(url ?? "")?.[1] ?? null;
}

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

export type DiscordGetResult =
	| { ok: true; data: unknown; headers: Headers }
	| { ok: false; status: number; message: string; headers: Headers | null; /** Seconds Discord asked us to wait (a 429). */ retryAfter?: number };

/** One bot GET, keeping the response headers (the search reads Discord's rate-limit ones). */
export async function discordGet(token: string, path: string): Promise<DiscordGetResult> {
	try {
		const res = await safeFetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}`, Accept: "application/json" } });
		const data = (await res.json().catch(() => null)) as { message?: unknown; retry_after?: unknown } | null;
		if (res.ok) return { ok: true, data, headers: res.headers };
		const detail = typeof data?.message === "string" ? data.message : "request failed";
		const retryAfter = res.status === 429 ? Number(data?.retry_after ?? res.headers.get("Retry-After")) : Number.NaN;
		return { ok: false, status: res.status, message: discordFailure(res.status, detail).message, headers: res.headers, ...(Number.isFinite(retryAfter) ? { retryAfter } : {}) };
	} catch {
		return { ok: false, status: 0, message: "Discord could not be reached.", headers: null };
	}
}

export interface GuildChannel {
	id: string;
	name: string;
	category?: string;
}

/** The text and announcement channels of one server the bot can see, with their category names. */
export async function guildTextChannels(token: string, guildId: string): Promise<{ ok: true; channels: GuildChannel[] } | { ok: false; message: string }> {
	const res = await discordGet(token, `/guilds/${guildId}/channels`);
	if (!res.ok) return { ok: false, message: res.message };
	const rows = (Array.isArray(res.data) ? res.data : []).filter((r): r is { id?: unknown; name?: unknown; type?: unknown; parent_id?: unknown } => !!r && typeof r === "object");
	const categories = new Map(rows.flatMap((r) => (r.type === 4 && typeof r.id === "string" && typeof r.name === "string" ? [[r.id, r.name] as const] : [])));
	const channels = rows.flatMap((r): GuildChannel[] => {
		if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.type !== "number" || !TEXT_CHANNEL_TYPES.has(r.type)) return [];
		const category = typeof r.parent_id === "string" ? categories.get(r.parent_id) : undefined;
		return [{ id: r.id, name: r.name, ...(category ? { category } : {}) }];
	});
	return { ok: true, channels };
}
