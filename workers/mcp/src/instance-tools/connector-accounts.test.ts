import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerConnectorAccountTools } from "./connectors.js";

// ── #736 item (b), which account an instance uses ─────────────────────────────
//
// `get_instance_connector_account` and `set_instance_connector_account` proxy
// `/v1/instances/:id/connector-accounts`. Pinned here is what a proxy gets wrong — route, method,
// body keys, that `dry_run` touches no network, that a refused call is not audited as completed —
// plus the two things these tools add: a blank `account_id` is refused rather than sent (the route
// reads it as CLEAR, which leaves a multi-account instance refusing every call), and a save is
// answered with the connector's row read back, so the caller sees `resolves`/`blocked`.
// Driven through the real safety layer and `authedCall`; only `fetch` and the audit KV are stubbed.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

const HERE = dirname(fileURLToPath(import.meta.url));

const AMBIGUOUS = {
	connector: "gmail",
	label: "Gmail",
	accounts: [
		{ accountId: "a@example.com", label: "a@example.com", connectedAt: "2026-08-20 20:39:54" },
		{ accountId: "b@example.com", label: "b@example.com", connectedAt: "2026-07-03 07:48:37" },
	],
	pinned: null,
	resolves: null,
	blocked: { reason: "ambiguous", message: "You have 2 Gmail accounts connected and this agent is not set to use one of them: a@example.com, b@example.com." },
};
const DRIVE = { connector: "google_drive", label: "Google Drive", accounts: [{ accountId: "", label: null, connectedAt: null }], pinned: null, resolves: "", blocked: null };
const PINNED = { ...AMBIGUOUS, pinned: "b@example.com", resolves: "b@example.com", blocked: null };

interface Reply {
	status?: number;
	body: unknown;
}

