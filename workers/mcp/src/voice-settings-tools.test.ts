import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerSettingsTools } from "./instance-tools/settings.js";
import type { SafetyContext } from "./safety.js";

// ── #613, the voice-settings group ────────────────────────────────────────────
//
// `get_instance_voice_settings` and `clear_instance_voice_settings` are thin proxies.
// `set_instance_voice_settings` is NOT, and that is what these tests are mostly about.
//
// The route's PUT rebuilds the whole override by sanitizing the body against
// `overrideVoiceBase(account, current)` (`workers/api/src/lib/preferences.ts:389`), which
// supplies the ACCOUNT value for every field except `vocabulary`. So a field left out of the
// body does not keep its current value — it snaps back to the account default, silently
// discarding the rest of the agent's override. The tool therefore reads first and sends the
// current settings back merged, and the tests below pin both halves of that:
//
//   · what is CARRIED  — a field the caller never named still arrives at the route;
//   · what is DROPPED  — `vocabulary` and its two read-only companions are not echoed, because
//     `vocabulary` unions across scopes (#373) and the GET returns the union. Echoing it would
//     write the ACCOUNT's words into this agent's own list, permanently and invisibly. Leaving
//     it out is what makes the route keep the agent's own list.
//
// Driven through the real safety layer and `authedCall`; only `fetch` and the audit KV are stubbed.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

/** What the route answers a GET with: the RESOLVED object, plus the two read-only companions. */
const RESOLVED = {
	provider: "openai-realtime",
	speed: 130,
	silenceMs: 1500,
	maxDictationMs: 60000,
	ttsMaxChars: 1500,
	sttMode: "openai",
	sttModel: "gpt-4o-transcribe",
	sensitivity: 0.8,
	language: "de-DE",
	commandsEnabled: true,
	keepAwake: true,
	disabledCommands: [],
	// the union of the account's words and this agent's own — never echoed back
	vocabulary: ["tmux", "HeartFull"],
	inheritedVocabulary: ["HeartFull"],
	derivedVocabulary: ["pags-platform"],
};

function setup(opts: { scopes?: string[]; status?: number; getStatus?: number; body?: unknown; getBody?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const method = (init?.method || "GET").toUpperCase();
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method, body: raw === null ? null : JSON.parse(raw) });
		const isGet = method === "GET";
		const body = isGet ? (opts.getBody ?? { voiceSettings: RESOLVED, hasOverride: true }) : (opts.body ?? { voiceSettings: RESOLVED, hasOverride: true });
		const status = isGet ? (opts.getStatus ?? 200) : (opts.status ?? 200);
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	});
	const audit = new Map<string, string>();
	const kv = {
		get: async (k: string) => audit.get(k) ?? null,
		put: async (k: string, v: string) => void audit.set(k, v),
		delete: async (k: string) => void audit.delete(k),
		list: async () => ({ keys: [...audit.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, Handler>();
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
	const server = { tool: (name: string, _d: string, _s: Shape, handler: Handler) => tools.set(name, handler) } as any;
	const tokenFor = (t?: string) => t || "session-token";
	const safetyFor = (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] });
	registerSettingsTools(server, { env, tokenFor, safetyFor, groups: new Set<string>() });
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h({ instance_id: "inst-1", ...args });
	};
	const completed = () => [...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	const put = () => calls.find((c) => c.method === "PUT");
	return { run, calls, completed, put };
}

afterEach(() => vi.unstubAllGlobals());

describe("get_instance_voice_settings", () => {
	it("GETs the instance's voice settings and returns the route's body unchanged", async () => {
		const h = setup();
		const res = await h.run("get_instance_voice_settings");
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/voice-settings", method: "GET", body: null }]);
		expect(JSON.parse(res.content[0].text)).toEqual({ voiceSettings: RESOLVED, hasOverride: true });
	});

	it("reads without the write scope — it is a read tool", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("get_instance_voice_settings");
		expect(h.calls).toHaveLength(1);
	});
});

