/**
 * #1217 acceptance, through the real routes over the real schema. Only Slack is faked, and every
 * request to it is recorded, so "the test note went to the granted channel and nowhere else" is
 * measured, not assumed.
 *
 *   • A Slack bot is connected, one channel granted to ONE instance, and it receives a test note.
 *   • The release-notes setting is readable and writable, and an instance inherits the account default.
 *   • The grant checks: a channel choice or a test send naming a grant this instance does not hold is refused.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { slackRoutes } = await import("./slack.js");
const { instanceReleaseNotesRoutes } = await import("./instances-release-notes.js");
const { preferenceRoutes } = await import("./preferences.js");

const BOT = "xoxb-1217-workspace-a";
const BOT_OTHER = "xoxb-1217-workspace-b";
const CH_ENG = "C0ENG00001";
const CH_OPS = "C0OPS00002";
const CH_OUTSIDE = "C0OUT00003"; // the bot is not a member

let d1: RealSchemaD1;
let env: Env;
let posts: Array<{ channel: string; text: string; auth: string | null }>;

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/slack", slackRoutes);
app.route("/v1/instances", instanceReleaseNotesRoutes);
app.route("/v1/preferences", preferenceRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A small Slack: two workspaces' bots, three channels. */
function slack(method: string, auth: string | null, form: URLSearchParams): Response {
	const token = auth?.replace(/^Bearer /, "") ?? "";
	if (method === "oauth.v2.access") return form.get("code") === "good-code" ? json({ ok: true, access_token: BOT, token_type: "bot", team: { id: "T1", name: "Acme" } }) : json({ ok: false, error: "invalid_code" });
	if (![BOT, BOT_OTHER].includes(token)) return json({ ok: false, error: "invalid_auth" });
	if (method === "auth.test") return json({ ok: true, team: token === BOT ? "Acme" : "Other", team_id: token === BOT ? "T1" : "T2", user_id: "U0BOT" });
	if (method === "conversations.list") {
		return json({ ok: true, channels: [{ id: CH_ENG, name: "eng", is_member: true }, { id: CH_OPS, name: "ops", is_private: true, is_member: true }, { id: CH_OUTSIDE, name: "random", is_member: false }], response_metadata: { next_cursor: "" } });
	}
	if (method === "conversations.info") {
		const id = form.get("channel");
		const ch = { [CH_ENG]: { id: CH_ENG, name: "eng", is_member: true }, [CH_OPS]: { id: CH_OPS, name: "ops", is_member: true }, [CH_OUTSIDE]: { id: CH_OUTSIDE, name: "random", is_member: false } }[id ?? ""];
		return ch ? json({ ok: true, channel: ch }) : json({ ok: false, error: "channel_not_found" });
	}
	if (method === "chat.postMessage") {
		const channel = form.get("channel") ?? "";
		if (channel === CH_OUTSIDE) return json({ ok: false, error: "not_in_channel" });
		posts.push({ channel, text: form.get("text") ?? "", auth });
		return json({ ok: true, ts: "1700000000.000100" });
	}
	return json({ ok: false, error: "unknown_method" });
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 'rn-1217-coder', 'Release-notes coder', '${JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding" } })}')`);
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-a', 'ag', 'u1', 'active', '{}'), ('inst-b', 'ag', 'u1', 'active', '{}')");
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "a".repeat(64), SESSION_SIGNING_KEY: "s".repeat(64) } as unknown as Env;
	posts = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.hostname !== "slack.com") throw new Error(`unexpected fetch to ${url.hostname}`);
		return slack(url.pathname.replace("/api/", ""), new Headers(init?.headers).get("Authorization"), new URLSearchParams(String(init?.body ?? "")));
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
	const res = await app.request(path, { method: init.method ?? "GET", headers: { "Content-Type": "application/json", ...init.headers }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, env);
	const text = await res.text();
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		body = { text }; // the OAuth callback answers HTML
	}
	return { status: res.status, body, headers: res.headers };
};

const connect = () => call("/v1/slack/bot", { method: "PUT", body: { token: BOT } });
const grantTo = (instance: string, channelId: string) => call(`/v1/slack/instances/${instance}/grants`, { method: "POST", body: { channelId } });
type Grant = { id: string; resourceName: string };

describe("a Slack channel is connected, granted to ONE instance, and receives a test note (#1217 acceptance)", () => {
	it("end to end", async () => {
		expect((await call("/v1/slack/bot")).body).toMatchObject({ connected: false, oauthConfigured: false });
		const connected = await connect();
		expect(connected.status).toBe(201);
		expect(connected.body).toMatchObject({ connected: true, bot: { team: "Acme", teamId: "T1" } });
		expect(JSON.stringify(connected.body)).not.toContain(BOT);
		expect((await call("/v1/slack/bot")).body).toMatchObject({ connected: true, valid: true });

		const listed = await call("/v1/slack/channels");
		expect((listed.body.channels as Array<{ id: string }>).map((c) => c.id)).toEqual([CH_ENG, CH_OPS, CH_OUTSIDE]);

		const granted = await grantTo("inst-a", CH_ENG);
		expect(granted.status).toBe(201);
		const grant = granted.body.grant as Grant;
		expect(grant.resourceName).toBe("#eng");
		expect((await grantTo("inst-a", CH_ENG)).body.grant).toMatchObject({ id: grant.id }); // same channel, same id

		// Granted to inst-a only: inst-b sees no Slack channel.
		expect(((await call("/v1/instances/inst-b/release-notes")).body.effective as { channels: unknown[] }).channels).toEqual([]);

		const sent = await call("/v1/instances/inst-a/release-notes/test", { method: "POST", body: { grantId: grant.id } });
		expect(sent.status).toBe(200);
		expect(sent.body).toMatchObject({ sent: true, channel: { provider: "slack", channelId: CH_ENG } });
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ channel: CH_ENG, auth: `Bearer ${BOT}` });
		expect(posts[0].text).toContain("Test release note");
	});

	it("a channel the bot is not in is granted with a note saying so, and its test send fails with Slack's remedy", async () => {
		await connect();
		const granted = await grantTo("inst-a", CH_OUTSIDE);
		expect(granted.body).toMatchObject({ botInChannel: false, note: expect.stringContaining("/invite") });
		const sent = await call("/v1/instances/inst-a/release-notes/test", { method: "POST", body: { grantId: (granted.body.grant as Grant).id } });
		expect(sent.status).toBe(502);
		expect(sent.body.error).toMatch(/not in that channel.*\/invite/);
		expect(posts).toHaveLength(0);
	});

	it("only a bot token is accepted, and a rejected one is never stored", async () => {
		expect((await call("/v1/slack/bot", { method: "PUT", body: { token: "xoxp-a-person" } })).body.error).toMatch(/not a Slack BOT token/);
		expect((await call("/v1/slack/bot", { method: "PUT", body: { token: "xoxb-not-real" } })).body.error).toMatch(/Slack rejected that token/);
		expect((await call("/v1/slack/bot")).body.connected).toBe(false);
	});

	it("connecting a bot in a DIFFERENT workspace revokes every Slack grant; rotating within the same one keeps them", async () => {
		await connect();
		await grantTo("inst-a", CH_ENG);
		expect((await connect()).body.revoked).toEqual({ grants: 0, instances: 0 });
		const replaced = await call("/v1/slack/bot", { method: "PUT", body: { token: BOT_OTHER } });
		expect(replaced.body.revoked).toEqual({ grants: 1, instances: 1 });
		expect((await call("/v1/slack/instances/inst-a/grants")).body.grants).toEqual([]);
	});

	it("disconnecting removes the token and every grant", async () => {
		await connect();
		await grantTo("inst-a", CH_ENG);
		expect((await call("/v1/slack/bot", { method: "DELETE" })).body).toMatchObject({ disconnected: true, revoked: { grants: 1 } });
		expect((await call("/v1/slack/bot")).body.connected).toBe(false);
		expect((await call("/v1/slack/instances/inst-a/grants")).body.grants).toEqual([]);
	});

	it("OAuth: refused when the platform has no Slack app; with one, a browser-bound state round-trips and stores the bot", async () => {
		expect((await call("/v1/slack/oauth/start")).status).toBe(501);
		env = { ...env, SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "csecret" } as Env;
		const start = await call("https://api.test/v1/slack/oauth/start");
		const url = new URL(start.body.url as string);
		expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
		expect(url.searchParams.get("scope")).toBe("chat:write,channels:read,groups:read");
		expect(url.searchParams.get("redirect_uri")).toBe("https://api.test/v1/slack/oauth/callback");
		const state = url.searchParams.get("state") ?? "";
		// Without the browser's cookie, the state is refused — a link completed by someone else stores nothing.
		expect((await call(`https://api.test/v1/slack/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`)).status).toBe(400);
		const again = await call("https://api.test/v1/slack/oauth/start");
		const state2 = new URL(again.body.url as string).searchParams.get("state") ?? "";
		const done = await call(`https://api.test/v1/slack/oauth/callback?code=good-code&state=${encodeURIComponent(state2)}`, { headers: { cookie: (again.headers.get("Set-Cookie") ?? "").split(";")[0] } });
		expect(done.status).toBe(200);
		expect(String(done.body.text)).toContain("Slack connected");
		expect((await call("/v1/slack/bot")).body).toMatchObject({ connected: true, valid: true, bot: { team: "Acme" } });
	});
});

