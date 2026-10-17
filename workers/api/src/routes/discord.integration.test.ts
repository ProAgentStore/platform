/**
 * #1132 — the native Discord bot: connect, discover, grant, use, revoke, disconnect, end to end.
 *
 * Real schema and real routes (the owner's `/v1/discord/*` setup routes and the instance tool route an
 * MCP `call_instance_tool` reaches); only Discord is faked, and every request to it is recorded, so
 * "the bot never touched an ungranted channel" is measured, not assumed.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { ensureConsent } from "../lib/connector-consent.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { discordRoutes } = await import("./discord.js");
const { keysRoutes } = await import("./keys.js");
const { toolRoutes } = await import("./tools.js");

const INSTANCE = "inst-1132";
const TOKEN_A = "MTEzMjExMzIxMTMyMTEzMjExMzI.bot-a.secret-value-aaaaaaaaaaaaaaaa";
const TOKEN_A2 = "MTEzMjExMzIxMTMyMTEzMjExMzI.bot-a.rotated-value-bbbbbbbbbbbbbbbb";
const TOKEN_B = "OTk5OTk5OTk5OTk5OTk5OTk5OTk.bot-b.secret-value-cccccccccccccccc";
const USER_TOKEN = "user-account-token-dddddddddddddddddddd";
const BOT_A = "113211321132113211";
const BOT_B = "999999999999999999";
const GUILD = "222222222222222222";
const CH_ALERTS = "333333333333333333";
const CH_PRIVATE = "444444444444444444";
const CH_HIDDEN = "555555555555555555";
const CH_VOICE = "666666666666666666";
const DISCORD_TOOLS = ["discord_list_granted_channels", "discord_read_messages", "discord_send_message", "discord_add_reaction"];

let d1: RealSchemaD1;
let env: Env;
let sent: Array<{ path: string; method: string; auth: string | null; body: string | null }>;
let revokedTokens: Set<string>;

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/discord", discordRoutes);
app.route("/v1/keys", keysRoutes);
app.route("/v1/instances", toolRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A small Discord: two bots, one server, a text channel the bot may use, one it cannot see, and a voice channel. */
function discord(path: string, method: string, auth: string | null): Response {
	const token = auth?.replace(/^Bot /, "") ?? "";
	if (revokedTokens.has(token) || ![TOKEN_A, TOKEN_A2, TOKEN_B, USER_TOKEN].includes(token)) return json({ message: "401: Unauthorized" }, 401);
	if (path === "/users/@me") return token === USER_TOKEN ? json({ id: "777777777777777777", username: "a-person" }) : json({ id: token === TOKEN_B ? BOT_B : BOT_A, username: token === TOKEN_B ? "other-bot" : "pags-bot", bot: true });
	if (path === "/users/@me/guilds") return json([{ id: GUILD, name: "Ops" }]);
	if (path === `/guilds/${GUILD}/channels`) {
		return json([
			{ id: CH_ALERTS, name: "alerts", type: 0, guild_id: GUILD },
			{ id: CH_PRIVATE, name: "private", type: 0, guild_id: GUILD },
			{ id: CH_VOICE, name: "lounge", type: 2, guild_id: GUILD },
		]);
	}
	if (path === `/channels/${CH_HIDDEN}`) return json({ message: "Missing Access", code: 50001 }, 403);
	if (path === `/channels/${CH_ALERTS}`) return json({ id: CH_ALERTS, name: "alerts", type: 0, guild_id: GUILD });
	if (path === `/channels/${CH_PRIVATE}`) return json({ id: CH_PRIVATE, name: "private", type: 0, guild_id: GUILD });
	if (path.startsWith(`/channels/${CH_ALERTS}/messages`) && method === "GET") return json([{ id: "888888888888888888", content: "deploy failed on main" }]);
	if (path === `/channels/${CH_ALERTS}/messages` && method === "POST") return json({ id: "999999999999999990" });
	return json({ message: "Unknown" }, 404);
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 'discord-cc', 'Discord Command Center', '${JSON.stringify({ capabilities: { surfaces: [], runtime: null, tools: DISCORD_TOOLS } })}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${INSTANCE}', 'ag', 'u1', 'active', '{}')`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "a".repeat(64), SESSION_SIGNING_KEY: "s".repeat(64) } as unknown as Env;
	sent = [];
	revokedTokens = new Set();
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const auth = new Headers(init?.headers).get("Authorization");
		const method = init?.method ?? "GET";
		const path = url.pathname.replace(/^\/api\/v10/, "") + url.search;
		sent.push({ path, method, auth, body: typeof init?.body === "string" ? init.body : null });
		return discord(url.pathname.replace(/^\/api\/v10/, ""), method, auth);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

async function call(method: string, path: string, body?: unknown) {
	const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} });
	const raw = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, raw, json: (raw.startsWith("{") ? JSON.parse(raw) : {}) as Record<string, any> };
}
const tool = (name: string, args: Record<string, unknown> = {}) => call("POST", `/v1/instances/${INSTANCE}/tools/${name}`, args);
const grant = (channelId: string) => call("POST", `/v1/discord/instances/${INSTANCE}/grants`, { channelId });
const events = () => d1.sqlite.prepare("SELECT event, message, context FROM agent_events WHERE source = 'discord' ORDER BY rowid").all() as Array<{ event: string; message: string; context: string }>;
function everyStoredValue(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
	return tables.map((t) => JSON.stringify(d1.sqlite.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
}

describe("connect / rotate / disconnect the bot — never returning the token (#1132)", () => {
	it("connects only after Discord confirms a BOT identity, and no response, row or audit holds the token", async () => {
		expect((await call("GET", "/v1/discord/bot")).json).toEqual({ connected: false, valid: false, bot: null, reach: { grants: 0, instances: 0 } });

		const person = await call("PUT", "/v1/discord/bot", { token: USER_TOKEN });
		expect(person.status).toBe(400);
		expect(person.json.error).toMatch(/not a Discord BOT token/);
		const wrong = await call("PUT", "/v1/discord/bot", { token: "not-a-real-token-at-all" });
		expect(wrong.status).toBe(400);
		expect(wrong.json.error).toMatch(/Discord rejected that token/);

		const connected = await call("PUT", "/v1/discord/bot", { token: `Bot ${TOKEN_A}` });
		expect(connected.status).toBe(201);
		expect(connected.json).toEqual({ connected: true, rotated: false, bot: { id: BOT_A, username: "pags-bot" }, revoked: { grants: 0, instances: 0 } });
		expect((await call("GET", "/v1/discord/bot")).json).toMatchObject({ connected: true, valid: true, bot: { id: BOT_A } });

		const everything = [connected.raw, (await call("GET", "/v1/discord/bot")).raw, everyStoredValue()].join("\n");
		expect(everything).not.toContain("secret-value");
		expect(events().map((e) => e.event)).toEqual(["discord.bot_connect"]);
	});

	it("rotating the same bot keeps its grants; switching to a different bot revokes them; disconnect revokes token and grants", async () => {
		await call("PUT", "/v1/discord/bot", { token: TOKEN_A });
		const g = await grant(CH_ALERTS);
		expect(g.status).toBe(201);

		const rotated = await call("PUT", "/v1/discord/bot", { token: TOKEN_A2 });
		expect(rotated.status).toBe(200);
		expect(rotated.json).toMatchObject({ rotated: true, revoked: { grants: 0 } });
		expect((await call("GET", `/v1/discord/instances/${INSTANCE}/grants`)).json.grants.map((x: { id: string }) => x.id)).toEqual([g.json.grant.id]);

		const replaced = await call("PUT", "/v1/discord/bot", { token: TOKEN_B });
		expect(replaced.json).toMatchObject({ rotated: true, bot: { id: BOT_B }, revoked: { grants: 1, instances: 1 } });
		expect((await call("GET", `/v1/discord/instances/${INSTANCE}/grants`)).json.grants).toEqual([]);

		await grant(CH_ALERTS);
		const gone = await call("DELETE", "/v1/discord/bot");
		expect(gone.json).toEqual({ disconnected: true, revoked: { grants: 1, instances: 1 } });
		expect((await call("GET", "/v1/discord/bot")).json.connected).toBe(false);
		expect(events().map((e) => e.event)).toEqual(["discord.bot_connect", "discord.grant", "discord.bot_rotate", "discord.bot_replace", "discord.grant", "discord.bot_disconnect"]);
		for (const e of events()) expect(`${e.message}${e.context}`).not.toMatch(/secret-value|rotated-value/);
	});

	it("removing the token through Profile → API Keys revokes the grants too (#357)", async () => {
		await call("PUT", "/v1/discord/bot", { token: TOKEN_A });
		await grant(CH_ALERTS);
		expect((await call("DELETE", "/v1/keys/discord")).json).toEqual({ success: true, revoked: { grants: 1, instances: 1 } });
		expect((await call("GET", `/v1/discord/instances/${INSTANCE}/grants`)).json.grants).toEqual([]);
	});
});

describe("clear errors for every way it can be unusable (#1132)", () => {
	it("no bot connected: discovery and grants say so with 409 — never a 401 that signs the owner out", async () => {
		const r = await call("GET", "/v1/discord/guilds");
		expect(r.status).toBe(409);
		expect(r.json.error).toMatch(/No Discord bot is connected.*connect_discord_bot/);
		expect((await grant(CH_ALERTS)).status).toBe(409);
		expect(sent).toHaveLength(0);
	});

	it("a token Discord has since revoked: 409 and 'reconnect', and the status call reports it invalid", async () => {
		await call("PUT", "/v1/discord/bot", { token: TOKEN_A });
		revokedTokens.add(TOKEN_A);
		const r = await call("GET", "/v1/discord/guilds");
		expect(r.status).toBe(409);
		expect(r.json.error).toMatch(/reset or revoked\. Reconnect/);
		expect((await call("GET", "/v1/discord/bot")).json).toMatchObject({ connected: true, valid: false, bot: null });
	});

	it("an inaccessible channel is refused with 403 and the permissions to give; an unknown one with 404", async () => {
		await call("PUT", "/v1/discord/bot", { token: TOKEN_A });
		const hidden = await grant(CH_HIDDEN);
		expect(hidden.status).toBe(403);
		expect(hidden.json.error).toMatch(/View Channel, Read Message History and Send Messages/);
		expect((await grant("123123123123123123")).status).toBe(404);
		expect((await call("GET", `/v1/discord/instances/${INSTANCE}/grants`)).json.grants).toEqual([]);
	});
});

describe("a newly connected bot, through the agent's own tools (#1132)", () => {
	it("lists only granted channels, reads one, sends only after write consent, and never reaches an ungranted channel", async () => {
		await call("PUT", "/v1/discord/bot", { token: TOKEN_A });
		// Discovery lists the bot's servers and only its text channels.
		expect((await call("GET", "/v1/discord/guilds")).json.guilds).toEqual([{ id: GUILD, name: "Ops" }]);
		expect((await call("GET", `/v1/discord/guilds/${GUILD}/channels`)).json.channels.map((c: { id: string }) => c.id)).toEqual([CH_ALERTS, CH_PRIVATE]);

		const first = await grant(CH_ALERTS);
		const again = await grant(CH_ALERTS);
		expect([first.status, again.status]).toEqual([201, 200]);
		expect(again.json.grant.id).toBe(first.json.grant.id); // a stable id: the agent's handle survives a re-grant
		const grantId: string = first.json.grant.id;

		const listed = await tool("discord_list_granted_channels");
		expect(JSON.parse(listed.json.content)).toEqual({ channels: [{ grantId, channelId: CH_ALERTS, name: "#alerts", url: `https://discord.com/channels/${GUILD}/${CH_ALERTS}` }] });

		const read = await tool("discord_read_messages", { grantId });
		expect(read.json.success).toBe(true);
		expect(read.json.content).toContain("deploy failed on main");

		sent = [];
		const blocked = await tool("discord_send_message", { grantId, content: "on it @everyone" });
		expect(blocked.json.success).toBe(false);
		expect(blocked.json.content).toMatch(/blocked until you grant discord write access/);
		expect(sent).toHaveLength(0);

		await ensureConsent(env, INSTANCE, "u1", "discord", "write");
		const posted = await tool("discord_send_message", { grantId, content: "on it @everyone" });
		expect(posted.json.success).toBe(true);
		const post = sent.find((s) => s.method === "POST");
		expect(post).toMatchObject({ path: `/channels/${CH_ALERTS}/messages`, auth: `Bot ${TOKEN_A}` });
		expect(JSON.parse(post?.body ?? "{}")).toEqual({ content: "on it @everyone", allowed_mentions: { parse: [] } });

		// The private channel is visible to the bot but was never granted: no grant id reaches it.
		sent = [];
		for (const id of [CH_PRIVATE, "not-a-grant"]) {
			const r = await tool("discord_read_messages", { grantId: id });
			expect(r.json.success).toBe(false);
			expect(r.json.content).toMatch(/holds no Discord grant/);
		}
		expect(sent.some((s) => s.path.includes(CH_PRIVATE))).toBe(false);

		// Revoke by the stable id; a second revoke is a 404, and the agent is told the grant is gone.
		expect((await call("DELETE", `/v1/discord/instances/${INSTANCE}/grants/${grantId}`)).status).toBe(200);
		expect((await call("DELETE", `/v1/discord/instances/${INSTANCE}/grants/${grantId}`)).status).toBe(404);
		const afterRevoke = await tool("discord_read_messages", { grantId });
		expect(afterRevoke.json.content).toMatch(/was revoked/);

		// The audit names ids, never the token or a message's content.
		for (const e of events()) expect(`${e.message}${e.context}`).not.toMatch(/secret-value|deploy failed|on it/);
		expect(events().map((e) => e.event)).toEqual(["discord.bot_connect", "discord.grant", "discord.revoke"]);
	});
});
