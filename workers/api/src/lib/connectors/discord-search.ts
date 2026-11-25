// discord_search_messages (#1704): find messages by author, mention or text across the channels granted to ONE instance.
//
// Discord's own message-search endpoint is not open to bot tokens, so this scans recent history channel by channel with the
// bot's read access. It is read-only and reaches only what the instance was granted: its channel grants, and every text
// channel of a server it holds a server grant on (#1703). Release-notes grants are never searched.
//
// The cost is bounded three ways, and a search that hit a bound SAYS so (`truncated`, with the reason and how far back it got):
//   - at most MAX_CHANNELS channels (the rest are counted in `channelsNotSearched`);
//   - at most MAX_REQUESTS Discord calls (a page of up to 100 messages, or a server's channel list);
//   - Discord's rate limits are honoured: a 429 waits the `retry_after` it names, within a total wait budget, and a search
//     that is still limited stops and says `rate_limited` rather than hammering.
//
// Order and paging. Message ids are time-ordered snowflakes, so "older than id X" means the same in every channel. A hit is
// only returned once every channel that could still hold a newer one has been scanned back past it, so the list is truly
// newest first, never "newest of what happened to be fetched". `cursor` is such an id: the next call continues older than it.
import { listConnectorGrants } from "../connector-grants.js";
import { clipMarked } from "../clip-marked.js";
import { DISCORD_AGENT_GRANT, DISCORD_GUILD_GRANT, type DiscordGetResult, discordGet, guildOfGrantUrl, guildTextChannels, snowflake } from "./discord-reach.js";
import type { RegistryToolCtx, ToolDef } from "./types.js";

const MAX_CHANNELS = 120;
const MAX_REQUESTS = 200;
const PAGE_SIZE = 100;
const CONCURRENCY = 6;
/** Longest single wait for a 429, and the most time one search spends waiting in total. */
const MAX_WAIT_MS = 3_000;
const WAIT_BUDGET_MS = 8_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CONTENT_MAX = 1_500;
const DISCORD_EPOCH = 1_420_070_400_000n;
const NOT_CONNECTED = "No Discord bot is connected. Connect one with the MCP tool connect_discord_bot, or in Profile → API Keys → Discord bot token.";

/** Snowflakes of different length compare by length first, then digit by digit: no BigInt needed to order two ids. */
const cmpId = (a: string, b: string): number => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
const idToIso = (id: string): string => new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
const msToId = (ms: number): string => String((BigInt(Math.max(0, Math.trunc(ms))) - DISCORD_EPOCH) << 22n);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RawMessage {
	id?: unknown;
	timestamp?: unknown;
	content?: unknown;
	author?: { id?: unknown; username?: unknown; global_name?: unknown; bot?: unknown };
	mentions?: Array<{ id?: unknown; username?: unknown; global_name?: unknown }>;
	attachments?: unknown;
	message_reference?: { message_id?: unknown };
}

interface Target {
	id: string;
	name: string;
	guildId: string | null;
	category?: string;
}

interface ScanState {
	target: Target;
	/** The oldest message id fetched so far; null until the first page. */
	floor: string | null;
	done: boolean;
}

interface Hit {
	channelId: string;
	channelName: string;
	category?: string;
	messageId: string;
	url: string | null;
	author: { id: string | null; username: string | null; globalName: string | null; bot: boolean };
	timestamp: string | null;
	content: string;
	mentions: Array<{ id: string; username: string | null }>;
	attachments?: number;
	replyToMessageId?: string;
}

interface Filters {
	authorId: string | null;
	authorName: string | null;
	mentionsId: string | null;
	mentionsName: string | null;
	text: string | null;
	sinceMs: number | null;
}

const lower = (v: unknown): string => String(v ?? "").toLowerCase();
const bareName = (v: string): string => v.trim().replace(/^@/, "").toLowerCase();

function matches(m: RawMessage, f: Filters): boolean {
	const content = typeof m.content === "string" ? m.content : "";
	if (f.authorId && m.author?.id !== f.authorId) return false;
	if (f.authorName && lower(m.author?.username) !== f.authorName && lower(m.author?.global_name) !== f.authorName) return false;
	const mentions = Array.isArray(m.mentions) ? m.mentions : [];
	if (f.mentionsId && !mentions.some((u) => u.id === f.mentionsId) && !content.includes(`<@${f.mentionsId}>`) && !content.includes(`<@!${f.mentionsId}>`)) return false;
	if (f.mentionsName && !mentions.some((u) => lower(u.username) === f.mentionsName || lower(u.global_name) === f.mentionsName) && !content.toLowerCase().includes(`@${f.mentionsName}`)) return false;
	if (f.text && !content.toLowerCase().includes(f.text)) return false;
	return true;
}