describe("release-notes settings: readable, writable, inherited (#1217 acceptance)", () => {
	const settings = (instance: string) => call(`/v1/instances/${instance}/release-notes`);
	const put = (instance: string, body: unknown) => call(`/v1/instances/${instance}/release-notes`, { method: "PUT", body });

	it("with nothing set, release notes are on for every granted channel", async () => {
		await connect();
		await grantTo("inst-a", CH_ENG);
		expect((await settings("inst-a")).body).toMatchObject({ settings: {}, account: null, effective: { enabled: true, enabledFrom: "platform", channelsFrom: "all", channels: [{ provider: "slack", selected: true }] } });
	});

	it("an instance inherits the account default — including one subscribed AFTER it was set — until it sets its own", async () => {
		expect((await call("/v1/preferences", { method: "PUT", body: { releaseNotes: { enabled: false } } })).status).toBe(200);
		d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-new', 'ag', 'u1', 'active', '{}')");
		expect((await settings("inst-new")).body.effective).toMatchObject({ enabled: false, enabledFrom: "account" });
		expect((await put("inst-new", { enabled: true })).body.effective).toMatchObject({ enabled: true, enabledFrom: "instance" });
		// The account default changing again does not move an instance that chose for itself…
		await call("/v1/preferences", { method: "PUT", body: { releaseNotes: { enabled: false } } });
		expect((await settings("inst-new")).body.effective).toMatchObject({ enabled: true, enabledFrom: "instance" });
		// …and null hands it back to the account.
		expect((await put("inst-new", { enabled: null })).body.effective).toMatchObject({ enabled: false, enabledFrom: "account" });
		expect(((await call("/v1/preferences")).body.preferences as { releaseNotes?: unknown }).releaseNotes).toEqual({ enabled: false });
	});

	it("choosing channels: patch per field, null returns to every granted channel", async () => {
		await connect();
		const eng = (await grantTo("inst-a", CH_ENG)).body.grant as Grant;
		const ops = (await grantTo("inst-a", CH_OPS)).body.grant as Grant;
		const chosen = await put("inst-a", { channels: [ops.id] });
		expect(chosen.body.settings).toEqual({ channels: [ops.id] });
		expect((chosen.body.effective as { channels: Array<{ grantId: string; selected: boolean }> }).channels.map((c) => [c.grantId, c.selected])).toEqual(expect.arrayContaining([[eng.id, false], [ops.id, true]]));
		expect((await put("inst-a", { enabled: false })).body.settings).toEqual({ enabled: false, channels: [ops.id] }); // channels kept
		expect((await put("inst-a", { channels: null })).body.settings).toEqual({ enabled: false });
	});

	it("the grant checks: a choice or a test send naming another instance's grant is refused, and nothing is saved or sent", async () => {
		await connect();
		const theirs = (await grantTo("inst-b", CH_ENG)).body.grant as Grant;
		const refused = await put("inst-a", { channels: [theirs.id] });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toContain(`Not a channel granted to this instance: ${theirs.id}`);
		expect((await settings("inst-a")).body.settings).toEqual({});
		const test = await call("/v1/instances/inst-a/release-notes/test", { method: "POST", body: { grantId: theirs.id } });
		expect(test.status).toBe(404);
		expect(posts).toHaveLength(0);
	});

	it("strict on write: unknown fields and wrong types are refused, never dropped", async () => {
		expect((await put("inst-a", { enable: true })).body.error).toMatch(/Unknown field `enable`/);
		expect((await put("inst-a", { enabled: "yes" })).status).toBe(400);
		expect((await call("/v1/preferences", { method: "PUT", body: { releaseNotes: { enabled: true, channels: [] } } })).body.error).toMatch(/unknown: `channels`/);
		expect((await call("/v1/instances/inst-a/release-notes/test", { method: "POST", body: { grant_id: "x" } })).body.error).toMatch(/Unknown field `grant_id`/);
	});

	it("a revoked channel that was chosen is reported as missing and receives nothing", async () => {
		await connect();
		const eng = (await grantTo("inst-a", CH_ENG)).body.grant as Grant;
		await put("inst-a", { channels: [eng.id] });
		await call(`/v1/slack/instances/inst-a/grants/${eng.id}`, { method: "DELETE" });
		expect((await settings("inst-a")).body.effective).toMatchObject({ channels: [], missing: [eng.id] });
	});
});
