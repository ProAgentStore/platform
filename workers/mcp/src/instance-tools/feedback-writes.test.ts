import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerObservabilityTools } from "./observability.js";

// ── #613, the product-feedback group ─────────────────────────────────────────
//
// `record_instance_feedback` (POST /v1/feedback) and `delete_feedback` (DELETE /v1/feedback/:id).
// Thin proxies, so what is pinned is what a proxy gets wrong — route, method, body, that `dry_run`
// touches no network, that a refused call is not audited as completed — plus the two things these
// add: every filed row is stamped `context.via = "mcp"` (the row is evidence of the OWNER's words,
// so a reader must be able to tell a complaint filed by a model from one typed in the console),
// and a hard delete needs the destructive scope AND a confirmation. The route's body keys are held
// to `routes/feedback.ts` at the end, because a misspelt key there is silently dropped.
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
		return new Response(JSON.stringify(opts.body ?? { ok: true, feedback: { id: "fb-1" } }), {
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
	registerObservabilityTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
		{ tool: (name: string, _d: string, _s: Shape, handler: Handler) => tools.set(name, handler) } as any,
		{
			env,
			tokenFor: (t?: string) => t || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime", "destructive"]) as SafetyContext["scopes"] }),
			groups: new Set<string>(),
		},
	);
	const run = (name: string, args: Record<string, unknown>) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h(args);
	};
	const completed = () =>
		[...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

describe("record_instance_feedback", () => {
	it("POSTs the owner's words as author `user`, stamped as filed over MCP, and audits it", async () => {
		const h = setup();
		await h.run("record_instance_feedback", { instance_id: "inst-1", body: "It said it pushed, it did not." });
		expect(h.calls).toEqual([
			{
				url: "https://api.test/v1/feedback",
				method: "POST",
				body: { instanceId: "inst-1", body: "It said it pushed, it did not.", author: "user", context: { via: "mcp" } },
			},
		]);
		expect(h.completed().map((e) => e.tool)).toEqual(["record_instance_feedback"]);
	});

	it("maps each supplied anchor to the route's camelCase key, and sends none that were not supplied", async () => {
		const h = setup();
		await h.run("record_instance_feedback", {
			instance_id: "inst-1",
			body: "wrong file",
			sentiment: "bad",
			surface: "coding",
			trace_id: "t-1",
			message_id: "m-1",
			session_id: "csess_1",
			target_text: "Edited src/a.ts",
		});
		expect(h.calls[0]?.body).toEqual({
			instanceId: "inst-1",
			body: "wrong file",
			author: "user",
			context: { via: "mcp" },
			sentiment: "bad",
			surface: "coding",
			traceId: "t-1",
			messageId: "m-1",
			sessionId: "csess_1",
			targetText: "Edited src/a.ts",
		});
	});

	it("refuses a blank body without a request", async () => {
		const h = setup();
		const res = await h.run("record_instance_feedback", { instance_id: "inst-1", body: "  \n" });
		expect(res.content[0].text).toMatch(/body is required/);
		expect(h.calls).toHaveLength(0);
	});

	it("surfaces the route's 404 for an instance that is not yours, and does not audit it as completed", async () => {
		const h = setup({ status: 404, body: { error: "Instance not found" } });
		const res = await h.run("record_instance_feedback", { instance_id: "someone-elses", body: "x" });
		expect(res.content[0].text).toContain("Instance not found");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run touches no network and says the row is permanent and marked as MCP-filed", async () => {
		const h = setup();
		const res = JSON.parse((await h.run("record_instance_feedback", { instance_id: "inst-1", body: "x", trace_id: "t", dry_run: true })).content[0].text);
		expect(h.calls).toHaveLength(0);
		expect(res).toMatchObject({ dryRun: true, wouldDo: { method: "POST", fields: ["instanceId", "body", "author", "traceId"] } });
		expect(res.wouldDo.effect).toMatch(/marked as filed over MCP/);
	});

	it("is refused without write scope, before any request", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("record_instance_feedback", { instance_id: "inst-1", body: "x" });
		expect(h.calls).toHaveLength(0);
	});
});

describe("delete_feedback", () => {
	it("DELETEs the row, URL-encoding its id, once confirmed", async () => {
		const h = setup({ body: { ok: true } });
		await h.run("delete_feedback", { feedback_id: "fb/1", confirm: "delete_feedback" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/feedback/fb%2F1", method: "DELETE", body: null }]);
		expect(h.completed().map((e) => e.tool)).toEqual(["delete_feedback"]);
	});

	it.each([
		["no confirm", undefined],
		["the wrong confirm", "yes"],
	])("refuses with %s, without a request", async (_label, confirm) => {
		const h = setup();
		await h.run("delete_feedback", { feedback_id: "fb-1", confirm });
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("is refused without the destructive scope, even confirmed", async () => {
		const h = setup({ scopes: ["read", "write", "runtime"] });
		await h.run("delete_feedback", { feedback_id: "fb-1", confirm: "delete_feedback" });
		expect(h.calls).toHaveLength(0);
	});

	it("dry_run needs no confirm, touches no network, and names the non-destructive alternative", async () => {
		const h = setup();
		const res = JSON.parse((await h.run("delete_feedback", { feedback_id: "fb-1", dry_run: true })).content[0].text);
		expect(h.calls).toHaveLength(0);
		expect(res).toMatchObject({ dryRun: true, wouldDo: { method: "DELETE" } });
		expect(res.wouldDo.alternative).toMatch(/resolve_feedback with status "dismissed"/);
	});

	it("surfaces the route's 404 and does not audit it as completed", async () => {
		const h = setup({ status: 404, body: { error: "Feedback not found" } });
		const res = await h.run("delete_feedback", { feedback_id: "gone", confirm: "delete_feedback" });
		expect(res.content[0].text).toContain("Feedback not found");
		expect(h.completed()).toHaveLength(0);
	});
});

describe("the POST body keys are the route's own", () => {
	it("every key record_instance_feedback sends is one routes/feedback.ts reads", async () => {
		const route = readFileSync(resolve(HERE, "../../../api/src/routes/feedback.ts"), "utf8");
		const post = route.slice(route.indexOf('feedbackRoutes.post("/"'), route.indexOf('feedbackRoutes.get("/"'));
		expect(post.length, "could not find the POST handler in routes/feedback.ts — this guard is measuring nothing").toBeGreaterThan(200);
		const read = new Set([...post.matchAll(/body\.(\w+)/g)].map((m) => m[1]));
		const h = setup();
		await h.run("record_instance_feedback", {
			instance_id: "i",
			body: "b",
			sentiment: "good",
			surface: "chat",
			trace_id: "t",
			message_id: "m",
			session_id: "s",
			target_text: "x",
		});
		const sent = Object.keys(h.calls[0]?.body as Record<string, unknown>);
		expect(sent.filter((k) => !read.has(k))).toEqual([]);
	});
});
