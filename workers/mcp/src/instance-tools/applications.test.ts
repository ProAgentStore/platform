/**
 * The Applications MCP tools (#958) post the console's own request to the console's own route —
 * which is what makes "console and MCP land identical lifecycle and audit results" true by
 * construction. The bodies asserted here are the ones `store/console/src/lib/applications.ts`
 * `actionBody` builds (its test pins the same shapes).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerApplicationTools } from "./applications.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function tools(scopes: SafetyContext["scopes"] = ["read", "write", "runtime"]) {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, Handler>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerApplicationTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes }),
		groups: new Set(),
	});
	return { seen, names: [...handlers.keys()], call: (name: string, args: Record<string, unknown>) => (handlers.get(name) as Handler)(args).then((r) => r.content[0].text) };
}

afterEach(() => vi.unstubAllGlobals());

const ACTIONS = "https://api.test/v1/instances/t1/application-queue/actions";

describe("the Applications tools (#958)", () => {
	it("publishes the issue's typed tools", () => {
		expect(tools().names.sort()).toEqual([
			"application_trace",
			"cancel_application",
			"generate_application_materials",
			"get_application",
			"list_applications",
			"request_application_review",
			"resume_application",
			"retry_application",
			"start_application_fill",
			"triage_application",
		]);
	});

	it("reads the console's queue, item and trace routes", async () => {
		const { seen, call } = tools();
		await call("list_applications", { instance_id: "t1", status: "blocked" });
		await call("get_application", { instance_id: "t1", application_id: "a1" });
		await call("application_trace", { instance_id: "t1", application_id: "a1" });
		expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
			"GET https://api.test/v1/instances/t1/application-queue?status=blocked",
			"GET https://api.test/v1/instances/t1/application-queue/item?application_id=a1",
			"GET https://api.test/v1/instances/t1/application-queue/a1/trace",
		]);
	});

	it.each([
		["triage_application", { action: "archive", application_id: "a1", expected_status: "materials_ready", expected_version: 3 }, { action: "archive", application_id: "a1", expected_status: "materials_ready", expected_version: 3 }],
		["triage_application", { action: "apply", scout_instance_id: "s", record_id: "l", expected_status: "new", expected_version: 0 }, { action: "apply", scout_instance_id: "s", record_id: "l", expected_status: "new", expected_version: 0 }],
		["start_application_fill", { application_id: "a1", expected_status: "materials_ready" }, { action: "start_fill", application_id: "a1", expected_status: "materials_ready" }],
		["request_application_review", { application_id: "a1", expected_status: "materials_ready" }, { action: "request_review", application_id: "a1", expected_status: "materials_ready" }],
		["retry_application", { action: "retry_fill", application_id: "a1", expected_status: "blocked" }, { action: "retry_fill", application_id: "a1", expected_status: "blocked" }],
		["resume_application", { application_id: "a1", expected_status: "blocked", answers: [{ question: "Q?", answer: "A" }] }, { action: "resume", application_id: "a1", expected_status: "blocked", answers: [{ question: "Q?", answer: "A" }] }],
		["cancel_application", { application_id: "a1", expected_status: "filling" }, { action: "cancel", application_id: "a1", expected_status: "filling" }],
	])("%s posts the console's action body to the console's action route", async (name, args, body) => {
		const { seen, call } = tools();
		await call(name, { instance_id: "t1", ...args });
		expect(seen).toEqual([{ url: ACTIONS, method: "POST", body }]);
	});

	it("a dry run touches nothing", async () => {
		const { seen, call } = tools();
		expect(await call("start_application_fill", { instance_id: "t1", application_id: "a1", expected_status: "materials_ready", dry_run: true })).toMatch(/dryRun/);
		expect(seen).toEqual([]);
	});

	it("a decision that starts work on the owner's machine needs the runtime scope", async () => {
		const { seen, call } = tools(["read", "write"]);
		expect(await call("request_application_review", { instance_id: "t1", application_id: "a1", expected_status: "materials_ready" })).toMatch(/runtime/);
		expect(seen).toEqual([]);
	});
});
