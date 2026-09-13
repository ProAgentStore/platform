import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerKnowledgeTools } from "./instance-tools/knowledge.js";
import type { SafetyContext } from "./safety.js";
import { registerStorageTools } from "./storage-tools.js";

// ── #613, the knowledge-writes group ──────────────────────────────────────────
//
// `update_instance_knowledge`, `ingest_instance_knowledge_url` and `update_instance_record` are thin
// proxies, so the tests pin what a proxy gets wrong: route and method, that an edit sends ONLY what
// the caller named (both routes keep an absent field, so a manufactured one is an edit nobody asked
// for), that ids are URL-encoded, that `dry_run` never touches the network — for the URL tool that
// means the page is NOT fetched to preview it — and that a refused call is not audited as completed.
// Driven through the real safety layer and `authedCall`; only `fetch` and the audit KV are stubbed.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw === null ? null : JSON.parse(raw) });
		return new Response(JSON.stringify(opts.body ?? { id: "doc-1" }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
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
	registerKnowledgeTools(server, { env, tokenFor, safetyFor, groups: new Set<string>() });
	registerStorageTools(server, env, tokenFor, safetyFor);
	const run = (name: string, args: Record<string, unknown>) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h({ instance_id: "inst 1", ...args });
	};
	const completed = () => [...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

describe("update_instance_knowledge", () => {
	it("PUTs to the document, URL-encoding its id, with only the fields supplied", async () => {
		const h = setup();
		await h.run("update_instance_knowledge", { document_id: "doc/1", title: "New title" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst 1/knowledge/doc%2F1", method: "PUT", body: { title: "New title" } }]);
		expect(h.completed().map((e) => e.tool)).toEqual(["update_instance_knowledge"]);
	});

	it("sends content alone when only content is given — an empty title is never manufactured", async () => {
		const h = setup();
		await h.run("update_instance_knowledge", { document_id: "d", content: "body" });
		expect(h.calls[0]?.body).toEqual({ content: "body" });
	});

	it("refuses an edit that names no field, without a request", async () => {
		const h = setup();
		const res = await h.run("update_instance_knowledge", { document_id: "d" });
		expect(res.content[0].text).toMatch(/nothing to update/);
		expect(h.calls).toHaveLength(0);
	});

	it("surfaces the route's 404 and does not audit it as completed", async () => {
		const h = setup({ status: 404, body: { error: "not found" } });
		const res = await h.run("update_instance_knowledge", { document_id: "gone", content: "x" });
		expect(res.content[0].text).toContain("not found");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run touches no network and says which fields would change", async () => {
		const h = setup();
		const res = await h.run("update_instance_knowledge", { document_id: "d", content: "héllo", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "PUT", fields: ["content"], bytes: 6 } });
	});
});

describe("ingest_instance_knowledge_url", () => {
	it("POSTs the url to ingest-url, and omits title unless given", async () => {
		const h = setup();
		await h.run("ingest_instance_knowledge_url", { url: "https://example.com/a" });
		await h.run("ingest_instance_knowledge_url", { url: "https://example.com/b", title: "B" });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst 1/knowledge/ingest-url", method: "POST", body: { url: "https://example.com/a" } },
			{ url: "https://api.test/v1/instances/inst 1/knowledge/ingest-url", method: "POST", body: { url: "https://example.com/b", title: "B" } },
		]);
	});

	it("dry_run does NOT fetch the page, or anything else", async () => {
		const h = setup();
		await h.run("ingest_instance_knowledge_url", { url: "https://example.com", dry_run: true });
		expect(h.calls).toHaveLength(0);
	});

	it("surfaces a refusal (a full knowledge base, a non-public host) and does not audit it as completed", async () => {
		const h = setup({ status: 400, body: { error: "Knowledge base full (max 20 documents)" } });
		const res = await h.run("ingest_instance_knowledge_url", { url: "https://example.com" });
		expect(res.content[0].text).toContain("Knowledge base full");
		expect(h.completed()).toHaveLength(0);
	});

	it("is refused without write scope, before any request", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("ingest_instance_knowledge_url", { url: "https://example.com" });
		expect(h.calls).toHaveLength(0);
	});
});

describe("update_instance_record", () => {
	it("PUTs the fields to merge as `data`, URL-encoding collection and record id", async () => {
		const h = setup({ body: { id: "r 1", data: { status: "submitted" } } });
		await h.run("update_instance_record", { collection: "jobs", record_id: "r 1", data: '{"status":"submitted"}' });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst 1/collections/jobs/records/r%201", method: "PUT", body: { data: { status: "submitted" } } },
		]);
		expect(h.completed().map((e) => e.tool)).toEqual(["update_instance_record"]);
	});

	it.each([
		["not JSON", "{status:", "Invalid data JSON"],
		["an array", "[1,2]", "must be a JSON object"],
		["a scalar", "42", "must be a JSON object"],
	])("refuses data that is %s, without a request", async (_label, data, message) => {
		const h = setup();
		const res = await h.run("update_instance_record", { collection: "jobs", record_id: "r", data });
		expect(res.content[0].text).toContain(message);
		expect(h.calls).toHaveLength(0);
	});

	it("surfaces Not found and does not audit it as completed", async () => {
		const h = setup({ status: 404, body: { error: "Not found" } });
		const res = await h.run("update_instance_record", { collection: "jobs", record_id: "nope", data: "{}" });
		expect(res.content[0].text).toContain("Not found");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run touches no network and names the fields", async () => {
		const h = setup();
		const res = await h.run("update_instance_record", { collection: "jobs", record_id: "r", data: '{"a":1,"b":2}', dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "PUT", fields: ["a", "b"] } });
	});
});
