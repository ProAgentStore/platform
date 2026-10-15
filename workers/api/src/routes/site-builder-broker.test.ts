/**
 * #841 / PR842 — the Website Builder broker, the run-scoped credential, the refine delivery, and the
 * whole draft → review → approve path, over the real migrated schema.
 *
 * Faked: the runner relay (`getLiveRuntime`/`callRuntime` — what the runner is SENT is the fact under
 * test), FreeWebStore behind `mcp_call_tool` (the registry call's inputs are asserted; its grant and
 * OAuth checks are its own tests), the R2 capture path, and the `site-deploy` pipeline start.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { fenceUntrusted } from "../lib/untrusted-fence.js";
import type { Env } from "../types.js";

const fake = vi.hoisted(() => ({
	runnerCalls: [] as Array<{ path: string; body: Record<string, unknown> }>,
	runnerAnswer: (_path: string): { status: number; body: unknown } => ({ status: 201, body: {} }),
	registry: [] as Array<{ name: string; ctx: Record<string, unknown>; input: Record<string, unknown> }>,
	registryAnswer: (_input: Record<string, unknown>): { success: boolean; content: string } => ({ success: true, content: "{}" }),
	pipelines: [] as Array<{ name: string; params: Record<string, unknown> }>,
}));

vi.mock("./instances-runtime.js", async (orig) => ({
	...(await orig<typeof import("./instances-runtime.js")>()),
	getLiveRuntime: async () => ({ runner_node: "mac", runner_version: "0.4.133" }),
	callRuntime: async (_env: unknown, _rt: unknown, path: string, init: { body?: string } = {}) => {
		const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		fake.runnerCalls.push({ path, body });
		const a = fake.runnerAnswer(path);
		return new Response(JSON.stringify(a.body), { status: a.status });
	},
}));
vi.mock("../lib/tool-registry.js", async (orig) => ({
	...(await orig<typeof import("../lib/tool-registry.js")>()),
	runRegistryTool: async (name: string, ctx: Record<string, unknown>, input: Record<string, unknown>) => {
		fake.registry.push({ name, ctx: { userId: ctx.userId, instanceId: ctx.instanceId }, input });
		return { name, ...fake.registryAnswer(input) };
	},
}));
vi.mock("../lib/pipeline-run-start.js", async (orig) => ({
	...(await orig<typeof import("../lib/pipeline-run-start.js")>()),
	startPipelineRun: async (_env: unknown, _i: string, _u: string, name: string, params: Record<string, unknown>) => {
		fake.pipelines.push({ name, params });
		return { ok: true, runId: "pipe-1" };
	},
}));

const workflow = await import("../lib/runtime-builder/workflow.js");
vi.spyOn(workflow, "captureRuntimeBuilderPreview");
const { siteBuilderBrokerRoutes } = await import("./site-builder-broker.js");
const { BROKER_BASE_URL, mintBrokerToken, verifyBrokerToken } = await import("../lib/runtime-builder/broker-token.js");

const SECRET = "site-builder-broker-secret";
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i9"] });
	env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
	fake.runnerCalls = [];
	fake.registry = [];
	fake.pipelines = [];
	fake.runnerAnswer = (path) => (path === "/tasks" ? { status: 201, body: { id: "task_7", type: "site_builder_runtime", status: "running" } } : { status: 202, body: { accepted: true } });
	fake.registryAnswer = () => ({ success: true, content: fenceUntrusted('{"templates":["cafe-classic"]}', "FreeWebStore") });
});
afterEach(() => {
	d1.close();
	vi.mocked(workflow.captureRuntimeBuilderPreview).mockReset();
});

/** A run as the trigger makes it: the runner is sent its task, PAGS keeps the run. */
async function newRun() {
	const run = await workflow.createRuntimeBuilderRun(env, "i1", "u1", { engine: "claude", mcpUrl: "https://fws.example/mcp", params: { name: "Bean There Cafe" } });
	const sent = fake.runnerCalls.filter((c) => c.path === "/tasks").at(-1)?.body as { input: { broker: { url: string; token: string } } };
	return { run, token: sent.input.broker.token, sent };
}

async function broker(runId: string, path: "tool" | "evidence", body: unknown, token?: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/site-builder/broker", siteBuilderBrokerRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(
		`/v1/site-builder/broker/${runId}/${path}`,
		{ method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) },
		env,
	);
	// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON reply fields
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const stored = async (runId: string) => (await workflow.getRuntimeBuilderRun(env, "i1", "u1", runId))!;

