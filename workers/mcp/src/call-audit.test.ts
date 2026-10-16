/**
 * #1089 from the WIRE: the real `PagsMcp.init()`, a real `Client` over `InMemoryTransport`, and a KV
 * ledger that can refuse writes. Every call — refused, previewed, rejected by schema validation, thrown,
 * failed, completed, or answered into a reply that never arrives — leaves ONE metadata-only event, and
 * `mcp_audit_log` reads back why it ended the way it did. Only the API's network edge is simulated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { explain } = await import("./call-audit.js");
const { AUDIT_VALUE_MAX } = await import("./safety.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

type Reply = { status?: number; body?: unknown } | "throw";
type Route = (url: URL, method: string) => Reply | undefined;

let store: Map<string, { value: string; metadata?: unknown }>;
let refuseAuditWrites: boolean;
let routes: Route[];
let fetched: Array<{ path: string; method: string }>;

function kv(): KVNamespace {
	return {
		get: async (k: string) => store.get(k)?.value ?? null,
		put: async (k: string, value: string, opts?: { metadata?: unknown }) => {
			if (refuseAuditWrites && k.startsWith("audit_")) throw new Error("KV put failed: 503");
			store.set(k, { value, metadata: opts?.metadata });
		},
		delete: async (k: string) => void store.delete(k),
		list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
			return { keys: keys.map((name) => ({ name, metadata: store.get(name)?.metadata })), list_complete: true, cursor: undefined, cacheStatus: null };
		},
	} as unknown as KVNamespace;
}

beforeEach(() => {
	store = new Map();
	refuseAuditWrites = false;
	routes = [];
	fetched = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		const method = init?.method ?? "GET";
		fetched.push({ path: url.pathname, method });
		let reply: Reply | undefined;
		for (const r of routes) {
			reply = r(url, method);
			if (reply) break;
		}
		if (!reply && url.pathname === "/v1/instances/my/instances") reply = { body: { instances: [] } };
		if (reply === "throw") throw new TypeError("fetch failed");
		const { status = 200, body = {} } = reply ?? {};
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	});
});
afterEach(() => vi.unstubAllGlobals());

const on = (path: string, reply: Reply, method?: string): Route => (url, m) => (url.pathname === path && (!method || m === method) ? reply : undefined);

/** A connected client, and the JSON-RPC id of every `tools/call` the server received. */
async function connect(opts: { scopes?: string[]; dropReplies?: boolean } = {}) {
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv(), GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken: "session-token", mcpScopes: opts.scopes ?? ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "pags-call-audit", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
	const callIds: string[] = [];
	const received = serverTransport.onmessage!;
	serverTransport.onmessage = (message, extra) => {
		const m = message as { method?: string; id?: string | number };
		if (m.method === "tools/call") callIds.push(String(m.id));
		received(message, extra);
	};
	const send = serverTransport.send.bind(serverTransport);
	const dropped: string[] = [];
	serverTransport.send = async (message, o) => {
		const id = (message as { id?: string | number }).id;
		// The reply to a tool call is lost on the way back — the tool ran; the caller never hears.
		if (opts.dropReplies && id !== undefined && callIds.includes(String(id)) && "result" in message) {
			dropped.push(String(id));
			return;
		}
		return send(message, o);
	};
	const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
	const text = async (name: string, args: Record<string, unknown>) => ((await call(name, args)).content as Array<{ text: string }>)[0].text;
	return { client, call, text, callIds, dropped };
}

/** The caller's own ledger, read back the way a caller reads it: through `mcp_audit_log`. */
async function readBack(c: Awaited<ReturnType<typeof connect>>, filter: Record<string, unknown> = {}) {
	const page = JSON.parse(await c.text("mcp_audit_log", filter)) as { events: Array<Record<string, unknown>>; semantics: string };
	return page;
}

const owned = () => [...store.keys()].filter((k) => k.startsWith("audit_idx:"));

