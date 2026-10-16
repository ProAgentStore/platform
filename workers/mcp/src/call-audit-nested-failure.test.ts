/**
 * #1118 — a nested tool that answers `{success:false}` is audited as `failed`, never `completed`.
 *
 * The live case: `call_instance_tool` → `github_workflow_run_logs`, the API answered HTTP 200 with
 * `{success:false}` and no `error`, the handler's own audit said `result.ok: false` — and the #1089
 * call event said `action: "completed"`, because the outcome classifier knew only `error`, `Error:`
 * text, `isError` and `outcome:"unknown"`.
 *
 * Driven through the REAL pipeline: `PagsMcp.init()`, a real `Client` over `InMemoryTransport`, a KV
 * ledger. Only the API's network edge is simulated. Covered: `call_instance_tool`, and the same tool
 * published under its own name on a pinned `/mcp/i/<id>` session (#783) — the two paths `auditOk`
 * judges. What the CALLER receives is asserted unchanged.
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

const { PagsMcp } = await import("./index.js");
const { classifyReturn, explain } = await import("./call-audit.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const INSTANCE = "inst-1118";
const TOOL = "github_workflow_run_logs";
/** The API's answer for the nested call: HTTP 200, a refusal, no `error` — the shape #726 describes. */
let nested: unknown;
let store: Map<string, string>;

const LISTING = {
	tools: [
		{
			name: TOOL,
			description: "Read a workflow run's logs.",
			allowed: true,
			mutates: false,
			scope: "read",
			invocableBy: ["chat", "call_instance_tool"],
			jsonSchema: { type: "object", properties: { repo: { type: "string" }, run_id: { type: "number" } }, required: ["repo", "run_id"] },
		},
	],
};

beforeEach(() => {
	store = new Map();
	nested = { success: false, content: "This instance may not read workflow logs for that repository." };
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		const body =
			url.pathname === `/v1/instances/${INSTANCE}/tools/${TOOL}`
				? nested
				: url.pathname === `/v1/instances/${INSTANCE}/tools`
					? LISTING
					: url.pathname === "/v1/instances/my/instances"
						? { instances: [] }
						: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
});

async function connect(opts: { pinned?: string } = {}) {
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => ({
			keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })),
			list_complete: true,
			cursor: undefined,
			cacheStatus: null,
		}),
	} as unknown as KVNamespace;
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1", ...(opts.pinned ? { pinnedInstance: opts.pinned } : {}) };
	await inst.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "call-audit-1118", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
	return async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text;
}

/** Every audit event in the ledger for `tool`, however it is keyed. */
function ledger(tool: string): Array<Record<string, unknown>> {
	const seen = new Map<string, Record<string, unknown>>();
	for (const v of store.values()) {
		try {
			const e = JSON.parse(v) as Record<string, unknown>;
			if (e && e.tool === tool && typeof e.id === "string") seen.set(e.id, e);
		} catch {
			// a counter, not an event
		}
	}
	return [...seen.values()];
}

describe("a nested tool's {success:false} is audited as failed (#1118)", () => {
	it("call_instance_tool: one event, action failed with the fixed reason — read back through mcp_audit_log — and the caller's reply unchanged", async () => {
		const call = await connect();
		const reply = await call("call_instance_tool", { instance_id: INSTANCE, tool: TOOL, input: { repo: "o/r", run_id: 1 } });
		// The caller gets what it always got: the API's answer, refusal and all.
		expect(JSON.parse(reply)).toMatchObject({ success: false, content: expect.stringMatching(/may not read workflow logs/) });

		const page = JSON.parse(await call("mcp_audit_log", { tool: "call_instance_tool" })) as { events: Array<Record<string, unknown>> };
		expect(page.events).toHaveLength(1);
		expect(page.events[0]).toMatchObject({ tool: "call_instance_tool", action: "failed", failureClass: "returned_error", reason: "success_false", input: { invoked: TOOL }, result: { ok: false } });
		expect(page.events[0].explanation).toBe(explain({ action: "failed", reason: "success_false" }));
		expect(page.events[0].explanation).not.toMatch(/returned\. Work it started/);
	});

	it("the same tool on a pinned /mcp/i/<id> session: failed, not completed", async () => {
		const call = await connect({ pinned: INSTANCE });
		const reply = await call(TOOL, { repo: "o/r", run_id: 1 });
		expect(JSON.parse(reply)).toMatchObject({ success: false });
		const events = ledger(TOOL);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "failed", reason: "success_false", result: { ok: false } });
	});

	it("a nested call that succeeds is still completed — on both paths", async () => {
		nested = { success: true, content: "log lines" };
		const call = await connect();
		await call("call_instance_tool", { instance_id: INSTANCE, tool: TOOL, input: { repo: "o/r", run_id: 1 } });
		const page = JSON.parse(await call("mcp_audit_log", { tool: "call_instance_tool" })) as { events: Array<Record<string, unknown>> };
		expect(page.events[0]).toMatchObject({ action: "completed", result: { ok: true } });
		const pinned = await connect({ pinned: INSTANCE });
		await pinned(TOOL, { repo: "o/r", run_id: 1 });
		// A successful READ is not written at all (#1089) — and it is certainly not a failure.
		expect(ledger(TOOL).filter((e) => e.action === "failed")).toEqual([]);
	});

	it("classifyReturn: a returned {success:false} body is failed on its own; success:true and an absent field are not", () => {
		const as = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
		expect(classifyReturn(as({ success: false, content: "no" }))).toEqual({ action: "failed", failureClass: "returned_error", reason: "success_false" });
		expect(classifyReturn(as({ success: true }))).toEqual({ action: "completed" });
		expect(classifyReturn(as({ content: "fine" }))).toEqual({ action: "completed" });
		// `error` keeps its own, more specific verdict.
		expect(classifyReturn(as({ success: false, error: "Tool API 403: forbidden" }))).toMatchObject({ action: "failed", failureClass: "upstream", reason: "api_403" });
	});
});
