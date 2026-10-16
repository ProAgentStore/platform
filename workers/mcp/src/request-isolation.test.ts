/**
 * #1111 — one session, one in-flight use of each request id; and a mutation that says which call it was.
 *
 * `McpAgent`'s base `onConnect` needs the Workers runtime, so it is replaced by a stand-in that does
 * exactly what the real transport does first (agents 0.3.10, `dist/mcp/index.js`): record the POST's
 * request ids on the connection (`connection.setState({ requestIds })`) and dispatch it. Replies are
 * routed by the transport's own rule, quoted below and pinned against the installed package at the
 * end, so the crossing is REPRODUCED here — not assumed — and then shown gone. Every fixture is
 * synthetic; no real session, owner or tool output is involved.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatched } = vi.hoisted(() => ({ dispatched: [] as Array<{ conn: string; ids: unknown[] }> }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class { tool() {} registerTool() {} } }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		conns: FakeConn[] = [];
		static serve() {
			return { fetch: () => new Response("mock") };
		}
		getConnections() {
			return this.conns;
		}
		/** The real transport's first move on a POST: the connection holds its request ids, then it is dispatched. */
		async onConnect(conn: FakeConn, ctx: { request: Request }) {
			const body = JSON.parse(atob(ctx.request.headers.get("cf-mcp-message") ?? "") || "null");
			const ids = (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m.method === "string" && "id" in m).map((m) => m.id);
			conn.state = { requestIds: ids };
			dispatched.push({ conn: conn.id, ids });
		}
	},
}));

const { PagsMcp } = await import("./index.js");
const { McpAgent } = await import("agents/mcp");
const { REUSED_ID_ERROR_CODE, idsInFlightElsewhere, idsRepeatedWithin, requestIdsIn } = await import("./request-isolation.js");
const { RECEIPT_META_KEY, installRegistrationPipeline, receiptTarget } = await import("./registration.js");

interface FakeConn {
	id: string;
	state?: { requestIds?: unknown[] };
	sent: string[];
	send(m: string): void;
}
const conn = (id: string): FakeConn => ({ id, sent: [], send(m) { this.sent.push(m); } });
/** A session's Durable Object — its own `PagsMcp`, with its own open connections. */
// biome-ignore lint/suspicious/noExplicitAny: the DO is driven through the mocked base above.
const session = (): any => new (PagsMcp as any)();
/** The HTTP POST `McpAgent.serve` hands the DO: the JSON-RPC body, base64, in `cf-mcp-message`. */
const post = (body: unknown) =>
	new Request("https://mcp.test/mcp", { headers: { "cf-mcp-method": "POST", "cf-mcp-message": btoa(JSON.stringify(body)) } });
const call = (id: string | number, tool: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: { instance_id: "synthetic-instance" } } });
/** Open a connection on the session and run it through `PagsMcp.onConnect`, as the DO does. */
// biome-ignore lint/suspicious/noExplicitAny: see `session`.
async function open(s: any, id: string, body: unknown): Promise<FakeConn> {
	const c = conn(id);
	s.conns.push(c);
	await s.onConnect(c, { request: post(body) });
	return c;
}
/**
 * The transport's reply routing, verbatim in effect (`send`, agents 0.3.10 index.js:648):
 * `Array.from(agent.getConnections()).find((conn) => conn.state?.requestIds?.includes(requestId))`.
 */
// biome-ignore lint/suspicious/noExplicitAny: see `session`.
function deliver(s: any, requestId: unknown, result: string) {
	const target = (s.getConnections() as FakeConn[]).find((c) => c.state?.requestIds?.includes(requestId));
	target?.send(JSON.stringify({ result }));
	return target?.id;
}
const errorsIn = (c: FakeConn) => c.sent.map((m) => JSON.parse(m)).map((m) => ({ close: m.close, body: JSON.parse(m.event.split("data: ")[1]) }));

beforeEach(() => {
	dispatched.length = 0;
});

describe("the defect, reproduced on the transport's own routing rule (#1111)", () => {
	it("two in-flight requests sharing id 0 in one session: the second caller's reply is delivered to the FIRST caller", async () => {
		const s = session();
		// Bypass the guard: the base `onConnect`, as every deploy before this fix ran it.
		for (const [id, tool] of [["c1", "repo_remote"], ["c2", "github_list_issues"]] as const) {
			const c = conn(id);
			s.conns.push(c);
			await (McpAgent.prototype as unknown as { onConnect: (c: FakeConn, x: { request: Request }) => Promise<void> }).onConnect.call(s, c, { request: post(call(0, tool)) });
		}
		// c2's own call finishes first — and its result goes to c1, who asked for something else.
		expect(deliver(s, 0, "github_list_issues output")).toBe("c1");
		expect(s.conns[1].sent).toEqual([]);
	});
});