describe("the run is created with a run-scoped broker credential (#841)", () => {
	it("sends the runner PAGS's broker URL for THIS run and a credential that verifies for it only", async () => {
		const { run, token, sent } = await newRun();
		expect(sent.input.broker.url).toBe(`${BROKER_BASE_URL}${run.id}`);
		expect(await verifyBrokerToken(env, { userId: "u1", instanceId: "i1", runId: run.id }, token)).toBe(true);
		expect(await verifyBrokerToken(env, { userId: "u1", instanceId: "i1", runId: "another-run" }, token)).toBe(false);
		expect(await verifyBrokerToken(env, { userId: "u2", instanceId: "i9", runId: run.id }, token)).toBe(false);
		// The proxy description itself stays credential-free; the FWS OAuth token never leaves PAGS.
		expect(JSON.stringify(sent)).not.toMatch(/oauth|access_token|refresh_token/i);
	});

	it("never stores the credential in the runtime-task mirror, even from a runner that echoes it back", async () => {
		fake.runnerAnswer = (path) => (path === "/tasks" ? { status: 201, body: { id: "task_7", type: "site_builder_runtime", status: "running", input: { broker: { url: "x", token: "ECHOED-SECRET" } } } } : { status: 202, body: {} });
		await newRun();
		const rows = d1.sqlite.prepare("SELECT payload FROM instance_runtime_tasks").all() as Array<{ payload: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).not.toContain("ECHOED-SECRET");
	});
});

describe("the broker authenticates the run (#841)", () => {
	it("refuses no token, a forged one, another run's, and an expired one — all 401, nothing forwarded", async () => {
		const { run } = await newRun();
		const other = await newRun();
		const expired = await mintBrokerToken(env, { userId: "u1", instanceId: "i1", runId: run.id }, Date.now() - 2 * 24 * 60 * 60 * 1000);
		for (const token of [undefined, "9999999999999.forged", other.token, expired]) {
			const r = await broker(run.id, "tool", { tool: "list_templates" }, token);
			expect(r.status).toBe(401);
		}
		expect(fake.registry).toHaveLength(0);
	});

	it("refuses every call once the run is closed (409)", async () => {
		const { run, token } = await newRun();
		d1.sqlite.prepare("UPDATE site_builder_runtime_runs SET status = 'approved' WHERE id = ?").run(run.id);
		expect((await broker(run.id, "tool", { tool: "list_templates" }, token)).status).toBe(409);
		expect((await broker(run.id, "evidence", { sessionId: "s" }, token)).status).toBe(409);
	});
});

describe("the broker runs authoring tools only, through the owner's own FWS access (#841)", () => {
	it("forwards an authoring tool to mcp_call_tool for this owner, endpoint and tool, and records it", async () => {
		const { run, token } = await newRun();
		const r = await broker(run.id, "tool", { tool: "list_templates", args: {} }, token);
		expect(r.status).toBe(200);
		expect(r.body.success).toBe(true);
		expect(r.body.content).toContain("cafe-classic");
		expect(fake.registry).toEqual([{ name: "mcp_call_tool", ctx: { userId: "u1", instanceId: "i1" }, input: { url: "https://fws.example/mcp", tool: "list_templates", args: {} } }]);
		expect((await stored(run.id)).evidence.fwsTranscript).toEqual([expect.objectContaining({ tool: "list_templates", result: "ok" })]);
	});

	it("refuses deploy and push_update with 403, and anything else not granted with 400 — never forwarded", async () => {
		const { run, token } = await newRun();
		expect((await broker(run.id, "tool", { tool: "deploy" }, token)).status).toBe(403);
		expect((await broker(run.id, "tool", { tool: "push_update" }, token)).status).toBe(403);
		expect((await broker(run.id, "tool", { tool: "delete_site" }, token)).status).toBe(400);
		expect(fake.registry).toHaveLength(0);
	});

	it("a missing FreeWebStore grant is mcp_call_tool's refusal, passed back and recorded as an error", async () => {
		const { run, token } = await newRun();
		fake.registryAnswer = () => ({ success: false, content: "Error: create_site on https://fws.example/mcp is not granted for this agent." });
		const r = await broker(run.id, "tool", { tool: "create_site", args: { template_slug: "cafe-classic" } }, token);
		expect(r.body).toEqual({ success: false, content: expect.stringMatching(/not granted/) });
		expect((await stored(run.id)).evidence.fwsTranscript.at(-1)).toMatchObject({ tool: "create_site", result: "error", args: { template_slug: "cafe-classic" } });
	});

	it("forces noindex on set_meta and keeps page content off the transcript", async () => {
		const { run, token } = await newRun();
		await broker(run.id, "tool", { tool: "set_meta", args: { session_id: "s1", title: "Bean", description: "A long paragraph", noindex: false } }, token);
		expect(fake.registry[0].input.args).toMatchObject({ noindex: true });
		expect((await stored(run.id)).evidence.fwsTranscript.at(-1)).toEqual(expect.objectContaining({ tool: "set_meta", args: { session_id: "s1" } }));
	});

	it("takes the quality report and the draft session from FreeWebStore's answers, not the author's claims", async () => {
		const { run, token } = await newRun();
		fake.registryAnswer = (input) => ({ success: true, content: fenceUntrusted(input.tool === "create_site" ? '{"session_id":"sess-42"}' : '{"ready_for_human_review":true,"issues":[]}', "FreeWebStore") });
		await broker(run.id, "tool", { tool: "create_site", args: { template_slug: "cafe-classic" } }, token);
		await broker(run.id, "tool", { tool: "get_quality_report", args: { session_id: "sess-42" } }, token);
		const ev = (await stored(run.id)).evidence;
		expect(ev.sessionId).toBe("sess-42");
		expect(ev.qualityReport).toEqual({ ready_for_human_review: true, issues: [] });
		expect((await broker(run.id, "evidence", { qualityReport: { ready_for_human_review: true } }, token)).status).toBe(400);
		expect((await broker(run.id, "evidence", { screenshots: [] }, token)).status).toBe(400);
		expect((await broker(run.id, "evidence", { sessionId: "someone-elses" }, token)).status).toBe(409);
	});
});

