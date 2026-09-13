import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { ACCOUNT_PREFERENCE_SECTIONS, registerAccountTools } from "./account.js";

// ── Why this file exists (#613, notifications and account preferences) ───────
//
// The console's bell and Preferences page had no MCP path. These five tools are thin proxies, so
// what is worth pinning is the part a proxy gets wrong: which route and method, that a write sends
// ONLY what the caller named (a manufactured section would overwrite what the owner set in the
// console — #501's failure on `set_budget_limits`), that `dry_run` touches no network, and that a
// refused call is not audited as completed. Driven through the REAL safety layer and `authedCall`;
// only `fetch` and the audit KV are stubbed, as in `instance-tools.test.ts`.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

const HERE = dirname(fileURLToPath(import.meta.url));

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: (init?.body as string | undefined) ?? null });
		return new Response(JSON.stringify(opts.body ?? { success: true }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const audit = new Map<string, string>();
	const kv = {
		get: async (k: string) => audit.get(k) ?? null,
		put: async (k: string, v: string) => void audit.set(k, v),
		delete: async (k: string) => void audit.delete(k),
		list: async () => ({ keys: [...audit.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, { schema: Shape; handler: Handler }>();
	registerAccountTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => tools.set(name, { schema, handler }) } as any,
		{
			env,
			tokenFor: (t?: string) => t || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] }),
			groups: new Set<string>(),
		},
	);
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const t = tools.get(name);
		if (!t) throw new Error(`registerAccountTools did not register "${name}"`);
		return t.handler(args);
	};
	const events = () => [...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string });
	return { run, calls, events, tools };
}

afterEach(() => vi.unstubAllGlobals());

describe("list_notifications", () => {
	it("reads the account feed, and passes the two filters the route takes", async () => {
		const h = setup();
		await h.run("list_notifications");
		await h.run("list_notifications", { unread_only: true, limit: 20 });
		expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET https://api.test/v1/notifications",
			"GET https://api.test/v1/notifications?unread=true&limit=20",
		]);
	});
});

describe("mark_notification_read", () => {
	it("posts to that notification's read route, URL-encoding the id, and audits the completion", async () => {
		const h = setup();
		await h.run("mark_notification_read", { notification_id: "a/b c" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/notifications/a%2Fb%20c/read", method: "POST", body: null }]);
		expect(h.events().some((e) => e.tool === "mark_notification_read" && e.action === "completed")).toBe(true);
	});

	it("surfaces the route's 404 for an id that is not the caller's, and does NOT audit it as completed", async () => {
		const h = setup({ status: 404, body: { error: "Notification not found" } });
		const res = await h.run("mark_notification_read", { notification_id: "nope" });
		expect(res.content[0].text).toContain("Notification not found");
		expect(h.events().some((e) => e.action === "completed")).toBe(false);
	});

	it("is refused without write scope, before any request", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("mark_notification_read", { notification_id: "n1" });
		expect(h.calls).toHaveLength(0);
	});
});

describe("mark_all_notifications_read", () => {
	it("posts to read-all", async () => {
		const h = setup();
		await h.run("mark_all_notifications_read");
		expect(h.calls).toEqual([{ url: "https://api.test/v1/notifications/read-all", method: "POST", body: null }]);
	});

	it("dry_run touches no network", async () => {
		const h = setup();
		const res = await h.run("mark_all_notifications_read", { dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, tool: "mark_all_notifications_read" });
	});
});

describe("get_account_preferences", () => {
	it("reads the preferences route", async () => {
		const h = setup();
		await h.run("get_account_preferences");
		expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.test/v1/preferences"]);
	});
});

describe("set_account_preferences — a section patch must not touch the sections it does not name", () => {
	const put = (h: ReturnType<typeof setup>) => {
		const call = h.calls.find((c) => c.method === "PUT" && c.url === "https://api.test/v1/preferences");
		if (!call) throw new Error("no PUT /v1/preferences was sent");
		return JSON.parse(call.body ?? "{}") as Record<string, unknown>;
	};

	it("sends ONLY the section the caller supplied", async () => {
		const h = setup();
		await h.run("set_account_preferences", { timezone: "Australia/Melbourne" });
		expect(put(h)).toEqual({ timezone: "Australia/Melbourne" });
	});

	it("forwards timezone null as a clear, not as an omission", async () => {
		const h = setup();
		await h.run("set_account_preferences", { timezone: null });
		expect(put(h)).toEqual({ timezone: null });
	});

	it("passes the notifications section through whole, and leaves voice and translation absent", async () => {
		const h = setup();
		await h.run("set_account_preferences", { notifications: { muted: ["deploy"], instances: ["inst-1"] } });
		expect(put(h)).toEqual({ notifications: { muted: ["deploy"], instances: ["inst-1"] } });
	});

	it("dry_run previews the exact body and names every section it will leave alone", async () => {
		const h = setup();
		const res = await h.run("set_account_preferences", { voice: { speed: 1.2 }, dry_run: true });
		expect(h.calls).toHaveLength(0);
		const preview = JSON.parse(res.content[0].text) as { wouldDo: { body: unknown; unchanged: string[] } };
		expect(preview.wouldDo.body).toEqual({ voice: { speed: 1.2 } });
		expect(preview.wouldDo.unchanged.sort()).toEqual(["notifications", "timezone", "translation"]);
	});

	it("does not audit a rejected write as completed", async () => {
		const h = setup({ status: 400, body: { error: "timezone must be an IANA zone name, e.g. Australia/Sydney" } });
		const res = await h.run("set_account_preferences", { timezone: "Mars/Olympus" });
		expect(res.content[0].text).toContain("IANA");
		expect(h.events().some((e) => e.action === "completed")).toBe(false);
	});

	it("names exactly the sections the API route accepts — read from the route, not re-typed", () => {
		// The route's own body type is the source of truth: a section added there and not here is a
		// preference an MCP caller silently cannot set.
		const route = readFileSync(resolve(HERE, "../../../api/src/routes/preferences.ts"), "utf8");
		const bodyType = /const body = \(await c\.req\.json\(\)\.catch\(\(\) => \(\{\}\)\)\) as \{([\s\S]*?)\};/.exec(route);
		expect(bodyType, "could not find the PUT body type in routes/preferences.ts — this guard is measuring nothing").not.toBeNull();
		const routeSections = [...(bodyType?.[1] ?? "").matchAll(/(\w+)\?:/g)].map((m) => m[1]).sort();
		expect(routeSections.length).toBeGreaterThan(0);
		expect([...ACCOUNT_PREFERENCE_SECTIONS].sort()).toEqual(routeSections);
		// And every section is a real argument of the tool.
		const h = setup();
		const shape = h.tools.get("set_account_preferences")?.schema ?? {};
		for (const s of ACCOUNT_PREFERENCE_SECTIONS) expect(Object.keys(shape), s).toContain(s);
	});
});
