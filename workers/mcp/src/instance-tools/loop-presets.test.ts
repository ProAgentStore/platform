import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { MAX_LOOP_PRESETS, MAX_PRESET_LABEL, MAX_PRESET_OBJECTIVE, loopPresetProblems, registerCompositionTools } from "./composition.js";

// ── #613, the loop-presets group ──────────────────────────────────────────────
//
// `get_instance_loop_presets` and `set_instance_loop_presets` proxy `/v1/instances/:id/loop-presets`.
// What is worth pinning is what a proxy gets wrong — route, method, body, that `dry_run` touches no
// network, that a refused call is not audited as completed — plus the one thing this tool adds: the
// route silently drops or trims an out-of-limit list and answers 200, so the tool refuses that list
// before sending it. The limits are a copy of the API's, and the last test holds them to its source.
// Driven through the real safety layer and `authedCall`; only `fetch` and the audit KV are stubbed.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

const HERE = dirname(fileURLToPath(import.meta.url));

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw === null ? null : JSON.parse(raw) });
		return new Response(JSON.stringify(opts.body ?? { presets: [], source: "default", driver: "chat" }), {
			status: opts.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
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
	registerCompositionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
		{ tool: (name: string, _d: string, _s: Shape, handler: Handler) => tools.set(name, handler) } as any,
		{
			env,
			tokenFor: (t?: string) => t || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] }),
			groups: new Set<string>(),
		},
	);
	const run = (name: string, args: Record<string, unknown>) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h({ instance_id: "inst 1", ...args });
	};
	const completed = () =>
		[...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

const preset = (label: string, objective = `Do ${label}`) => ({ label, objective });

describe("get_instance_loop_presets", () => {
	it("GETs the resolved list, URL-encoding the instance id, and passes it through", async () => {
		const body = { presets: [{ id: "bugs", label: "Fix bugs", objective: "Find and fix all bugs." }], source: "default", driver: "coding" };
		const h = setup({ body });
		const res = await h.run("get_instance_loop_presets", {});
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst%201/loop-presets", method: "GET", body: null }]);
		expect(JSON.parse(res.content[0].text)).toEqual(body);
	});
});

describe("set_instance_loop_presets", () => {
	it("PUTs the whole list as `presets` and audits the call as completed", async () => {
		const h = setup({ body: { presets: [{ id: "a", label: "A", objective: "Do A" }], source: "instance", driver: "chat" } });
		await h.run("set_instance_loop_presets", { presets: [{ id: "a", ...preset("A") }] });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst%201/loop-presets", method: "PUT", body: { presets: [{ id: "a", label: "A", objective: "Do A" }] } },
		]);
		expect(h.completed().map((e) => e.tool)).toEqual(["set_instance_loop_presets"]);
	});

	it("sends an empty list — the route's way of clearing the instance's own list", async () => {
		const h = setup();
		await h.run("set_instance_loop_presets", { presets: [] });
		expect(h.calls[0]).toMatchObject({ method: "PUT", body: { presets: [] } });
	});

	it.each([
		["too many presets", Array.from({ length: MAX_LOOP_PRESETS + 1 }, (_, i) => preset(`P${i}`)), /13 presets sent, at most 12/],
		["a blank label", [preset("  ")], /preset 1 has a blank label/],
		["a blank objective", [preset("ok"), { label: "B", objective: "\n" }], /preset 2 has a blank objective/],
		["an over-long label", [preset("x".repeat(MAX_PRESET_LABEL + 1))], /label is 61 chars \(max 60\)/],
		["an over-long objective", [{ label: "L", objective: "y".repeat(MAX_PRESET_OBJECTIVE + 1) }], /objective is 1001 chars \(max 1000\)/],
	])("refuses %s whole, without a request", async (_label, presets, message) => {
		const h = setup();
		const res = await h.run("set_instance_loop_presets", { presets });
		expect(res.content[0].text).toMatch(/^Error: nothing saved/);
		expect(res.content[0].text).toMatch(message);
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("surfaces the route's 404 and does not audit it as completed", async () => {
		const h = setup({ status: 404, body: { error: "instance not found" } });
		const res = await h.run("set_instance_loop_presets", { presets: [preset("A")] });
		expect(res.content[0].text).toContain("instance not found");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run touches no network and says whether the list is replaced or cleared", async () => {
		const h = setup();
		const replace = JSON.parse((await h.run("set_instance_loop_presets", { presets: [preset("A"), preset("B")], dry_run: true })).content[0].text);
		const clear = JSON.parse((await h.run("set_instance_loop_presets", { presets: [], dry_run: true })).content[0].text);
		expect(h.calls).toHaveLength(0);
		expect(replace).toMatchObject({ dryRun: true, wouldDo: { method: "PUT", labels: ["A", "B"] } });
		expect(replace.wouldDo.effect).toMatch(/replacing/);
		expect(clear.wouldDo.effect).toMatch(/removed; it would inherit/);
	});

	it("is refused without write scope, before any request", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("set_instance_loop_presets", { presets: [preset("A")] });
		expect(h.calls).toHaveLength(0);
	});
});

describe("loopPresetProblems", () => {
	it("accepts a list at every limit exactly, and measures after trimming as the route does", () => {
		const full = Array.from({ length: MAX_LOOP_PRESETS }, () => ({ label: ` ${"l".repeat(MAX_PRESET_LABEL)} `, objective: "o".repeat(MAX_PRESET_OBJECTIVE) }));
		expect(loopPresetProblems(full)).toEqual([]);
	});

	it("holds the copied limits to workers/api/src/lib/loop-presets.ts", () => {
		const src = readFileSync(resolve(HERE, "../../../api/src/lib/loop-presets.ts"), "utf8");
		const read = (name: string) => {
			const m = new RegExp(`export const ${name} = (\\d+);`).exec(src);
			expect(m, `could not find ${name} in lib/loop-presets.ts — this guard is measuring nothing`).not.toBeNull();
			return Number(m?.[1]);
		};
		expect({ MAX_LOOP_PRESETS, MAX_PRESET_LABEL, MAX_PRESET_OBJECTIVE }).toEqual({
			MAX_LOOP_PRESETS: read("MAX_LOOP_PRESETS"),
			MAX_PRESET_LABEL: read("MAX_PRESET_LABEL"),
			MAX_PRESET_OBJECTIVE: read("MAX_PRESET_OBJECTIVE"),
		});
		// And the route still measures AFTER trimming, which is what `loopPresetProblems` assumes.
		expect(src).toMatch(/String\(e\.label \?\? ""\)\.trim\(\)\.slice\(0, MAX_PRESET_LABEL\)/);
		expect(src).toMatch(/String\(e\.objective \?\? ""\)\.trim\(\)\.slice\(0, MAX_PRESET_OBJECTIVE\)/);
	});
});
