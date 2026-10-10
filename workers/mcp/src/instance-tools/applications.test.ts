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
			"clear_application_tailor_uploaded_source",
			"generate_application_materials",
			"get_application",
			"get_application_runner_settings",
			"get_application_tailor_uploaded_source_readiness",
			"get_application_tailor_uploaded_sources",
			"list_applications",
			"request_application_review",
			"resume_application",
			"retry_application",
			"set_application_runner_settings",
			"set_application_tailor_uploaded_source",
			"start_application_fill",
			"tailoring_run",
			"triage_application",
		]);
	});

	it("reads the Tailor's selected uploaded sources and live readiness unchanged", async () => {
		const { seen, call } = tools();
		await call("get_application_tailor_uploaded_sources", { instance_id: "t1" });
		await call("get_application_tailor_uploaded_source_readiness", { instance_id: "t1" });
		expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
			"GET https://api.test/v1/instances/t1/application-tailor/uploaded-sources",
			"GET https://api.test/v1/instances/t1/application-tailor/uploaded-sources/readiness",
		]);
	});

	it("selects and clears only the explicit uploaded-source selection route", async () => {
		const { seen, call } = tools();
		await call("set_application_tailor_uploaded_source", { instance_id: "t 1", role: "resume", file_id: "file/1" });
		await call("clear_application_tailor_uploaded_source", { instance_id: "t 1", role: "profile" });
		expect(seen).toEqual([
			{ url: "https://api.test/v1/instances/t%201/application-tailor/uploaded-sources/resume", method: "PUT", body: { fileId: "file/1" } },
			{ url: "https://api.test/v1/instances/t%201/application-tailor/uploaded-sources/profile", method: "DELETE", body: undefined },
		]);
	});

	it("does not send any source selection request for a dry run", async () => {
		const { seen, call } = tools();
		expect(await call("set_application_tailor_uploaded_source", { instance_id: "t1", role: "resume", file_id: "file-1", dry_run: true })).toMatch(/dryRun/);
		expect(await call("clear_application_tailor_uploaded_source", { instance_id: "t1", role: "profile", dry_run: true })).toMatch(/dryRun/);
		expect(seen).toEqual([]);
	});

	it("keeps uploaded-source reads read-scoped and selections write-scoped", async () => {
		const reads = tools(["read"]);
		expect(await reads.call("get_application_tailor_uploaded_sources", { instance_id: "t1" })).toContain("ok");
		expect(await reads.call("get_application_tailor_uploaded_source_readiness", { instance_id: "t1" })).toContain("ok");
		expect(await reads.call("set_application_tailor_uploaded_source", { instance_id: "t1", role: "resume", file_id: "file-1" })).toMatch(/requires MCP scope "write"/);
		expect(reads.seen).toHaveLength(2);
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

// ── #986: an MCP reader is told how far the fill got, in the same words as the console ────────
//
// The parity requirement is met by pass-through, and that is the thing worth pinning: these tools
// must not project, summarise or re-derive the queue's own answer. A model that received only
// `status: "awaiting_review"` would reach the same wrong conclusion the Board card did — that a
// form is populated and waiting to be approved — and `approve_application` is one call away.
describe("the fill's progress reaches MCP verbatim (#986)", () => {
	const PROGRESS = {
		stage: "supervisor_pending",
		label: "Paused before form filling — supervisor decision pending. Nothing has been entered yet.",
		filled: 0,
		uploaded: 0,
		checkpointPhase: "initial",
		checkpointId: "cp-1",
		submitAttempted: false,
		evidence: "runner_checkpoint",
	};

	function queueTools(payload: unknown) {
		const t = tools();
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
		return t;
	}

	it("carries fillProgress through the queue and the item read, unchanged", async () => {
		const { call } = queueTools({ items: [{ key: "app:a1", status: "awaiting_review", fillProgress: PROGRESS }], item: { key: "app:a1", status: "awaiting_review", fillProgress: PROGRESS } });
		for (const name of ["list_applications", "get_application"]) {
			const body = JSON.parse(await call(name, { instance_id: "t1", application_id: "a1" }));
			const read = name === "list_applications" ? body.items[0] : body.item;
			expect(read.fillProgress, name).toEqual(PROGRESS);
		}
	});

	it("tells the reader to use it rather than infer progress from the status word", () => {
		const described = new Map<string, string>();
		registerApplicationTools({ tool: (name: string, description: string) => described.set(name, description) } as never, {
			env: { API_BASE: "https://api.test" },
			tokenFor: () => "session-token",
			safetyFor: (): SafetyContext => ({ env: { API_BASE: "https://api.test" }, subject: "user-1", scopes: ["read"] }),
		});
		expect(described.get("list_applications")).toMatch(/execution/);
		expect(described.get("list_applications")).toMatch(/does not grant submission authority/);
		expect(described.get("get_application")).toMatch(/never says a form is filled without durable counts/);
	});
});

describe("durable execution projection reaches MCP verbatim (#988)", () => {
	const EXECUTION = {
		schemaVersion: 1,
		lifecycle: { status: "filling", stateVersion: 3, blockReason: null, submitAttempted: false },
		currentRun: { id: "run-1", kind: "fill", status: "paused", instanceId: "runner-1", mode: "fill_and_review" },
		checkpoint: { id: "cp-1", phase: "initial", facts: { actions: 1, filled: 0, uploaded: 0, blockers: [], domain: "jobs.example.com" }, directive: { kind: "continue", delivery: "acknowledged_by_runner" } },
		progress: null,
		permittedActions: ["resume", "cancel"],
		directiveReconciliation: "acknowledged",
	};

	it("does not re-project, redact differently, or grant an action over MCP", async () => {
		const t = tools();
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ item: { key: "app:a1", execution: EXECUTION } }), { status: 200, headers: { "Content-Type": "application/json" } }));
		const body = JSON.parse(await t.call("get_application", { instance_id: "t1", application_id: "a1" }));
		expect(body.item.execution).toEqual(EXECUTION);
		expect(body.item.execution.permittedActions).toEqual(["resume", "cancel"]);
	});
});