function toHit(m: RawMessage, t: Target): Hit | null {
	const messageId = snowflake(m.id);
	if (!messageId) return null;
	const mentions = (Array.isArray(m.mentions) ? m.mentions : []).flatMap((u) => {
		const id = snowflake(u.id);
		return id ? [{ id, username: typeof u.username === "string" ? u.username : null }] : [];
	});
	const reply = snowflake(m.message_reference?.message_id);
	const attachments = Array.isArray(m.attachments) ? m.attachments.length : 0;
	return {
		channelId: t.id,
		channelName: t.name,
		...(t.category ? { category: t.category } : {}),
		messageId,
		url: t.guildId ? `https://discord.com/channels/${t.guildId}/${t.id}/${messageId}` : null,
		author: { id: snowflake(m.author?.id), username: typeof m.author?.username === "string" ? m.author.username : null, globalName: typeof m.author?.global_name === "string" ? m.author.global_name : null, bot: m.author?.bot === true },
		timestamp: typeof m.timestamp === "string" ? m.timestamp : null,
		content: clipMarked(typeof m.content === "string" ? m.content : "", CONTENT_MAX, { within: true, what: "characters of this message" }),
		mentions,
		...(attachments ? { attachments } : {}),
		...(reply ? { replyToMessageId: reply } : {}),
	};
}

function optionalString(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v.trim() : null;
}

function parseTime(v: unknown, field: string): { ms: number | null } | { error: string } {
	if (v === undefined || v === null || v === "") return { ms: null };
	const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
	return Number.isFinite(ms) ? { ms } : { error: `${field} must be an ISO 8601 date or time, e.g. 2026-11-25 or 2026-11-25T09:00:00Z.` };
}

