/**
 * #1704 and #1703: `discord_search_messages` and the whole-server grant. Discord is a stubbed fetch; grants are a stubbed lookup.
 * What matters: only granted channels are touched and only with GET, filters combine, results are truly newest first across channels,
 * and a search that hit a bound says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorGrant } from "../connector-grants.js";
import type { RegistryToolCtx } from "./types.js";

const grants = vi.fn<() => Promise<ConnectorGrant[]>>();
vi.mock("../connector-grants.js", async () => {
	const actual = await vi.importActual<typeof import("../connector-grants.js")>("../connector-grants.js");
	return { ...actual, listConnectorGrants: () => grants() };
});
const { DISCORD_CONNECTOR } = await import("./discord.js");

const GUILD = "900000000000000001";
const OTHER_GUILD = "900000000000000002";
const CH_A = "100000000000000001";
const CH_B = "100000000000000002";
const CH_NEW = "100000000000000003";
const CH_UNGRANTED = "100000000000000009";
const SERGE = "700000000000000001";
const TOMAS = "700000000000000002";

const grant = (over: Partial<ConnectorGrant>): ConnectorGrant => ({
	id: "g1",
	instanceId: "i1",
	userId: "u1",
	provider: "discord",
	resourceId: CH_A,
	resourceName: "#alpha",
	resourceType: "discord_channel",
	resourceUrl: `https://discord.com/channels/${GUILD}/${CH_A}`,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...over,
});
const guildGrant = grant({ id: "gg", resourceId: GUILD, resourceName: "Server: FAS", resourceType: "discord_guild", resourceUrl: `https://discord.com/channels/${GUILD}` });

const search = DISCORD_CONNECTOR.tools.find((t) => t.name === "discord_search_messages");
if (!search) throw new Error("missing discord_search_messages");
const ctx = (): RegistryToolCtx => ({
	env: {} as RegistryToolCtx["env"],
	instanceId: "i1",
	userId: "u1",
	connectorClient: () => ({ token: async () => "bot-secret", requireGrant: async () => grant({}), fetch: async () => new Response(), connector: DISCORD_CONNECTOR }),
});

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let seq = 0;
/** A message id whose snowflake time is `minute` minutes after 2026-11-25T00:00Z: ids order the same way as time. */
const mid = (minute: number) => String((BigInt(Date.UTC(2026, 10, 25) + minute * 60_000) - 1_420_070_400_000n) << 22n) .replace(/$/, "");
const msg = (minute: number, over: Record<string, unknown> = {}) => ({
	id: mid(minute) + "",
	timestamp: new Date(Date.UTC(2026, 10, 25) + minute * 60_000).toISOString(),
	content: `message ${++seq}`,
	author: { id: SERGE, username: "serge888", global_name: "Serge" },
	mentions: [],
	attachments: [],
	...over,
});
const toTomas = { mentions: [{ id: TOMAS, username: "tommenson", global_name: "Tomas" }], content: `<@${TOMAS}> are you in?` };

type Out = { hits: Array<{ channelId: string; channelName: string; messageId: string; url: string | null; content: string; author: { username: string | null } }>; nextCursor: string | null; truncated: boolean; truncatedBecause?: string; searched: { channels: number; channelsNotSearched: number; discordCalls: number }; unreadableChannels?: unknown[]; searchedBackTo?: string };
const out = (r: { content: string }) => JSON.parse(r.content) as Out;

/** A fake Discord: channel id → messages newest first. Honours `before` and `limit`, like the real endpoint. */
function discord(channels: Record<string, unknown[]>, extra?: (url: string) => Response | undefined) {
	const calls: string[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		const special = extra?.(url);
		if (special) return special;
		const guildChannels = /\/guilds\/(\d+)\/channels$/.exec(url);
		if (guildChannels) {
			return reply([{ id: "500000000000000001", name: "Projects", type: 4 }, ...Object.keys(channels).map((id) => ({ id, name: `chan-${id.slice(-1)}`, type: 0, parent_id: "500000000000000001" }))]);
		}
		const m = /\/channels\/(\d+)\/messages\?limit=(\d+)(?:&before=(\d+))?/.exec(url);
		if (!m) return reply({ message: "Unknown" }, 404);
		const rows = channels[m[1] as string];
		if (!rows) return reply({ message: "Missing Access" }, 403);
		const before = m[3];
		const older = (rows as Array<{ id: string }>).filter((r) => !before || (r.id.length !== before.length ? r.id.length < before.length : r.id < before));
		return reply(older.slice(0, Number(m[2])));
	});
	vi.stubGlobal("fetch", fetch);
	return { fetch, calls };
}

