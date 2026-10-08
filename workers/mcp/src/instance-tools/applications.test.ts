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
	});
	return { seen, names: [...handlers.keys()], call: (name: string, args: Record<string, unknown>) => (handlers.get(name) as Handler)(args).then((r) => r.content[0].text) };
}

afterEach(() => vi.unstubAllGlobals());

const ACTIONS = "https://api.test/v1/instances/t1/application-queue/actions";

describe("the Applications tools (#958, #953)", () => {
	it("publishes the issue's typed tools", () => {
		expect(tools().names.sort()).toEqual([
			"application_run",
			"application_run_supervision",
			"application_runs",
			"application_trace",
			"approve_application",
			"cancel_application",
			"generate_application_materials",
			"get_application",
			"get_application_runner_settings",
			"list_applications",
			"request_application_review",
			"resume_application",
			"retry_application",
			"set_application_runner_settings",
			"start_application_fill",
			"tailoring_run",
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

	// #971 — the live-run reads. The gap these close is that NOTHING reached `/application-runs/*`
	// or the Tailor's `/applications/:id`, so a run's policy, pause, submit-gate verdicts, event
	// trace and supervisor checkpoints were HTTP-only: the apply pipeline had no answer to the
	// question `coding_session_capture` answers for a coding agent.
	it("reads the Runner's and Tailor's own run routes, which nothing reached before", async () => {
		const { seen, call } = tools();
		await call("application_runs", { instance_id: "r1" });
		await call("application_runs", { instance_id: "r1", limit: 5 });
		await call("application_run", { instance_id: "r1", run_id: "run-1" });
		await call("application_run_supervision", { instance_id: "r1", run_id: "run-1" });
		await call("tailoring_run", { instance_id: "t1", application_id: "a1" });
		expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
			"GET https://api.test/v1/instances/r1/application-runs",
			"GET https://api.test/v1/instances/r1/application-runs?limit=5",
			"GET https://api.test/v1/instances/r1/application-runs/run-1",
			"GET https://api.test/v1/instances/r1/application-runs/run-1/supervision",
			"GET https://api.test/v1/instances/t1/applications/a1",
		]);
		// Reads, every one: a live view pulls the machine, but it starts, resumes and dispatches
		// nothing — so none of them may be a POST.
		expect(seen.every((s) => s.method === "GET")).toBe(true);
	});

	it("ids are sent as given, encoded — a run id is opaque", async () => {
		const { seen, call } = tools();
		await call("application_run", { instance_id: "r 1", run_id: "run/1" });
		expect(seen[0].url).toBe("https://api.test/v1/instances/r%201/application-runs/run%2F1");
	});

	it("the live reads need only the read scope", async () => {
		const { seen, call } = tools(["read"]);
		for (const [name, args] of [
			["application_runs", {}],
			["application_run", { run_id: "run-1" }],
			["application_run_supervision", { run_id: "run-1" }],
			["tailoring_run", { application_id: "a1" }],
		] as const) {
			expect(await call(name, { instance_id: "t1", ...args }), name).toContain("\"ok\"");
		}
		expect(seen).toHaveLength(4);
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

	// #973 — the issue's parity requirement: "the UI button and MCP tool call the same owner-scoped
	// command/endpoint with the same eligibility checks, idempotency key, authorization record and
	// returned application state. Neither surface may have powers the other lacks."
	it("approve_application posts the board's own approve_and_proceed body to the board's own route", async () => {
		const { seen, call } = tools(["read", "write", "runtime", "destructive"]);
		await call("approve_application", { instance_id: "t1", application_id: "a1", expected_status: "materials_ready", expected_version: 4, idempotency_key: "approve:a1:4", confirm: "approve_application" });
		expect(seen).toEqual([{ url: ACTIONS, method: "POST", body: { action: "approve_and_proceed", application_id: "a1", expected_status: "materials_ready", expected_version: 4, idempotency_key: "approve:a1:4" } }]);
	});

	it("approving needs the confirmation every destructive tool in this surface asks for", async () => {
		const { seen, call } = tools(["read", "write", "runtime", "destructive"]);
		expect(await call("approve_application", { instance_id: "t1", application_id: "a1", expected_status: "materials_ready" })).toMatch(/confirm="approve_application"/);
		expect(seen).toEqual([]);
		// A dry run describes rather than acts, so it answers without one.
		expect(await call("approve_application", { instance_id: "t1", application_id: "a1", expected_status: "materials_ready", dry_run: true })).toMatch(/dryRun/);
		expect(seen).toEqual([]);
	});

	it("approving is destructive — it sends an application to an employer and cannot be recalled", async () => {
		const { seen, call } = tools(["read", "write", "runtime"]);
		expect(await call("approve_application", { instance_id: "t1", application_id: "a1", expected_status: "materials_ready" })).toMatch(/destructive/);
		expect(seen).toEqual([]);
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

describe("the Runner's submission policy over MCP (#953)", () => {
	it("reads and patches the settings route the console's policy card uses", async () => {
		const { seen, call } = tools();
		await call("get_application_runner_settings", { instance_id: "ap" });
		await call("set_application_runner_settings", { instance_id: "ap", settings: { autoSubmit: { enabled: false } } });
		expect(seen).toEqual([
			{ url: "https://api.test/v1/instances/ap/application-runner/settings", method: "GET", body: undefined },
			{ url: "https://api.test/v1/instances/ap/application-runner/settings", method: "PUT", body: { autoSubmit: { enabled: false } } },
		]);
	});
});