export const searchMessages: ToolDef["handler"] = async (ctx: RegistryToolCtx, input) => {
	if (!ctx.instanceId || !ctx.userId) return { content: "Discord search is available only from a subscribed agent instance.", success: false };
	const fail = (content: string) => ({ content, success: false as const });

	// ── input, all checked before the bot token is read or Discord is called ──
	const idField = (field: string): { id: string | null } | { error: string } => {
		const v = input[field];
		if (v === undefined || v === null || v === "") return { id: null };
		const id = typeof v === "string" ? snowflake(v) : null;
		return id ? { id } : { error: `${field} must be a Discord id (a string of 16-22 digits).` };
	};
	const authorId = idField("authorId");
	if ("error" in authorId) return fail(authorId.error);
	const mentionsId = idField("mentionsUserId");
	if ("error" in mentionsId) return fail(mentionsId.error);
	const guildFilter = idField("guildId");
	if ("error" in guildFilter) return fail(guildFilter.error);
	const cursor = idField("cursor");
	if ("error" in cursor) return fail(`cursor must be the cursor of the previous page. ${cursor.error}`);
	const since = parseTime(input.since, "since");
	if ("error" in since) return fail(since.error);
	const until = parseTime(input.until, "until");
	if ("error" in until) return fail(until.error);
	let grantIds: string[] | null = null;
	if (input.grantIds !== undefined && input.grantIds !== null) {
		if (!Array.isArray(input.grantIds) || input.grantIds.some((g) => typeof g !== "string" || !g.trim())) return fail("grantIds must be an array of grant ids from discord_list_granted_channels.");
		grantIds = input.grantIds as string[];
	}
	const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
	const filters: Filters = {
		authorId: authorId.id,
		authorName: optionalString(input.authorUsername) ? bareName(String(input.authorUsername)) : null,
		mentionsId: mentionsId.id,
		mentionsName: optionalString(input.mentionsUsername) ? bareName(String(input.mentionsUsername)) : null,
		text: optionalString(input.text)?.toLowerCase() ?? null,
		sinceMs: since.ms,
	};

	let token: string | null = null;
	try {
		token = (await ctx.connectorClient?.("discord").token()) || null;
	} catch {
		token = null;
	}
	if (!token) return fail(NOT_CONNECTED);

	// ── which channels: only the instance's own grants ──
	const all = await listConnectorGrants(ctx.env, ctx.instanceId, ctx.userId, "discord");
	let usable = all.filter((g) => g.resourceType === DISCORD_AGENT_GRANT || g.resourceType === DISCORD_GUILD_GRANT);
	if (grantIds) {
		const wanted = new Set(grantIds.map((g) => g.trim()));
		const unknown = [...wanted].filter((id) => !usable.some((g) => g.id === id));
		if (unknown.length) return fail(`This agent holds no searchable Discord grant ${unknown.map((u) => `"${u}"`).join(", ")} — it was revoked, belongs to another agent or is reserved for release notes. Call discord_list_granted_channels for the current grants.`);
		usable = usable.filter((g) => wanted.has(g.id));
	}
	if (usable.length === 0) return fail("This agent has no Discord channel or server grant to search. Grant one with grant_instance_discord_channel.");

	const notes: string[] = [];
	let requests = 0;
	const targets = new Map<string, Target>();
	const addTarget = (t: Target) => {
		if (!targets.has(t.id)) targets.set(t.id, t);
	};
	for (const g of usable) {
		if (g.resourceType === DISCORD_AGENT_GRANT) {
			const guildId = guildOfGrantUrl(g.resourceUrl);
			if (guildFilter.id && guildId !== guildFilter.id) continue;
			addTarget({ id: g.resourceId, name: g.resourceName.replace(/^#/, ""), guildId });
		} else {
			if (guildFilter.id && g.resourceId !== guildFilter.id) continue;
			requests++;
			const live = await guildTextChannels(token, g.resourceId);
			if (!live.ok) {
				notes.push(`Could not list the channels of server ${g.resourceId} (${g.resourceName}): ${live.message}`);
				continue;
			}
			for (const c of live.channels) addTarget({ id: c.id, name: c.name, guildId: g.resourceId, ...(c.category ? { category: c.category } : {}) });
		}
	}
	const everyTarget = [...targets.values()];
	const channelsNotSearched = Math.max(0, everyTarget.length - MAX_CHANNELS);
	const states: ScanState[] = everyTarget.slice(0, MAX_CHANNELS).map((target) => ({ target, floor: null, done: false }));
	if (states.length === 0) return fail(`No granted channel matches${guildFilter.id ? ` server ${guildFilter.id}` : ""}. ${notes.join(" ")}`.trim());

	// Start older than the cursor and, with `until`, older than that time: snowflakes are time-ordered, so one `before` does both.
	let startBefore: string | null = cursor.id;
	if (until.ms !== null) {
		const untilId = msToId(until.ms + 1);
		if (!startBefore || cmpId(untilId, startBefore) < 0) startBefore = untilId;
	}

	// ── scan ──
	const hits: Hit[] = [];
	const unreadable: Array<{ channelId: string; channel: string; reason: string }> = [];
	let messagesScanned = 0;
	let waitedMs = 0;
	// An object, not a `let`: the workers below set it from closures, which control-flow narrowing cannot see.
	const halt: { why: "request_budget" | "rate_limited" | "discord_unreachable" | null } = { why: null };

	const fetchPage = async (s: ScanState): Promise<DiscordGetResult> => {
		const before = s.floor ?? startBefore;
		const path = `/channels/${s.target.id}/messages?limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`;
		for (let attempt = 0; ; attempt++) {
			requests++;
			const res = await discordGet(token as string, path);
			if (res.ok) {
				// A bucket with nothing left: wait out its reset before the next call to it, rather than earn a 429.
				if (res.headers.get("X-RateLimit-Remaining") === "0") {
					const reset = Number(res.headers.get("X-RateLimit-Reset-After"));
					if (Number.isFinite(reset) && reset > 0 && waitedMs + reset * 1000 <= WAIT_BUDGET_MS) {
						waitedMs += reset * 1000;
						await sleep(Math.min(reset * 1000, MAX_WAIT_MS));
					}
				}
				return res;
			}
			if (res.status !== 429 || attempt >= 2) return res;
			const wait = Math.max(0, (res.retryAfter ?? 1) * 1000);
			if (wait > MAX_WAIT_MS || waitedMs + wait > WAIT_BUDGET_MS || requests >= MAX_REQUESTS) return res;
			waitedMs += wait;
			await sleep(wait);
		}
	};

	const scanOne = async (s: ScanState): Promise<void> => {
		const res = await fetchPage(s);
		if (!res.ok) {
			if (res.status === 429) halt.why = "rate_limited";
			else if (res.status === 0) halt.why = "discord_unreachable";
			else {
				// This channel only: the bot lost sight of it, or it is gone. The rest of the search carries on.
				s.done = true;
				unreadable.push({ channelId: s.target.id, channel: s.target.name, reason: res.status === 403 ? "the bot cannot read it (View Channel / Read Message History)" : res.status === 404 ? "it no longer exists" : res.message });
			}
			return;
		}
		const page = (Array.isArray(res.data) ? res.data : []) as RawMessage[];
		let oldestMs: number | null = null;
		for (const m of page) {
			messagesScanned++;
			const ts = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : Number.NaN;
			if (Number.isFinite(ts)) oldestMs = ts;
			if (filters.sinceMs !== null && Number.isFinite(ts) && ts < filters.sinceMs) continue;
			if (!matches(m, filters)) continue;
			const hit = toHit(m, s.target);
			if (hit) hits.push(hit);
		}
		const last = snowflake(page.at(-1)?.id);
		if (page.length < PAGE_SIZE || !last) s.done = true;
		else s.floor = last;
		if (filters.sinceMs !== null && oldestMs !== null && oldestMs < filters.sinceMs) s.done = true;
	};

	const runBatch = async (batch: ScanState[]) => {
		let next = 0;
		const worker = async () => {
			while (next < batch.length && !halt.why) {
				const s = batch[next++] as ScanState;
				await scanOne(s);
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
	};

	for (;;) {
		hits.sort((a, b) => cmpId(b.messageId, a.messageId));
		const need = hits.length >= limit ? (hits[limit - 1] as Hit).messageId : null;
		// A channel blocks the answer while it could still hold a message newer than the limit-th hit (or any hit, short of limit).
		const blockers = states.filter((s) => !s.done && (s.floor === null || need === null || cmpId(s.floor, need) > 0));
		if (blockers.length === 0 || halt.why) break;
		const room = MAX_REQUESTS - requests;
		if (room <= 0) {
			halt.why = "request_budget";
			break;
		}
		await runBatch(blockers.slice(0, room));
		if (!halt.why && blockers.length > room) halt.why = "request_budget";
	}
	// A bound hit while a channel was still unscanned is a truncation even if the loop ended normally.
	const active = states.filter((s) => !s.done);
	const neverScanned = active.some((s) => s.floor === null);
	// The newest point some channel has not been scanned past: only hits at or newer than it are certain to be the newest.
	const safeFloor = neverScanned ? null : active.reduce<string | null>((top, s) => (top === null || (s.floor !== null && cmpId(s.floor, top) > 0) ? s.floor : top), null);
	// With nothing left to scan every hit is certain; otherwise only those at or newer than safeFloor (the limit-th hit is, when the loop ended normally).
	const certain = active.length === 0 ? hits : safeFloor === null ? [] : hits.filter((h) => cmpId(h.messageId, safeFloor) >= 0);
	const returned = certain.slice(0, limit);
	const more = certain.length > limit || active.length > 0;
	const nextCursor = !more ? null : returned.length >= limit ? (returned.at(-1) as Hit).messageId : safeFloor ?? cursor.id;
	const truncated = halt.why !== null || channelsNotSearched > 0;
	const reasons: string[] = [];
	if (halt.why === "request_budget") reasons.push(`it reached its limit of ${MAX_REQUESTS} Discord calls`);
	if (halt.why === "rate_limited") reasons.push("Discord rate-limited the bot and the wait budget ran out");
	if (halt.why === "discord_unreachable") reasons.push("Discord could not be reached");
	if (channelsNotSearched > 0) reasons.push(`${channelsNotSearched} of ${everyTarget.length} granted channels were not searched (the limit is ${MAX_CHANNELS} per search — narrow with guildId or grantIds)`);

	const out = {
		hits: returned,
		count: returned.length,
		nextCursor,
		truncated,
		...(truncated ? { truncatedBecause: `The search was cut short: ${reasons.join("; ")}.${nextCursor ? " Pass nextCursor as cursor to continue." : ""}` } : {}),
		...(safeFloor && active.length > 0 ? { searchedBackTo: idToIso(safeFloor), note: "Everything newer than searchedBackTo was searched in every channel; older messages were not." } : {}),
		searched: { channels: states.length, channelsNotSearched, discordCalls: requests, messagesScanned },
		...(unreadable.length ? { unreadableChannels: unreadable } : {}),
		...(notes.length ? { notes } : {}),
	};
	return { content: JSON.stringify(out, null, 2), success: true };
};