beforeEach(() => {
	seq = 0;
	grants.mockResolvedValue([grant({})]);
});
afterEach(() => vi.unstubAllGlobals());

describe("discord_search_messages (#1704)", () => {
	it("is a read-only, untrusted-output tool and says a bot cannot read DMs", () => {
		expect(search).toMatchObject({ connector: "discord", scope: "read", mutates: false, untrustedOutput: true });
		expect(search.description).toMatch(/direct messages/i);
	});

	it("finds the one message by author + mention across channels with a link and no raw Discord object", async () => {
		grants.mockResolvedValue([grant({}), grant({ id: "g2", resourceId: CH_B, resourceName: "#fit-food-app", resourceUrl: `https://discord.com/channels/${GUILD}/${CH_B}` })]);
		const target = msg(30, toTomas);
		discord({
			[CH_A]: [msg(50, { author: { id: TOMAS, username: "tommenson" } }), msg(10)],
			[CH_B]: [msg(40, { mentions: toTomas.mentions, author: { id: TOMAS, username: "tommenson" } }), target, msg(5)],
		});
		const res = out(await search.handler(ctx(), { authorUsername: "serge888", mentionsUsername: "tommenson", limit: 1 }));
		expect(res.hits).toHaveLength(1);
		expect(res.hits[0]).toMatchObject({ channelId: CH_B, channelName: "fit-food-app", messageId: target.id, url: `https://discord.com/channels/${GUILD}/${CH_B}/${target.id}`, author: { username: "serge888" } });
		expect(JSON.stringify(res.hits[0])).not.toContain("global_name");
		expect(res.truncated).toBe(false);
	});

	it("returns hits newest first across channels, never the newest of what one channel happened to hold", async () => {
		grants.mockResolvedValue([grant({}), grant({ id: "g2", resourceId: CH_B, resourceName: "#beta", resourceUrl: null })]);
		discord({ [CH_A]: [msg(20, { content: "hello a" }), msg(10, { content: "hello a2" })], [CH_B]: [msg(30, { content: "hello b" }), msg(15, { content: "hello b2" })] });
		const res = out(await search.handler(ctx(), { text: "HELLO" }));
		expect(res.hits.map((h) => h.content)).toEqual(["hello b", "hello a", "hello b2", "hello a2"]);
		expect(res.hits.find((h) => h.channelId === CH_B)?.url).toBeNull();
	});

	it("pages with the cursor: the next call returns the older hits, nothing twice", async () => {
		discord({ [CH_A]: [msg(40), msg(30), msg(20), msg(10)] });
		const first = out(await search.handler(ctx(), { limit: 2 }));
		expect(first.hits).toHaveLength(2);
		expect(first.nextCursor).toBe(first.hits[1]?.messageId);
		const second = out(await search.handler(ctx(), { limit: 2, cursor: first.nextCursor }));
		expect(second.hits.map((h) => h.messageId)).toEqual([mid(20), mid(10)]);
		expect(second.nextCursor).toBeNull();
	});

	it("matches a mention by user id and by the <@id> tag in the content, and an author by id", async () => {
		discord({ [CH_A]: [msg(30, { content: `ping <@!${TOMAS}>` }), msg(20, { mentions: [{ id: TOMAS, username: "x" }] }), msg(10, { author: { id: TOMAS, username: "t" } })] });
		expect(out(await search.handler(ctx(), { mentionsUserId: TOMAS })).hits).toHaveLength(2);
		expect(out(await search.handler(ctx(), { authorId: TOMAS })).hits.map((h) => h.messageId)).toEqual([mid(10)]);
	});

	it("since and until bound the window and stop the scan early", async () => {
		discord({ [CH_A]: [msg(300), msg(200), msg(100), msg(5)] });
		const res = out(await search.handler(ctx(), { since: new Date(Date.UTC(2026, 10, 25, 0, 50)).toISOString(), until: new Date(Date.UTC(2026, 10, 25, 4, 0)).toISOString() }));
		expect(res.hits.map((h) => h.messageId)).toEqual([mid(200), mid(100)]);
	});

	it("searches only granted channels with GET: an ungranted channel is never requested, release-notes grants are skipped", async () => {
		grants.mockResolvedValue([grant({}), grant({ id: "g3", resourceId: CH_UNGRANTED, resourceName: "#releases", resourceType: "discord_release_channel" })]);
		const { calls } = discord({ [CH_A]: [msg(10)], [CH_UNGRANTED]: [msg(20)] });
		const res = out(await search.handler(ctx(), {}));
		expect(res.hits.map((h) => h.channelId)).toEqual([CH_A]);
		expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
		expect(calls.some((c) => c.includes(CH_UNGRANTED))).toBe(false);
	});

	it("grantIds narrows the search, and an unknown or foreign grant id is refused before Discord is called", async () => {
		grants.mockResolvedValue([grant({}), grant({ id: "g2", resourceId: CH_B, resourceName: "#beta" })]);
		const { fetch, calls } = discord({ [CH_A]: [msg(10)], [CH_B]: [msg(20)] });
		const only = out(await search.handler(ctx(), { grantIds: ["g2"] }));
		expect(only.hits.map((h) => h.channelId)).toEqual([CH_B]);
		expect(calls.some((c) => c.includes(CH_A))).toBe(false);
		fetch.mockClear();
		const bad = await search.handler(ctx(), { grantIds: ["someone-elses"] });
		expect(bad.success).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("guildId narrows to one server", async () => {
		grants.mockResolvedValue([grant({}), grant({ id: "g2", resourceId: CH_B, resourceName: "#beta", resourceUrl: `https://discord.com/channels/${OTHER_GUILD}/${CH_B}` })]);
		discord({ [CH_A]: [msg(10)], [CH_B]: [msg(20)] });
		expect(out(await search.handler(ctx(), { guildId: OTHER_GUILD })).hits.map((h) => h.channelId)).toEqual([CH_B]);
	});

	it("a server grant searches every text channel of the server, including one created after the grant", async () => {
		grants.mockResolvedValue([guildGrant]);
		discord({ [CH_A]: [msg(10)], [CH_NEW]: [msg(20, { content: "in the new channel" })] });
		const res = out(await search.handler(ctx(), { text: "new channel" }));
		expect(res.hits).toMatchObject([{ channelId: CH_NEW, channelName: "chan-3" }]);
		expect(res.searched.channels).toBe(2);
	});

	it("an unreadable channel is reported and the rest of the search carries on", async () => {
		grants.mockResolvedValue([grant({}), grant({ id: "g2", resourceId: CH_B, resourceName: "#beta" })]);
		discord({ [CH_A]: [msg(10)] });
		const res = out(await search.handler(ctx(), {}));
		expect(res.hits).toHaveLength(1);
		expect(res.unreadableChannels).toMatchObject([{ channelId: CH_B }]);
	});

	it("caps the channels searched per call and says how many were left", async () => {
		const ids = Array.from({ length: 125 }, (_, i) => String(100000000000001000n + BigInt(i)));
		grants.mockResolvedValue(ids.map((id, i) => grant({ id: `g${i}`, resourceId: id, resourceName: `#c${i}`, resourceUrl: null })));
		discord(Object.fromEntries(ids.map((id) => [id, [] as unknown[]])));
		const res = out(await search.handler(ctx(), {}));
		expect(res.searched).toMatchObject({ channels: 120, channelsNotSearched: 5 });
		expect(res.truncated).toBe(true);
		expect(res.truncatedBecause).toMatch(/5 of 125/);
	});

	it("stops at the Discord-call budget, says so, and only returns hits it is sure are the newest", async () => {
		// One channel with a long, hit-free history: each page is full, so the scan keeps asking until the budget.
		const rows = Array.from({ length: 100 }, (_, i) => msg(100000 - i));
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = String(input);
			const before = /before=(\d+)/.exec(url)?.[1];
			// Every page is full and older than the last: ids shrink by one page each call.
			const base = before ? BigInt(before) - 1n : BigInt(mid(100000));
			return reply(rows.map((r, i) => ({ ...r, id: String(base - BigInt(i) * 4_194_304n), content: "filler" })));
		});
		vi.stubGlobal("fetch", fetch);
		const res = out(await search.handler(ctx(), { text: "needle" }));
		expect(res.truncated).toBe(true);
		expect(res.truncatedBecause).toMatch(/200 Discord calls/);
		expect(res.searched.discordCalls).toBe(200);
		expect(res.searchedBackTo).toBeTruthy();
		expect(res.nextCursor).toBeTruthy();
	});

	it("waits out a 429 once and retries; a limit that does not clear stops the search and says rate_limited", async () => {
		let n = 0;
		discord({ [CH_A]: [msg(10)] }, (url) => (url.includes("/messages") && n++ === 0 ? reply({ message: "slow down", retry_after: 0.01 }, 429) : undefined));
		const ok = out(await search.handler(ctx(), {}));
		expect(ok.hits).toHaveLength(1);
		expect(ok.truncated).toBe(false);

		vi.stubGlobal("fetch", vi.fn(async () => reply({ message: "slow down", retry_after: 30 }, 429)));
		const limited = out(await search.handler(ctx(), {}));
		expect(limited.truncated).toBe(true);
		expect(limited.truncatedBecause).toMatch(/rate-limited/);
	});

	it("refuses malformed input before the token is read or Discord is called", async () => {
		const { fetch } = discord({});
		for (const input of [{ authorId: "12" }, { mentionsUserId: 5 }, { cursor: "abc" }, { since: "yesterday-ish" }, { grantIds: "g1" }, { guildId: "x" }]) {
			const r = await search.handler(ctx(), input);
			expect(r.success, JSON.stringify(input)).toBe(false);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("no grants at all is an error that says how to grant", async () => {
		grants.mockResolvedValue([]);
		const r = await search.handler(ctx(), {});
		expect(r).toMatchObject({ success: false });
		expect(r.content).toMatch(/grant_instance_discord_channel/);
	});
});

describe("whole-server grant (#1703) in the agent's tools", () => {
	const read = DISCORD_CONNECTOR.tools.find((t) => t.name === "discord_read_messages");
	const list = DISCORD_CONNECTOR.tools.find((t) => t.name === "discord_list_granted_channels");
	if (!read || !list) throw new Error("missing tools");
	const guildCtx = (): RegistryToolCtx => ({ ...ctx(), connectorClient: () => ({ token: async () => "bot-secret", requireGrant: async () => guildGrant, fetch: async () => new Response(), connector: DISCORD_CONNECTOR }) });

	it("reads a channel created after the grant: the server grant plus a channelId that Discord confirms is in that server", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => (String(url).endsWith(`/channels/${CH_NEW}`) ? reply({ id: CH_NEW, guild_id: GUILD, type: 0 }) : reply([{ id: "1" }])));
		vi.stubGlobal("fetch", fetch);
		const r = await read.handler(guildCtx(), { grantId: "gg", channelId: CH_NEW });
		expect(r.success).toBe(true);
		expect(String(fetch.mock.calls.at(-1)?.[0])).toContain(`/channels/${CH_NEW}/messages`);
	});

	it("refuses a channel of another server, a non-text channel, a missing channelId, and one the bot cannot see", async () => {
		const cases: Array<[Record<string, unknown>, Response]> = [
			[{ channelId: CH_NEW }, reply({ id: CH_NEW, guild_id: OTHER_GUILD, type: 0 })],
			[{ channelId: CH_NEW }, reply({ id: CH_NEW, guild_id: GUILD, type: 2 })],
			[{}, reply({})],
			[{ channelId: CH_NEW }, reply({ message: "Missing Access" }, 403)],
		];
		for (const [extra, response] of cases) {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => response.clone());
			vi.stubGlobal("fetch", fetch);
			const r = await read.handler(guildCtx(), { grantId: "gg", ...extra });
			expect(r.success, JSON.stringify(extra)).toBe(false);
			expect(fetch.mock.calls.some((c) => String(c[0]).includes("/messages"))).toBe(false);
		}
	});

	it("lists the server grant with the server's channels as they are now", async () => {
		grants.mockResolvedValue([guildGrant]);
		discord({ [CH_A]: [], [CH_NEW]: [] });
		const r = JSON.parse((await list.handler(ctx(), {})).content) as { channels: unknown[]; servers: Array<{ grantId: string; guildId: string; channels: Array<{ channelId: string; category?: string }> }> };
		expect(r.channels).toEqual([]);
		expect(r.servers[0]).toMatchObject({ grantId: "gg", guildId: GUILD });
		expect(r.servers[0]?.channels.map((c) => c.channelId)).toEqual([CH_A, CH_NEW]);
		expect(r.servers[0]?.channels[0]?.category).toBe("Projects");
	});
});
