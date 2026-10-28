/**
 * #1387 — `discord_list_members`: one server's members, read-only, through the owner's existing bot. Pagination, field mapping, the missing-intent
 * error and authorization (only a server holding a channel granted to THIS instance). Discord is a stubbed fetch; grants are a stubbed lookup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorGrant } from "../connector-grants.js";
import type { RegistryToolCtx } from "./types.js";

const grants = vi.fn<() => Promise<ConnectorGrant[]>>();
vi.mock("../connector-grants.js", async () => {
	const actual = await vi.importActual<typeof import("../connector-grants.js")>("../connector-grants.js");
	return { ...actual, listConnectorGrants: () => grants() };
});
const { DISCORD_CONNECTOR, DISCORD_MEMBERS_INTENT_HELP } = await import("./discord.js");

const GUILD = "900000000000000001";
const OTHER_GUILD = "900000000000000002";
const grant = (over: Partial<ConnectorGrant> = {}): ConnectorGrant => ({
	id: "g1",
	instanceId: "i1",
	userId: "u1",
	provider: "discord",
	resourceId: "123456789012345678",
	resourceName: "interns",
	resourceType: "discord_channel",
	resourceUrl: `https://discord.com/channels/${GUILD}/123456789012345678`,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...over,
});
const tool = DISCORD_CONNECTOR.tools.find((t) => t.name === "discord_list_members");
if (!tool) throw new Error("missing discord_list_members");
const ctx = (over: Partial<RegistryToolCtx> = {}, token: string | null = "bot-secret"): RegistryToolCtx => ({
	env: {} as RegistryToolCtx["env"],
	instanceId: "i1",
	userId: "u1",
	connectorClient: () => ({ token: async () => token ?? "", requireGrant: async () => grant(), fetch: async () => new Response(), connector: DISCORD_CONNECTOR }),
	...over,
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const member = (id: string, extra: Record<string, unknown> = {}) => ({ user: { id, username: `u${id.slice(-3)}`, global_name: `User ${id.slice(-3)}`, avatar: "hash", email: "x@y.z" }, nick: null, roles: [], joined_at: "2026-09-01T00:00:00.000000+00:00", ...extra });
const run = (input: Record<string, unknown>, c = ctx()) => tool.handler(c, input);
type Out = { guildId: string; next_after: string | null; count: number; members: Array<Record<string, unknown>> };
const json = (r: { content: string }) => JSON.parse(r.content) as Out;

beforeEach(() => grants.mockResolvedValue([grant()]));
afterEach(() => vi.unstubAllGlobals());

describe("discord_list_members (#1387)", () => {
	it("is a read-only, untrusted-output read tool of the discord connector", () => {
		expect(tool).toMatchObject({ connector: "discord", scope: "read", mutates: false, untrustedOutput: true, tier: "connector" });
		expect(tool.jsonSchema).toMatchObject({ required: ["guildId"] });
	});

	it("maps each member to id, username, global name, nick, bot flag, role ids and names, and joinedAt — and nothing else Discord sends", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			const u = String(url);
			if (u.includes("/members?")) return reply([member("111111111111111111", { nick: "Ana (intern)", roles: ["70", "71", "72"] }), member("111111111111111112", { user: { id: "111111111111111112", username: "robo", bot: true } })]);
			if (u.endsWith("/roles")) return reply([{ id: "70", name: "Intern" }, { id: "71", name: "Cohort 2026" }, { id: "99", name: "Admin" }]);
			return reply({ message: "Unknown" }, 404);
		});
		vi.stubGlobal("fetch", fetch);
		const out = json(await run({ guildId: GUILD }));
		expect(out.members).toEqual([
			{ userId: "111111111111111111", username: "u111", globalName: "User 111", nick: "Ana (intern)", bot: false, roleIds: ["70", "71", "72"], roles: ["Intern", "Cohort 2026", null], joinedAt: "2026-09-01T00:00:00.000000+00:00" },
			{ userId: "111111111111111112", username: "robo", globalName: null, nick: null, bot: true, roleIds: [], roles: [], joinedAt: "2026-09-01T00:00:00.000000+00:00" },
		]);
		expect(JSON.stringify(out)).not.toMatch(/avatar|email|x@y\.z/);
		expect(out).toMatchObject({ guildId: GUILD, count: 2, next_after: null });
	});

	it("is read-only on the wire: every call is a GET, with the bot token, to the members and roles of that one server", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => (String(url).endsWith("/roles") ? reply([]) : reply([])));
		vi.stubGlobal("fetch", fetch);
		await run({ guildId: GUILD });
		expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([`https://discord.com/api/v10/guilds/${GUILD}/members?limit=100`, `https://discord.com/api/v10/guilds/${GUILD}/roles`]);
		for (const [, init] of fetch.mock.calls) {
			expect(init?.method ?? "GET").toBe("GET");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bot bot-secret");
		}
	});

	describe("pagination", () => {
		const page = (ids: string[]) => ids.map((id) => member(id));
		it("a full page returns next_after = the last user id, and `after` is sent on the next call", async () => {
			const urls: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof globalThis.fetch>(async (url) => {
					const u = String(url);
					urls.push(u);
					if (u.endsWith("/roles")) return reply([]);
					return u.includes("after=") ? reply(page(["111111111111111113"])) : reply(page(["111111111111111111", "111111111111111112"]));
				}),
			);
			const first = json(await run({ guildId: GUILD, limit: 2 }));
			expect(first.next_after).toBe("111111111111111112");
			const second = json(await run({ guildId: GUILD, limit: 2, after: first.next_after }));
			expect(urls.some((u) => u.includes("/members?limit=2&after=111111111111111112"))).toBe(true);
			expect(second.members.map((m) => m.userId)).toEqual(["111111111111111113"]);
			expect(second.next_after).toBeNull(); // a short page is the end
		});

		it("limit defaults to 100, is capped at 1000 and floored at 1", async () => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => reply([]));
			vi.stubGlobal("fetch", fetch);
			for (const [limit, want] of [[undefined, 100], [5000, 1000], [0, 100], [-3, 1], [1000, 1000], ["7", 7]] as const) {
				fetch.mockClear();
				await run({ guildId: GUILD, ...(limit === undefined ? {} : { limit }) });
				expect(String(fetch.mock.calls[0][0]), String(limit)).toContain(`/members?limit=${want}`);
			}
		});

		it("a malformed cursor is refused before Discord is asked", async () => {
			const fetch = vi.fn<typeof globalThis.fetch>();
			vi.stubGlobal("fetch", fetch);
			for (const after of ["abc", "../roles", 123, {}]) {
				const r = await run({ guildId: GUILD, after });
				expect(r.success, String(after)).toBe(false);
				expect(r.content).toMatch(/after must be a Discord user id/);
			}
			expect(fetch).not.toHaveBeenCalled();
		});
	});

	describe("the Server Members Intent is off (or the bot has no access)", () => {
		it("a 403 from the members call says exactly what to switch on, and where", async () => {
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => reply({ message: "Missing Access", code: 50001 }, 403)));
			const r = await run({ guildId: GUILD });
			expect(r.success).toBe(false);
			expect(r.content).toBe(DISCORD_MEMBERS_INTENT_HELP);
			expect(r.content).toMatch(/Developer Portal/);
			expect(r.content).toMatch(/SERVER MEMBERS INTENT/);
			expect(r.content).toMatch(/Privileged Gateway Intents/);
		});

		it("other failures keep Discord's own wording: a revoked token, a rate limit", async () => {
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => reply({ message: "401: Unauthorized" }, 401)));
			expect((await run({ guildId: GUILD })).content).toMatch(/reset or revoked/);
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => reply({ message: "slow down" }, 429)));
			expect((await run({ guildId: GUILD })).content).toMatch(/rate-limited/);
		});

		it("unreadable role names do not fail the listing: ids are returned, names are null", async () => {
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (url) => (String(url).endsWith("/roles") ? reply({ message: "Missing Permissions" }, 403) : reply([member("111111111111111111", { roles: ["70"] })]))));
			const r = await run({ guildId: GUILD });
			expect(r.success).toBe(true);
			expect(json(r).members[0]).toMatchObject({ roleIds: ["70"], roles: [null] });
		});
	});

	describe("authorization", () => {
		it("refuses a server this instance holds no channel grant in — before any member call — even though the owner's bot may be in it", async () => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => reply([]));
			vi.stubGlobal("fetch", fetch);
			const r = await run({ guildId: OTHER_GUILD });
			expect(r.success).toBe(false);
			expect(r.content).toMatch(/holds no Discord channel grant in server/);
			expect(fetch.mock.calls.some(([u]) => String(u).includes("/members"))).toBe(false);
		});

		it("an instance with no grants lists nothing", async () => {
			grants.mockResolvedValue([]);
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => reply([])));
			expect((await run({ guildId: GUILD })).success).toBe(false);
		});

		it("only the agent's channel grants count: a release-notes grant in that server does not open it", async () => {
			grants.mockResolvedValue([grant({ resourceType: "discord_release_channel" })]);
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => reply([])));
			expect((await run({ guildId: GUILD })).success).toBe(false);
		});

		it("a grant recorded without its URL is resolved through Discord to its server", async () => {
			grants.mockResolvedValue([grant({ resourceUrl: null })]);
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof globalThis.fetch>(async (url) => {
					const u = String(url);
					if (u.endsWith("/channels/123456789012345678")) return reply({ id: "123456789012345678", guild_id: GUILD });
					return u.endsWith("/roles") ? reply([]) : reply([member("111111111111111111")]);
				}),
			);
			expect(json(await run({ guildId: GUILD })).count).toBe(1);
		});

		it("is available only from an instance, needs a connected bot, and a real server id", async () => {
			vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>());
			expect((await run({ guildId: GUILD }, ctx({ instanceId: undefined }))).success).toBe(false);
			expect((await run({ guildId: GUILD }, ctx({}, null))).content).toMatch(/No Discord bot is connected/);
			for (const guildId of [undefined, "", "12", "../x", 12345]) {
				const r = await run({ guildId });
				expect(r.success, String(guildId)).toBe(false);
				expect(r.content).toMatch(/guildId must be a Discord server id/);
			}
		});
	});
});