describe("refinement is delivered, or not recorded (#841)", () => {
	it("a runner that refuses the refinement leaves the one allowed refinement unspent", async () => {
		const { run } = await newRun();
		fake.runnerAnswer = () => ({ status: 409, body: { error: "The author is still working on this draft" } });
		await expect(workflow.refineRuntimeBuilderRun(env, "i1", "u1", run.id, "Darker palette")).rejects.toThrow(/did not take the refinement: The author is still working/);
		expect((await stored(run.id)).refinementCount).toBe(0);
		expect(fake.runnerCalls.at(-1)?.path).toBe("/tasks/task_7/site-builder/refine");
	});

	it("a delivered refinement is recorded once, and the run is drafting again", async () => {
		const { run } = await newRun();
		const refined = await workflow.refineRuntimeBuilderRun(env, "i1", "u1", run.id, "Darker palette");
		expect(refined).toMatchObject({ refinementCount: 1, status: "drafting" });
		expect(fake.runnerCalls.at(-1)).toEqual({ path: "/tasks/task_7/site-builder/refine", body: { refinement: "Darker palette" } });
		await expect(workflow.refineRuntimeBuilderRun(env, "i1", "u1", run.id, "Again")).rejects.toThrow(/one refinement/);
	});
});

describe("draft → review → approve, end to end (#841)", () => {
	it("the author's calls bring the run to review; only the owner's approve starts site-deploy", async () => {
		const { run, token } = await newRun();
		fake.registryAnswer = (input) => ({ success: true, content: fenceUntrusted(input.tool === "create_site" ? '{"session_id":"sess-42"}' : '{"ready_for_human_review":true}', "FreeWebStore") });
		// PAGS's own capture path, standing in for R2: each capture becomes a stored screenshot artifact.
		vi.mocked(workflow.captureRuntimeBuilderPreview).mockImplementation(async (e, i, u, id, request) => {
			const current = (await workflow.getRuntimeBuilderRun(e, i, u, id))!;
			const evidence = { ...current.evidence, screenshots: [...current.evidence.screenshots, { device: request.device, id: request.device === "desktop" ? "a".repeat(64) : "b".repeat(64), capturedAt: "now" }] };
			await workflow.updateRuntimeBuilderRun(e, i, u, id, current.status, evidence, current.refinementCount);
			return (await workflow.getRuntimeBuilderRun(e, i, u, id))!;
		});

		await broker(run.id, "tool", { tool: "create_site", args: { template_slug: "cafe-classic" } }, token);
		await broker(run.id, "tool", { tool: "get_quality_report", args: { session_id: "sess-42" } }, token);
		await broker(run.id, "tool", { tool: "capture_preview", args: { device: "desktop", session_id: "sess-42" } }, token);
		expect((await stored(run.id)).status).toBe("drafting"); // one layout is not visual QA
		await broker(run.id, "tool", { tool: "capture_preview", args: { device: "mobile", session_id: "sess-42" } }, token);
		const ev = await broker(run.id, "evidence", { sessionId: "sess-42", deployParams: { name: "Bean There Cafe", slug: "bean-there" } }, token);
		expect(ev.body.status).toBe("awaiting_review");
		// Nothing has deployed: the author has no tool for it, and review is not approval.
		expect(fake.pipelines).toHaveLength(0);
		expect(fake.registry.map((r) => r.input.tool)).not.toContain("deploy");

		const approved = await workflow.approveRuntimeBuilderRun(env, "i1", "u1", run.id);
		expect(approved.status).toBe("approved");
		expect(fake.pipelines).toEqual([{ name: "site-deploy", params: { name: "Bean There Cafe", slug: "bean-there", session_id: "sess-42" } }]);
		// And the author's credential is now useless.
		expect((await broker(run.id, "tool", { tool: "list_templates" }, token)).status).toBe(409);
	});
});
