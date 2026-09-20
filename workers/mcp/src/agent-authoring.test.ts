import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerAgentAuthoringTools } from "./instance-tools/agent-authoring.js";
import type { SafetyContext } from "./safety.js";

// ── #613, the agent-template authoring group — the READ half ──────────────────
//
// Six proxies over routes the console's AgentDetail already uses. What a proxy over THESE gets
// wrong, and what is therefore pinned below:
//
//   · the ROUTE. `my_agent` must hit `/v1/agents/{id}` and not `/v1/public/agents/{id}` — the
//     second is what `agent_info` already does, and shipping a second tool onto the same public
//     projection would close the gap on paper while answering the same wrong thing. This is the
//     single most important assertion in the file.
//   · the TEMPLATE vs the INSTANCE. Five of the six have an instance-side twin with a nearly
//     identical name (`get_instance_state`, `get_instance_memory`, `instance_messages`), and the
//     stores are unrelated. A tool that reached `/v1/instances/...` here would answer confidently
//     about somebody else's data.
//   · `before` on the paged read. #428 is a recorded defect in exactly this shape on exactly this
//     route: a rebuilt query string that dropped `before`, so paging back returned the newest
//     page forever. The tool must omit the key when absent and send it when present.
//   · that all six stay READS. They are ungated beyond auth because every route is owner-scoped
//     server-side, so a scope creeping in here would be a capability change, not a tidy-up.
//
// Driven through the real registrar and `authedCall`; only `fetch` and the audit KV are stubbed.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw === null ? null : JSON.parse(raw) });
		return new Response(JSON.stringify(opts.body ?? { ok: true }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const auditStore = new Map<string, string>();
	const kv = {
		get: async (k: string) => auditStore.get(k) ?? null,
		put: async (k: string, v: string) => void auditStore.set(k, v),
		delete: async (k: string) => void auditStore.delete(k),
		list: async () => ({ keys: [...auditStore.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, Handler>();
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
	const server = { tool: (name: string, d: string, _s: Shape, handler: Handler) => tools.set(name, Object.assign(handler, { description: d })) } as any;
	const tokenFor = (t?: string) => t || "session-token";
	const safetyFor = (): SafetyContext => ({
		env,
		subject: "user-1",
		scopes: (opts.scopes ?? ["read"]) as SafetyContext["scopes"],
	});
	registerAgentAuthoringTools(server, { env, tokenFor, safetyFor, groups: new Set<string>() });
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h({ agent_id: "my-agent", ...args });
	};
	const describeOf = (name: string) => (tools.get(name) as unknown as { description: string }).description;
	return { run, calls, describeOf, names: () => [...tools.keys()] };
}

afterEach(() => vi.unstubAllGlobals());

/** Every tool in this registrar, and the route each must hit. */
const ROUTES: Array<[string, string]> = [
	["my_agent", "https://api.test/v1/agents/my-agent"],
	["get_agent_capabilities", "https://api.test/v1/agents/my-agent/capabilities"],
	["get_agent_state", "https://api.test/v1/agents/my-agent/state"],
	["get_agent_memory", "https://api.test/v1/agents/my-agent/memory"],
	["agent_messages", "https://api.test/v1/agents/my-agent/messages"],
	["export_agent", "https://api.test/v1/agents/my-agent/export"],
];

describe("the registrar", () => {
	it("registers exactly the six read tools of this slice", () => {
		expect(setup().names().sort()).toEqual(
			["agent_messages", "export_agent", "get_agent_capabilities", "get_agent_memory", "get_agent_state", "my_agent"],
		);
	});

	it("every tool GETs its own route, and none of them writes", async () => {
		for (const [name, url] of ROUTES) {
			const h = setup();
			await h.run(name);
			expect(h.calls, name).toEqual([{ url, method: "GET", body: null }]);
		}
	});

	it("all six work on the read scope alone", async () => {
		// Ungated beyond auth is a DECISION (every route refuses a non-owner server-side), so a
		// scope check creeping in here would be a capability change wearing a refactor's clothes.
		for (const [name] of ROUTES) {
			const h = setup({ scopes: ["read"] });
			const res = await h.run(name);
			expect(res.content[0].text, name).not.toMatch(/denied|permission/i);
		}
	});

	it("URL-encodes the agent id, so a slug with a slash cannot reshape the path", async () => {
		const h = setup();
		await h.run("get_agent_state", { agent_id: "a/b" });
		expect(h.calls[0].url).toBe("https://api.test/v1/agents/a%2Fb/state");
	});
});

describe("my_agent — the gap that was a WRONG answer, not a missing one", () => {
	it("reads the OWNER route, never the public projection agent_info already serves", async () => {
		// The whole point of the tool. `/v1/public/agents/{id}` 404s a draft and strips the
		// owner-only fields; a second tool onto it would close the gap on paper and answer the
		// same wrong thing.
		const h = setup({ body: { id: "a1", visibility: "draft", owner_id: "user-1", cron_schedule: null } });
		await h.run("my_agent");
		expect(h.calls[0].url).toBe("https://api.test/v1/agents/my-agent");
		expect(h.calls[0].url).not.toContain("/public/");
	});

	it("returns the owner-only fields verbatim — including a draft", async () => {
		const h = setup({ body: { id: "a1", slug: "my-agent", visibility: "draft", status: "active", cron_schedule: "0 * * * *", owner_id: "user-1" } });
		const out = JSON.parse((await h.run("my_agent")).content[0].text);
		expect(out).toMatchObject({ visibility: "draft", status: "active", cron_schedule: "0 * * * *", owner_id: "user-1" });
	});

	it("its description sends a caller to agent_info's limits rather than leaving them to find out", async () => {
		const d = setup().describeOf("my_agent");
		expect(d).toMatch(/agent_info/);
		expect(d).toMatch(/draft/i);
		// And names the degrade: a tool called `my_agent` answering about somebody else's
		// published agent is a surprise, because `/v1/agents/{id}` has OPTIONAL auth.
		expect(d).toMatch(/owner_id/);
	});
});

describe("agent_messages — the paged read #428 already broke once", () => {
	it("omits the query string entirely when neither page argument is given", async () => {
		const h = setup();
		await h.run("agent_messages");
		expect(h.calls[0].url).toBe("https://api.test/v1/agents/my-agent/messages");
	});

	it("sends `before` when paging backwards — the key #428 dropped", async () => {
		const h = setup();
		await h.run("agent_messages", { before: "msg-9", limit: 25 });
		const url = new URL(h.calls[0].url);
		expect(url.searchParams.get("before")).toBe("msg-9");
		expect(url.searchParams.get("limit")).toBe("25");
	});

	it("sends a limit alone without inventing a cursor", async () => {
		const h = setup();
		await h.run("agent_messages", { limit: 10 });
		expect(h.calls[0].url).toBe("https://api.test/v1/agents/my-agent/messages?limit=10");
	});

	it("URL-encodes an opaque cursor rather than pasting it in", async () => {
		const h = setup();
		await h.run("agent_messages", { before: "a b&c=d" });
		const url = new URL(h.calls[0].url);
		expect(url.searchParams.get("before")).toBe("a b&c=d");
	});
});

describe("the template/instance distinction, stated where a caller will read it", () => {
	it("no tool here ever addresses an instance route", async () => {
		// Five of the six have an instance-side twin with a nearly identical name and an unrelated
		// store behind it. Reaching the wrong one answers confidently about somebody else's data.
		for (const [name] of ROUTES) {
			const h = setup();
			await h.run(name);
			expect(h.calls[0].url, name).not.toContain("/v1/instances/");
		}
	});

	it("each description names the side it reads and points at its twin", () => {
		const h = setup();
		expect(h.describeOf("get_agent_state")).toMatch(/get_instance_state/);
		expect(h.describeOf("get_agent_memory")).toMatch(/get_instance_memory/);
		expect(h.describeOf("agent_messages")).toMatch(/instance_messages/);
		for (const name of ["get_agent_state", "get_agent_memory", "agent_messages"]) {
			expect(h.describeOf(name), name).toMatch(/TEMPLATE/);
		}
	});

	it("says a template edit does not reach instances that already exist", () => {
		// The consequence of the two stores never syncing, and the reason someone reads these at
		// all: "I changed the agent and nothing happened" is usually this, not a bug.
		const h = setup();
		expect(h.describeOf("get_agent_state")).toMatch(/does not reach instances that already exist/);
		expect(h.describeOf("get_agent_memory")).toMatch(/never sync/);
	});
});

describe("export_agent", () => {
	it("returns the backup blob whole, with its restore envelope intact", async () => {
		// Not paged and not trimmed, deliberately: a truncated backup is one that cannot be
		// restored, which is a worse failure than a large response.
		const body = { exportVersion: 1, exportedAt: "2026-09-20T00:00:00.000Z", agent: { slug: "my-agent" }, state: { personality: "x" }, knowledge: [{ title: "a" }], memory: [{ key: "k" }] };
		const h = setup({ body });
		const out = JSON.parse((await h.run("export_agent")).content[0].text);
		expect(out).toEqual(body);
	});

	it("warns that it is the whole thing, and names the per-part reads", () => {
		const d = setup().describeOf("export_agent");
		expect(d).toMatch(/large/i);
		expect(d).toMatch(/get_agent_state/);
		expect(d).toMatch(/get_agent_memory/);
	});

	it("is described as a read that stores nothing — the word 'export' is about the SHAPE", () => {
		// It composes state + knowledge + memory and writes nowhere. A caller that read "export"
		// as "take a snapshot the platform keeps" would look for one later and not find it.
		expect(setup().describeOf("export_agent")).toMatch(/changes nothing|is not a snapshot the platform stores/);
	});
});