describe("one audit event per MCP call, read back with its reason (#1089)", () => {
	it("a completed write leaves ONE event — the handler's own audit is folded in, not duplicated", async () => {
		routes.push(on("/v1/instances/i1/name", { body: { success: true, name: "Alpha" } }, "PUT"));
		const c = await connect();
		await c.call("rename_instance", { instance_id: "i1", name: "Alpha" });
		const { events } = await readBack(c, { tool: "rename_instance" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "completed", input: { instance_id: "i1", name: "Alpha" }, receiptOf: "tool_call", requestId: c.callIds[0], gate: "passed" });
		expect(events[0].explanation).toMatch(/tracked by its own record/);
		expect(typeof events[0].durationMs).toBe("number");
	});

	it("a returned API error is recorded as failed with the status — not completed, not ok:true", async () => {
		routes.push(on("/v1/instances/i1/name", { status: 500, body: { error: "db down: secret detail" } }, "PUT"));
		const c = await connect();
		const res = await c.text("rename_instance", { instance_id: "i1", name: "Alpha" });
		expect(res).toMatch(/error/); // what the caller sees is unchanged
		const [e] = (await readBack(c, { tool: "rename_instance" })).events;
		expect(e).toMatchObject({ action: "failed", failureClass: "upstream", reason: "api_500" });
		expect(e.explanation).toMatch(/HTTP 500/);
		expect(JSON.stringify(e)).not.toContain("secret detail"); // the response body is never copied
	});

	it("a transport throw inside the handler is recorded as error with the exception's class, never its message", async () => {
		routes.push(on("/v1/instances/i1/name", "throw", "PUT"));
		const c = await connect();
		const res = await c.call("rename_instance", { instance_id: "i1", name: "Alpha" });
		expect(res.isError).toBe(true);
		const [e] = (await readBack(c, { tool: "rename_instance" })).events;
		expect(e).toMatchObject({ action: "error", failureClass: "exception", reason: "TypeError", input: { argKeys: ["instance_id", "name"], instance_id: "i1" } });
		expect(e.explanation).toMatch(/threw TypeError; .* may or may not have landed/);
		expect(JSON.stringify(e)).not.toContain("fetch failed");
		expect(JSON.stringify(e)).not.toContain("Alpha"); // argument values are not recorded
	});

	it("a schema-validation failure is recorded at the protocol boundary — the tool never ran", async () => {
		const c = await connect();
		const res = await c.call("rename_instance", { name: "x".repeat(10), instance_id: 42 });
		expect(res.isError).toBe(true);
		expect(fetched.some((f) => f.path.endsWith("/name"))).toBe(false);
		const [e] = (await readBack(c, { tool: "rename_instance" })).events;
		expect(e).toMatchObject({ action: "invalid_input", failureClass: "invalid_input", reason: "invalid_arguments", input: { argKeys: ["name", "instance_id"] }, requestId: c.callIds[0] });
		expect(e.explanation).toMatch(/did not match its input schema/);
		expect(e.gate).toBeUndefined(); // rejected before the gate
	});

	it("an unknown tool name is recorded without echoing the caller-supplied name", async () => {
		const c = await connect();
		await c.call("drop_table_users", {});
		const [e] = (await readBack(c)).events;
		expect(e).toMatchObject({ tool: "(unregistered)", action: "invalid_input", reason: "unknown_tool" });
		expect(JSON.stringify(e)).not.toContain("drop_table_users");
	});

	it("a scope denial is ONE denied event with the reason — not a denied row plus a call row", async () => {
		const c = await connect({ scopes: ["read"] });
		await c.call("rename_instance", { instance_id: "i1", name: "Alpha" });
		const { events } = await readBack(c, { tool: "rename_instance" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "denied", failureClass: "denied", reason: "missing_scope", requiredScope: "write" });
		expect(events[0].explanation).toMatch(/does not hold the scope/);
	});

	it("a confirmation denial is recorded as denied/missing_confirmation and nothing was deleted", async () => {
		const c = await connect();
		await c.call("delete_agent", { agent_id: "a1" });
		expect(fetched.some((f) => f.method === "DELETE")).toBe(false);
		const { events } = await readBack(c, { tool: "delete_agent" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "denied", reason: "missing_confirmation", expected: "delete_agent" });
	});

	it("a suspension denial — which never reaches the handler — is recorded", async () => {
		routes.push(on("/v1/auth/me", { status: 403, body: { error: "suspended" } }));
		const c = await connect();
		const res = await c.text("rename_instance", { instance_id: "i1", name: "Alpha" });
		expect(res).toMatch(/suspended/);
		routes.length = 0; // the read-back itself is made by an account in good standing
		const [e] = (await readBack(c, { tool: "rename_instance" })).events;
		expect(e).toMatchObject({ action: "denied", reason: "suspended", gate: "denied" });
		expect(fetched.some((f) => f.path.endsWith("/name"))).toBe(false);
	});

	it("a suspension check that could not be made is allowed (fail-open) and the event says so — even on a read", async () => {
		routes.push(on("/v1/auth/me", "throw"));
		const c = await connect();
		await c.call("get_instance_operator_manual", { instance_id: "i1" });
		routes.length = 0;
		const [e] = (await readBack(c, { tool: "get_instance_operator_manual" })).events;
		expect(e).toMatchObject({ action: "completed", gate: "unverified", gateReason: "api_unreachable" });
		expect(e.explanation).toMatch(/fail-open/);
	});

	it("a dry run is one dry_run event", async () => {
		const c = await connect();
		await c.call("rename_instance", { instance_id: "i1", name: "Alpha", dry_run: true });
		const { events } = await readBack(c, { tool: "rename_instance" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "dry_run", explanation: "Dry run: nothing was changed." });
	});

	it("a successful read is not written; a failed read is", async () => {
		routes.push(on("/v1/instances/i2/operator-manual", { status: 404, body: { error: "not found" } }));
		const c = await connect();
		await c.call("get_instance_operator_manual", { instance_id: "i1" });
		await c.call("get_instance_operator_manual", { instance_id: "i2" });
		const { events } = await readBack(c, { tool: "get_instance_operator_manual" });
		expect(events.map((e) => [e.action, (e.input as { instance_id?: string }).instance_id])).toEqual([["failed", "i2"]]);
	});

	it("a lost reply: the call ran, the caller timed out — its request id finds what happened and why", async () => {
		routes.push(on("/v1/instances/i1/name", { status: 409, body: { error: "conflict" } }, "PUT"));
		const c = await connect({ dropReplies: true });
		await expect(c.client.callTool({ name: "rename_instance", arguments: { instance_id: "i1", name: "Alpha" } }, undefined, { timeout: 200 })).rejects.toThrow(/timed out/i);
		expect(c.dropped).toEqual([c.callIds[0]]);
		// A fresh connection reads the ledger by the lost request's id.
		const reader = await connect();
		const { events, semantics } = await readBack(reader, { request_id: c.callIds[0], tool: "rename_instance" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "failed", reason: "api_409", requestId: c.callIds[0] });
		expect(semantics).toMatch(/failureClass/);
	});

	it("an audit sink failure never changes the tool's answer, and the loss is counted", async () => {
		routes.push(on("/v1/instances/i1/name", { body: { success: true, name: "Alpha" } }, "PUT"));
		const c = await connect();
		refuseAuditWrites = true;
		const res = await c.call("rename_instance", { instance_id: "i1", name: "Alpha" });
		expect(res.isError).toBeFalsy();
		expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toMatchObject({ success: true });
		expect(owned()).toEqual([]);
		const losses = [...store.entries()].filter(([k]) => k.startsWith("tel_loss:mcp_audit:"));
		expect(losses.map(([, v]) => v.value)).toEqual(["1"]);
	});

	it("an unattributable call (a token argument that does not verify) is filed cross-owner only, never in an owner's ledger", async () => {
		const c = await connect();
		await c.call("rename_instance", { instance_id: "i1", name: "Alpha", token: "not-a-valid-session" });
		expect(owned()).toEqual([]);
		const global = [...store.entries()].filter(([k]) => k.startsWith("audit_all:")).map(([, v]) => JSON.parse(v.value) as Record<string, unknown>);
		expect(global).toHaveLength(1);
		expect(global[0]).toMatchObject({ subject: "unattributed", attributed: false, tool: "rename_instance" });
		expect(JSON.stringify(global[0])).not.toContain("not-a-valid-session");
	});

	it("every explanation fits the audit's value limit — a longer one would be stored as a byte count", () => {
		const reasons = ["suspended", "missing_scope", "read_only", "missing_confirmation", "auth_required", "invalid_arguments", "unknown_tool", "tool_disabled", "output_validation", "protocol_error", "handler_failed", "is_error", "error_text", "error_field", "api_503"];
		const lines = [
			...reasons.map((reason) => explain({ action: "failed", reason })),
			explain({ action: "completed" }),
			explain({ action: "dry_run" }),
			explain({ action: "error", reason: "SyntaxError" }),
			explain({ action: "unknown", reason: "deadline-exceeded" }),
		];
		for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(AUDIT_VALUE_MAX);
	});
});