describe("PagsMcp.onConnect refuses a request id already in flight in its session (#1111)", () => {
	it("A — a concurrent reuse of id 0 is refused with a JSON-RPC error, never dispatched; the first call's reply reaches only the first caller", async () => {
		const s = session();
		const first = await open(s, "c1", call(0, "repo_remote"));
		const second = await open(s, "c2", call(0, "github_list_issues"));
		expect(dispatched).toEqual([{ conn: "c1", ids: [0] }]);
		expect(errorsIn(second)).toEqual([{ close: true, body: { jsonrpc: "2.0", id: 0, error: { code: REUSED_ID_ERROR_CODE, message: expect.stringMatching(/already in use by another request in flight in this MCP session, so this request was not run/) } } }]);
		expect(deliver(s, 0, "repo_remote output")).toBe("c1");
		expect(first.sent).toEqual([JSON.stringify({ result: "repo_remote output" })]);
		expect(second.sent).toHaveLength(1); // the refusal, and nothing of anyone else's
	});

	it("B — distinct ids in one session both run, and each reply reaches its own caller", async () => {
		const s = session();
		const a = await open(s, "c1", call(1, "repo_remote"));
		const b = await open(s, "c2", call(2, "repo_remote")); // near-identical input, its own id
		expect(dispatched.map((d) => d.conn)).toEqual(["c1", "c2"]);
		deliver(s, 2, "b's");
		deliver(s, 1, "a's");
		expect(a.sent).toEqual([JSON.stringify({ result: "a's" })]);
		expect(b.sent).toEqual([JSON.stringify({ result: "b's" })]);
	});

	it("C — the same id in two sessions is two Durable Objects: no shared in-flight state, both run", async () => {
		const s1 = session();
		const s2 = session();
		await open(s1, "c1", call(1, "my_instances"));
		await open(s2, "c1", call(1, "my_instances"));
		expect(dispatched).toEqual([{ conn: "c1", ids: [1] }, { conn: "c1", ids: [1] }]);
	});

	it("an id reused AFTER its request completed is not refused: its connection is gone, so nothing can cross", async () => {
		const s = session();
		await open(s, "c1", call(0, "repo_remote"));
		s.conns.shift(); // the transport closed it after the reply
		await open(s, "c2", call(0, "repo_tree"));
		expect(dispatched.map((d) => d.conn)).toEqual(["c1", "c2"]);
	});

	it("a batch carrying a reused id is refused whole — every request answered, the stream closed on the last", async () => {
		const s = session();
		await open(s, "c1", call(5, "repo_remote"));
		const batch = await open(s, "c2", [call(6, "repo_tree"), call(5, "repo_find")]);
		expect(dispatched.map((d) => d.conn)).toEqual(["c1"]);
		const errs = errorsIn(batch);
		expect(errs.map((e) => [e.body.id, e.close])).toEqual([[6, false], [5, true]]);
		expect(errs[0].body.error.message).toMatch(/another request in the same batch reuses/);
	});

	it("a batch that repeats ONE id within itself is refused whole and never dispatched — two replies with one id cannot be told apart", async () => {
		const s = session();
		const batch = await open(s, "c1", [call(7, "github_read_issue"), call(7, "github_read_issue")]);
		expect(dispatched).toEqual([]);
		const errs = errorsIn(batch);
		expect(errs.map((e) => [e.body.id, e.body.error.code, e.close])).toEqual([
			[7, REUSED_ID_ERROR_CODE, false],
			[7, REUSED_ID_ERROR_CODE, true],
		]);
		// Distinct ids in one batch are still fine.
		await open(s, "c2", [call(8, "repo_tree"), call(9, "repo_find")]);
		expect(dispatched.map((d) => d.conn)).toEqual(["c2"]);
	});

	it("the pure rule for repeats: each repeat after the first counts, by JSON-RPC identity (0 ≠ \"0\")", () => {
		expect(idsRepeatedWithin([1, 2, 1, 1])).toEqual([1, 1]);
		expect(idsRepeatedWithin([0, "0"])).toEqual([]);
		expect(idsRepeatedWithin([])).toEqual([]);
	});

	it("follows JSON-RPC: 0 and \"0\" are different ids; notifications and GET streams carry none and pass", async () => {
		const s = session();
		await open(s, "c1", call(0, "repo_remote"));
		await open(s, "c2", call("0", "repo_remote"));
		await open(s, "c3", { jsonrpc: "2.0", method: "notifications/initialized" });
		const get = conn("c4");
		s.conns.push(get);
		await s.onConnect(get, { request: new Request("https://mcp.test/mcp", { headers: { "cf-mcp-method": "GET" } }) });
		expect(dispatched.map((d) => d.conn)).toEqual(["c1", "c2", "c3", "c4"]);
	});

	it("the pure rule: only OTHER connections' ids count, and only ids this POST carries", () => {
		const self = conn("me");
		self.state = { requestIds: [3] };
		const other = { ...conn("o"), state: { requestIds: [3, 4] } };
		expect(idsInFlightElsewhere([3, 9], [self, other], self)).toEqual([3]);
		expect(idsInFlightElsewhere([3], [self], self)).toEqual([]);
		expect(requestIdsIn([{ id: 1, method: "x" }, { id: 2, result: {} }, { method: "n" }])).toEqual([1]);
	});
});

