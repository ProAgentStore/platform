/**
 * #1071 — collecting a `coding_loop_start` result whose answer was lost, over the WIRE: the real
 * `PagsMcp.init()` and a real `Client`, so the SDK's schema validation runs exactly as it does for a
 * caller. Only the API's network edge is simulated, and every request it receives is recorded.
 *
 *   - An argument-less re-issue used to be refused by schema validation as a missing `instance_id`,
 *     which reads as a new malformed call. It now reaches the handler, starts nothing, and says how
 *     to poll.
 *   - `coding_loop_start` with only instance_id + request_id is a POLL of that start, not "objective is
 *     required … not_started" — which told a caller whose start had landed that it had not.
 *   - `coding_loop_status` with request_id reads exactly that start.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { PagsMcp } = await import("../index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const INSTANCE = "inst-1071";
const POLL = `/v1/instances/${INSTANCE}/loop/starts/req-lost`;
const FOUND = { found: true, start: { requestId: "req-lost", startState: "started", current: { kind: "run", runId: "run-9" }, result: { runId: "run-9" } } };
let api: Array<{ path: string; method: string }>;

beforeEach(() => {
	api = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		api.push({ path: url.pathname, method: init?.method ?? "GET" });
		const body =
			url.pathname === "/v1/instances/my/instances"
				? { instances: [{ id: INSTANCE, agent_id: "a", name: "Coder", capabilities: { surfaces: ["coding"] } }] }
				: url.pathname === POLL
					? FOUND
					: url.pathname.startsWith(`/v1/instances/${INSTANCE}/loop/starts/`)
						? { found: false, requestId: url.pathname.split("/").at(-1), startState: "not_received", detail: "never arrived" }
						: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
});

async function connect() {
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "loop-start-poll", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
	return async (name: string, args: Record<string, unknown>) => {
		const res = await client.callTool({ name, arguments: args });
		return { isError: res.isError === true, text: (res.content as Array<{ text: string }>)[0].text };
	};
}
const starts = () => api.filter((a) => a.method === "POST" && a.path.endsWith("/loop"));

describe("collecting a lost coding_loop_start result (#1071)", () => {
	it("an argument-less re-issue is not a schema error: it starts nothing and says how to poll", async () => {
		const call = await connect();
		const r = await call("coding_loop_start", {});
		expect(r.text).not.toMatch(/Input validation error|missing required|invalid_type/i);
		expect(JSON.parse(r.text)).toMatchObject({ startState: "not_started", reason: "missing_instance_id", poll: { tool: "coding_loop_status" } });
		expect(JSON.parse(r.text).error).toMatch(/nothing was started.*coding_loop_status with instance_id and that start's request_id/s);
		expect(starts()).toEqual([]);
	});

	it("a re-issue carrying only an invented `_deferred_result_for` gets the same answer — not a bare schema error", async () => {
		const call = await connect();
		const r = await call("coding_loop_start", { _deferred_result_for: "req-lost" });
		expect(JSON.parse(r.text)).toMatchObject({ startState: "not_started", reason: "missing_instance_id" });
		expect(starts()).toEqual([]);
	});

	it("coding_loop_start with only instance_id + request_id POLLS that start — never 'objective is required, not_started'", async () => {
		const call = await connect();
		const r = JSON.parse((await call("coding_loop_start", { instance_id: INSTANCE, request_id: "req-lost" })).text);
		expect(r).toEqual({ poll: true, ...FOUND });
		expect(starts()).toEqual([]);
		expect(api.some((a) => a.path === POLL)).toBe(true);
	});

	it("coding_loop_status with request_id reads exactly that start; one that never arrived is `not_received`", async () => {
		const call = await connect();
		expect(JSON.parse((await call("coding_loop_status", { instance_id: INSTANCE, request_id: "req-lost" })).text)).toEqual(FOUND);
		expect(JSON.parse((await call("coding_loop_status", { instance_id: INSTANCE, request_id: "req-never" })).text)).toMatchObject({ found: false, startState: "not_received" });
		expect(starts()).toEqual([]);
	});

	it("a real start is unchanged: an objective with a request_id still STARTS", async () => {
		const call = await connect();
		await call("coding_loop_start", { instance_id: INSTANCE, request_id: "req-new", objective: "fix issue #1071", repo_id: "r1" });
		expect(starts()).toHaveLength(1);
		expect(api.some((a) => a.path.includes("/loop/starts/"))).toBe(false);
	});
});