/** `replies` are served in order, one per request; the last one repeats. */
function setup(opts: { scopes?: string[]; replies?: Reply[] } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const replies = opts.replies ?? [{ body: { connectors: [AMBIGUOUS, DRIVE] } }];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw === null ? null : JSON.parse(raw) });
		const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
		return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
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
	registerConnectorAccountTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
		{ tool: (name: string, _d: string, _s: Shape, handler: Handler) => tools.set(name, handler) } as any,
		{
			env,
			tokenFor: (t?: string) => t || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] }),
			groups: new Set<string>(),
		},
	);
	const run = async (name: string, args: Record<string, unknown>) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return (await h({ instance_id: "inst 1", ...args })).content[0].text;
	};
	const completed = () =>
		[...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

const URL_FOR = "https://api.test/v1/instances/inst%201/connector-accounts";

describe("get_instance_connector_account", () => {
	it("GETs every connector row, URL-encoding the instance id, and passes it through", async () => {
		const h = setup();
		const out = JSON.parse(await h.run("get_instance_connector_account", {}));
		expect(h.calls).toEqual([{ url: URL_FOR, method: "GET", body: null }]);
		expect(out).toEqual({ connectors: [AMBIGUOUS, DRIVE] });
	});

	it("narrows to one connector when asked, keeping the same envelope", async () => {
		const h = setup();
		const out = JSON.parse(await h.run("get_instance_connector_account", { connector: " gmail " }));
		expect(out).toEqual({ connectors: [AMBIGUOUS] });
	});

	it("says which connectors it DID find when the asked-for one has no row, rather than an empty success", async () => {
		const h = setup();
		const out = JSON.parse(await h.run("get_instance_connector_account", { connector: "zoho_workdrive" }));
		expect(out.connectors).toEqual([]);
		expect(out.note).toContain('No "zoho_workdrive" row');
		expect(out.note).toContain("gmail, google_drive");
	});

	it("passes an API error through untouched instead of reshaping it into an empty list", async () => {
		const h = setup({ replies: [{ status: 404, body: { error: "Instance not found" } }] });
		const out = JSON.parse(await h.run("get_instance_connector_account", { connector: "gmail" }));
		expect(out).toMatchObject({ error: "Instance not found" });
		expect(out.connectors).toBeUndefined();
	});

	it("is refused without read scope, before any request", async () => {
		const h = setup({ scopes: ["write"] });
		expect(await h.run("get_instance_connector_account", {})).toContain('requires MCP scope "read"');
		expect(h.calls).toHaveLength(0);
	});
});

describe("set_instance_connector_account", () => {
	it("PUTs `{connector, accountId}`, audits it, then returns the row read back — `resolves` and `blocked` included", async () => {
		const h = setup({
			replies: [{ body: { success: true, connector: "gmail", pinned: "b@example.com" } }, { body: { connectors: [PINNED, DRIVE] } }],
		});
		const out = JSON.parse(await h.run("set_instance_connector_account", { connector: "gmail", account_id: " b@example.com " }));
		expect(h.calls).toEqual([
			{ url: URL_FOR, method: "PUT", body: { connector: "gmail", accountId: "b@example.com" } },
			{ url: URL_FOR, method: "GET", body: null },
		]);
		expect(out).toEqual(PINNED);
		expect(h.completed().map((e) => e.tool)).toEqual(["set_instance_connector_account"]);
	});

	it.each([
		["a blank account_id", { connector: "gmail", account_id: "   " }, /`account_id` is blank/],
		["a blank connector", { connector: "", account_id: "b@example.com" }, /`connector` is blank/],
	])("refuses %s without a request — the route would read a blank account as CLEAR", async (_label, args, message) => {
		const h = setup();
		const res = await h.run("set_instance_connector_account", args);
		expect(res).toMatch(/^Error: nothing changed/);
		expect(res).toMatch(message);
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("surfaces the route's refusal of an unconnected account, does not audit it, and does not read back", async () => {
		const h = setup({ replies: [{ status: 400, body: { error: 'You have no Gmail account "c@example.com" connected.' } }] });
		const out = JSON.parse(await h.run("set_instance_connector_account", { connector: "gmail", account_id: "c@example.com" }));
		expect(out.error).toContain("c@example.com");
		expect(h.calls).toHaveLength(1);
		expect(h.completed()).toHaveLength(0);
	});

	it("still reports the save when the read-back does not return the row", async () => {
		const h = setup({
			replies: [{ body: { success: true, connector: "gmail", pinned: "b@example.com" } }, { status: 500, body: { error: "boom" } }],
		});
		const out = JSON.parse(await h.run("set_instance_connector_account", { connector: "gmail", account_id: "b@example.com" }));
		expect(out).toMatchObject({ success: true, connector: "gmail", pinned: "b@example.com" });
		expect(out.note).toMatch(/Saved, but reading it back did not return the gmail row/);
		expect(h.completed()).toHaveLength(1);
	});

	it("dry_run touches no network and names the pin it would save", async () => {
		const h = setup();
		const out = JSON.parse(await h.run("set_instance_connector_account", { connector: "gmail", account_id: "b@example.com", dry_run: true }));
		expect(h.calls).toHaveLength(0);
		expect(out).toMatchObject({ dryRun: true, wouldDo: { method: "PUT", body: { connector: "gmail", accountId: "b@example.com" } } });
		expect(h.completed()).toHaveLength(0);
	});

	it("is refused without write scope, before any request", async () => {
		const h = setup({ scopes: ["read"] });
		expect(await h.run("set_instance_connector_account", { connector: "gmail", account_id: "b@example.com" })).toContain('requires MCP scope "write"');
		expect(h.calls).toHaveLength(0);
	});

	it("sends exactly the body keys the API route reads", () => {
		// The worker cannot import the API, so a renamed body key would pass every test above and
		// silently clear the pin on the server (a missing `accountId` reads as blank). Held to the source.
		const src = readFileSync(resolve(HERE, "../../../api/src/routes/tools.ts"), "utf8");
		const put = src.slice(src.indexOf('toolRoutes.put("/:id/connector-accounts"'));
		expect(put).toMatch(/as \{ connector\?: string; accountId\?: string \| null \}/);
		expect(put).toMatch(/body\.connector/);
		expect(put).toMatch(/body\.accountId/);
	});
});