describe("a mutating call identifies itself; a read stays clean (#1111)", () => {
	function pipeline() {
		const handlers = new Map<string, (input: unknown, extra: unknown) => Promise<unknown>>();
		const server = {
			tool: (..._a: unknown[]) => undefined,
			registerTool: (name: string, _config: Record<string, unknown>, cb: (...args: unknown[]) => unknown) => void handlers.set(name, cb as (input: unknown, extra: unknown) => Promise<unknown>),
		};
		installRegistrationPipeline(server, { gate: async () => null, readOnly: (n) => n === "list_things" });
		const reply = (text: string) => async () => ({ content: [{ type: "text", text }] });
		server.tool("rename_instance", "d", {}, reply('{"name":"x"}'));
		server.tool("list_things", "d", {}, reply('{"items":[]}'));
		return handlers;
	}

	it("D — a mutation's result carries the receipt: tool, request id, session and target, as text and as _meta, first block untouched", async () => {
		const h = pipeline();
		const r = (await h.get("rename_instance")?.({ instance_id: "inst-synthetic", name: "x" }, { requestId: 7, sessionId: "sess-synthetic" })) as { content: Array<{ text: string }>; _meta: Record<string, unknown> };
		expect(JSON.parse(r.content[0].text)).toEqual({ name: "x" });
		expect(r.content[1].text).toBe("---MCP-RECEIPT---\ntool: rename_instance\nrequestId: 7\nmcpSessionId: sess-synthetic\ntarget: instance_id=inst-synthetic\n---END-RECEIPT---");
		expect(r._meta[RECEIPT_META_KEY]).toEqual({ tool: "rename_instance", requestId: "7", mcpSessionId: "sess-synthetic", target: "instance_id=inst-synthetic" });
	});

	it("a call that reached the handler without correlation still says so, as 'unknown' — never a missing block", async () => {
		const h = pipeline();
		const r = (await h.get("rename_instance")?.({ name: "x" }, {})) as { content: Array<{ text: string }> };
		expect(r.content[1].text).toContain("requestId: unknown\nmcpSessionId: unknown\ntarget: n/a");
	});

	it("E — a read-only tool's result is exactly what the handler returned", async () => {
		const h = pipeline();
		expect(await h.get("list_things")?.({}, { requestId: 8, sessionId: "s" })).toEqual({ content: [{ type: "text", text: '{"items":[]}' }] });
	});

	it("the target is the most specific naming field, never content", () => {
		expect(receiptTarget({ instance_id: "i", session_id: "s", body: "secret text" })).toBe("instance_id=i");
		expect(receiptTarget({ repo: "o/r", objective: "do it" })).toBe("repo=o/r");
		expect(receiptTarget(undefined)).toBe("n/a");
	});
});

describe("the upstream facts this guard relies on, pinned to the installed agents package", () => {
	const require = createRequire(import.meta.url);
	const dist = dirname(require.resolve("agents/mcp"));
	const mcpJs = readFileSync(join(dist, "index.js"), "utf8");
	it("the headers the DO is handed, and the routing rule the guard exists for", () => {
		expect(mcpJs).toContain('MCP_HTTP_METHOD_HEADER = "cf-mcp-method"');
		expect(mcpJs).toContain('MCP_MESSAGE_HEADER = "cf-mcp-message"');
		expect(mcpJs).toContain("connection.setState({ requestIds })");
		// If upstream ever routes replies per connection instead, this pin fails — revisit the guard then.
		expect(mcpJs).toContain(".find((conn) => conn.state?.requestIds?.includes(requestId))");
	});
	it("the WS message type the transport writes SSE events with", () => {
		const types = readdirSync(join(dist, "..")).filter((f) => /^types-.*\.js$/.test(f)).map((f) => readFileSync(join(dist, "..", f), "utf8")).join("\n");
		expect(types).toContain('CF_MCP_AGENT_EVENT"] = "cf_mcp_agent_event"');
	});
});
