/**
 * #1241 — what every tool does with arguments a model got slightly wrong, at the one `tools/call` seam.
 * The pure helpers first, then the real server over a real client: the same fixes and errors reach a
 * caller on any tool, with no per-tool code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { actionableInputError, closestToolNames, normalizeArguments, toSnake } from "./argument-normalize.js";

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

const SHAPE = {
	token: z.string().optional(),
	instance_id: z.string().describe("Instance ID or slug from my_instances."),
	labels: z.string().optional().describe("Comma-separated labels."),
	repo_ids: z.array(z.string()).optional(),
	limit: z.coerce.number().int().min(1).max(50).optional(),
	state: z.enum(["open", "closed"]).optional(),
};

describe("normalizeArguments (#1241)", () => {
	it("renames a camelCase key the schema has in snake_case, and says so", () => {
		expect(toSnake("instanceId")).toBe("instance_id");
		expect(toSnake("repoIDs")).toBe("repo_ids");
		const { args, warnings } = normalizeArguments(SHAPE, { instanceId: "i1", limit: 5 });
		expect(args).toEqual({ instance_id: "i1", limit: 5 });
		expect(warnings).toEqual(["`instanceId` was read as `instance_id` — argument names are snake_case."]);
	});

	it("never overwrites a snake_case key the caller also sent", () => {
		const { args, warnings } = normalizeArguments(SHAPE, { instance_id: "real", instanceId: "stale" });
		expect(args.instance_id).toBe("real");
		expect(warnings.join(" ")).toMatch(/Ignored an argument this tool does not take: `instanceId`/);
	});

	it("joins a list where a comma string is expected, and splits a comma string where a list is", () => {
		const { args, warnings } = normalizeArguments(SHAPE, { instance_id: "i1", labels: ["bug", "p1"], repo_ids: "r1, r2" });
		expect(args).toMatchObject({ labels: "bug,p1", repo_ids: ["r1", "r2"] });
		expect(warnings).toEqual(['`labels` takes a comma-separated string; the list was joined as "bug,p1".', '`repo_ids` takes a list; "r1, r2" was split on commas.']);
	});

	it("reads a stringified boolean or number as the type the schema declares", () => {
		const shape = { flag: z.boolean().optional(), n: z.number().optional() };
		const { args, warnings } = normalizeArguments(shape, { flag: "true", n: "12" });
		expect(args).toEqual({ flag: true, n: 12 });
		expect(warnings).toEqual(['`flag` takes a boolean; "true" was read as true.', '`n` takes a number; "12" was read as 12.']);
		expect(normalizeArguments(shape, { flag: "yes", n: "lots" }).args).toEqual({ flag: "yes", n: "lots" });
	});

	it("names an argument the tool does not take, instead of zod stripping it unseen", () => {
		expect(normalizeArguments(SHAPE, { instance_id: "i1", colour: "red" }).warnings).toEqual(["Ignored an argument this tool does not take: `colour`."]);
	});

	it("leaves a correct call, and a tool with no schema, exactly as they were", () => {
		expect(normalizeArguments(SHAPE, { instance_id: "i1", labels: "bug" })).toEqual({ args: { instance_id: "i1", labels: "bug" }, warnings: [] });
		expect(normalizeArguments(undefined, { anything: 1 })).toEqual({ args: { anything: 1 }, warnings: [] });
	});
});

describe("actionableInputError (#1241)", () => {
	it("names each bad argument and why, lists what the tool takes, and gives a corrected example", () => {
		const msg = actionableInputError("list_things", SHAPE, { limit: "lots", state: "pending" }, "Input validation error: Invalid arguments for tool list_things: [...]");
		expect(msg).toMatch(/^Input validation error: Invalid arguments for tool list_things\./);
		expect(msg).toContain("- `instance_id` is required but missing");
		expect(msg).toMatch(/- `limit` expected number, received nan/);
		expect(msg).toMatch(/- `state` invalid enum value/i);
		expect(msg).toContain("- `instance_id` (string, required) — Instance ID or slug from my_instances.");
		expect(msg).toContain('- `state` ("open" | "closed", optional)');
		expect(msg).not.toContain("`token`");
		expect(msg).toContain('Corrected example: {"instance_id":"<instance_id>","limit":1,"state":"open"}');
	});
});

describe("closestToolNames (#1241)", () => {
	it("suggests the nearest real tools for a guessed name", () => {
		const tools = ["coding_loop_start", "coding_loop_status", "start_instance_loop", "list_instance_tools", "my_instances"];
		expect(closestToolNames("codingLoopStart", tools)[0]).toBe("coding_loop_start");
		expect(closestToolNames("list_instances", tools)).toContain("my_instances");
	});
});

// ── The real server, over a real client ─────────────────────────────────────────────────────────

const { PagsMcp } = await import("./index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let sent: Array<{ path: string; method: string; body: string | null }>;
beforeEach(() => {
	sent = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		sent.push({ path: url.pathname, method: init?.method ?? "GET", body: (init?.body as string | undefined) ?? null });
		const body = url.pathname === "/v1/instances/my/instances" ? { instances: [] } : { success: true, name: "Alpha" };
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
});
afterEach(() => vi.unstubAllGlobals());

async function connect() {
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	const kv = new Map<string, string>();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k), list: async () => ({ keys: [], list_complete: true }) }, GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "pags-args", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
	return async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
		return { isError: r.isError === true, texts: r.content.map((c) => c.text) };
	};
}

describe("every tool, through the real server (#1241)", () => {
	it("a camelCase key reaches the tool as its snake_case argument, and the reply says so", async () => {
		const call = await connect();
		const r = await call("rename_instance", { instanceId: "i1", name: "Alpha" });
		expect(r.isError).toBe(false);
		expect(sent.find((s) => s.method === "PUT")?.path).toBe("/v1/instances/i1/name");
		expect(r.texts.at(-1)).toBe("Note:\n- `instanceId` was read as `instance_id` — argument names are snake_case.");
	});

	it("a call the schema still refuses gets the actionable error, with the rewrite noted", async () => {
		const call = await connect();
		const r = await call("get_instance_operator_manual", { instanceID: 42 });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toMatch(/^Input validation error: Invalid arguments for tool get_instance_operator_manual\./);
		expect(r.texts[0]).toMatch(/- `instance_id` expected string, received number/);
		expect(r.texts[0]).toMatch(/get_instance_operator_manual takes:\n- `instance_id` \(string, required\)/);
		expect(r.texts[0]).toMatch(/Corrected example: \{"instance_id":"<instance_id>"\}/);
		expect(r.texts[0]).toContain("`instanceID` was read as `instance_id`");
		// And a required argument left out entirely is named as missing.
		const missing = await call("get_instance_operator_manual", {});
		expect(missing.texts[0]).toContain("- `instance_id` is required but missing");
		expect(sent.some((s) => s.path.includes("/operator-manual"))).toBe(false);
	});

	it("an unknown tool name suggests the nearest real ones", async () => {
		const call = await connect();
		const r = await call("renameInstance", { instance_id: "i1", name: "x" });
		expect(r.isError).toBe(true);
		expect(r.texts[0]).toMatch(/^Tool renameInstance not found\. Did you mean `rename_instance`/);
	});

	it("a correct call is answered exactly as before — no note appended", async () => {
		const call = await connect();
		const r = await call("rename_instance", { instance_id: "i1", name: "Alpha" });
		expect(r.texts.some((t) => t.startsWith("Note:"))).toBe(false);
	});
});