describe("set_instance_voice_settings", () => {
	it("reads first, then PUTs the current settings with only the named field changed", async () => {
		const h = setup();
		await h.run("set_instance_voice_settings", { speed: 90 });
		expect(h.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
		expect(h.put()?.url).toBe("https://api.test/v1/instances/inst-1/voice-settings");
		expect(h.put()?.body).toMatchObject({ speed: 90 });
		expect(h.completed().map((e) => e.tool)).toEqual(["set_instance_voice_settings"]);
	});

	it("carries the fields the caller did NOT name — the route would otherwise reset them to the account default", async () => {
		const h = setup();
		await h.run("set_instance_voice_settings", { speed: 90 });
		// Every field of the resolved object except the vocabulary trio survives the merge.
		expect(h.put()?.body).toMatchObject({
			provider: "openai-realtime",
			sttMode: "openai",
			sttModel: "gpt-4o-transcribe",
			language: "de-DE",
			commandsEnabled: true,
			keepAwake: true,
			sensitivity: 0.8,
			silenceMs: 1500,
			maxDictationMs: 60000,
			ttsMaxChars: 1500,
		});
	});

	it("never echoes the resolved vocabulary back — that would snapshot the ACCOUNT's words into this agent", async () => {
		const h = setup();
		await h.run("set_instance_voice_settings", { speed: 90 });
		const body = h.put()?.body as Record<string, unknown>;
		expect(body).not.toHaveProperty("vocabulary");
		expect(body).not.toHaveProperty("inheritedVocabulary");
		expect(body).not.toHaveProperty("derivedVocabulary");
	});

	it("sends a vocabulary the caller DID name — that replaces this agent's own list", async () => {
		const h = setup();
		await h.run("set_instance_voice_settings", { vocabulary: ["wrangler"] });
		expect(h.put()?.body).toMatchObject({ vocabulary: ["wrangler"] });
	});

	it("maps every snake_case argument to the camelCase field the route reads", async () => {
		const h = setup();
		await h.run("set_instance_voice_settings", {
			provider: "browser",
			speed: 100,
			stt_mode: "browser",
			stt_model: "whisper-1",
			language: "en-GB",
			commands_enabled: false,
			disabled_commands: ["mute", "scrap"],
			sensitivity: 1.2,
			silence_ms: 2000,
			max_dictation_ms: 120000,
			tts_max_chars: 800,
			keep_awake: false,
		});
		expect(h.put()?.body).toMatchObject({
			provider: "browser",
			speed: 100,
			sttMode: "browser",
			sttModel: "whisper-1",
			language: "en-GB",
			commandsEnabled: false,
			disabledCommands: ["mute", "scrap"],
			sensitivity: 1.2,
			silenceMs: 2000,
			maxDictationMs: 120000,
			ttsMaxChars: 800,
			keepAwake: false,
		});
	});

	it("keeps a false or zero-ish value instead of treating it as absent", async () => {
		const h = setup();
		await h.run("set_instance_voice_settings", { commands_enabled: false, keep_awake: false });
		expect(h.put()?.body).toMatchObject({ commandsEnabled: false, keepAwake: false });
	});

	it("refuses a call that names no field, without a request — an empty body would clear the override", async () => {
		const h = setup();
		const res = await h.run("set_instance_voice_settings", {});
		expect(res.content[0].text).toMatch(/nothing to update/);
		expect(res.content[0].text).toMatch(/clear_instance_voice_settings/);
		expect(h.calls).toHaveLength(0);
	});

	it("does not PUT when the read fails — a write built on a failed read would erase the override", async () => {
		const h = setup({ getStatus: 404, getBody: { error: "Instance not found" } });
		const res = await h.run("set_instance_voice_settings", { speed: 90 });
		expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
		expect(res.content[0].text).toContain("Instance not found");
		expect(h.completed()).toHaveLength(0);
	});

	it("surfaces the route's 400 on an unknown value and does not audit it as completed", async () => {
		const h = setup({ status: 400, body: { error: "provider must be browser, openai-realtime, gemini-live" } });
		const res = await h.run("set_instance_voice_settings", { speed: 90 });
		expect(res.content[0].text).toContain("provider must be");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run touches no network at all — not even the read — and names the fields", async () => {
		const h = setup();
		const res = await h.run("set_instance_voice_settings", { speed: 90, provider: "browser", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({
			dryRun: true,
			wouldDo: { method: "PUT", endpoint: "/v1/instances/inst-1/voice-settings", fields: ["provider", "speed"] },
		});
	});

	it("is refused without the write scope, and the refusal is not audited as completed", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.run("set_instance_voice_settings", { speed: 90 });
		expect(res.content[0].text).toMatch(/write/);
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});
});

describe("clear_instance_voice_settings", () => {
	it("DELETEs the override and returns what the account now resolves to", async () => {
		const h = setup({ body: { voiceSettings: { ...RESOLVED, speed: 100 }, hasOverride: false } });
		const res = await h.run("clear_instance_voice_settings");
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/voice-settings", method: "DELETE", body: null }]);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ hasOverride: false });
		expect(h.completed().map((e) => e.tool)).toEqual(["clear_instance_voice_settings"]);
	});

	it("dry_run touches no network and says it would DELETE", async () => {
		const h = setup();
		const res = await h.run("clear_instance_voice_settings", { dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({
			dryRun: true,
			wouldDo: { method: "DELETE", endpoint: "/v1/instances/inst-1/voice-settings" },
		});
	});

	it("is refused without the write scope", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.run("clear_instance_voice_settings");
		expect(res.content[0].text).toMatch(/write/);
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("surfaces the route's error and does not audit it as completed", async () => {
		const h = setup({ status: 404, body: { error: "Instance not found" } });
		const res = await h.run("clear_instance_voice_settings");
		expect(res.content[0].text).toContain("Instance not found");
		expect(h.completed()).toHaveLength(0);
	});
});
