/**
 * The local browser MCP tools (#945) send the API exactly the patch the caller meant: snake_case
 * in, the API's camelCase out, nothing the caller did not pass, and null as "reset".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerLocalBrowserTools } from "./local-browser.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function tools() {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, Handler>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerLocalBrowserTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime"] }),
		groups: new Set(),
	});
	return { seen, call: (name: string, args: Record<string, unknown>) => (handlers.get(name) as Handler)(args).then((r) => r.content[0].text) };
}

afterEach(() => vi.unstubAllGlobals());

describe("set_instance_local_browser_settings", () => {
	it("maps the fields it was given, and only those", async () => {
		const { seen, call } = tools();
		await call("set_instance_local_browser_settings", { instance_id: "i1", engine: "codex", auth_mode: "subscription", workspace_path: "~/jobs", deny_domains: ["ads.com"], limits: { max_pages: 10 } });
		const put = seen.find((s) => s.method === "PUT");
		expect(put).toMatchObject({ url: "https://api.test/v1/instances/i1/local-browser/settings" });
		expect(put?.body).toEqual({ engine: "codex", authMode: "subscription", workspace: { kind: "path", path: "~/jobs" }, access: { denyDomains: ["ads.com"] }, limits: { maxPages: 10 } });
	});

	it("sends null to reset, and a null workspace back to the managed scratch folder", async () => {
		const { seen, call } = tools();
		await call("set_instance_local_browser_settings", { instance_id: "i1", engine: null, workspace_path: null, limits: null });
		expect(seen.find((s) => s.method === "PUT")?.body).toEqual({ engine: null, workspace: { kind: "scratch" }, limits: null });
	});

	it("writes nothing on a dry run, or when given nothing to change", async () => {
		const { seen, call } = tools();
		await call("set_instance_local_browser_settings", { instance_id: "i1", engine: "codex", dry_run: true });
		expect(await call("set_instance_local_browser_settings", { instance_id: "i1" })).toMatch(/pass at least one setting/);
		expect(seen.filter((s) => s.method === "PUT")).toEqual([]);
	});
});

describe("list_local_browser_runs", () => {
	it("lists runs, or reads one run with its trace page", async () => {
		const { seen, call } = tools();
		await call("list_local_browser_runs", { instance_id: "i1" });
		await call("list_local_browser_runs", { instance_id: "i1", run_id: "r1", after: 5 });
		expect(seen.map((s) => s.url)).toEqual([
			"https://api.test/v1/instances/i1/local-browser/runs",
			"https://api.test/v1/instances/i1/local-browser/runs/r1",
			"https://api.test/v1/instances/i1/local-browser/runs/r1/events?after=5",
		]);
	});
});

describe("start, cancel and resume (#944)", () => {
	it("starts a run with the objective and the caller's idempotency key, and nothing on a dry run", async () => {
		const { seen, call } = tools();
		await call("start_local_browser_run", { instance_id: "i1", objective: "Find roles", dry_run: true });
		expect(seen.filter((s) => s.method === "POST")).toEqual([]);
		await call("start_local_browser_run", { instance_id: "i1", objective: "Find roles", request_id: "req-1" });
		expect(seen.find((s) => s.method === "POST")).toEqual({ url: "https://api.test/v1/instances/i1/local-browser/runs", method: "POST", body: { objective: "Find roles", requestId: "req-1" } });
	});

	it("cancels and resumes the named run", async () => {
		const { seen, call } = tools();
		await call("cancel_local_browser_run", { instance_id: "i1", run_id: "r 1" });
		await call("resume_local_browser_run", { instance_id: "i1", run_id: "r1" });
		expect(seen.filter((s) => s.method === "POST").map((s) => s.url)).toEqual([
			"https://api.test/v1/instances/i1/local-browser/runs/r%201/cancel",
			"https://api.test/v1/instances/i1/local-browser/runs/r1/resume",
		]);
	});
});
