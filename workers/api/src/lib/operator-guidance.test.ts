/**
 * #1109 — the operator manual's generated `context` documents EVERY tool an instance may run, and
 * how to operate it. The rows come from the REAL registry through the same `resolveToolPolicy` +
 * `projectToolListing` pair `list_instance_tools` uses — not hand-written fixtures — so "every
 * allowed tool is documented" is held against the catalogue as it actually is, for every shape.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCapabilities } from "./agent-capabilities.js";
import { HttpError } from "./auth.js";
import type { GuideToolRow } from "./connection-guide.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { allToolPolicyInputs, projectToolListing, resolveToolPolicy } from "./instance-tool-policy.js";
import { buildOperatorGuidance, environmentSection, OPERATOR_GUIDANCE_MAX_CHARS, toolPurpose } from "./operator-guidance.js";
import type { Env } from "../types.js";
import type { RunnerEnvironment } from "./runner-resources.js";

vi.mock("./auth.js", async () => {
	const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const INSTANCE = "e4d2d031-833b-4ccf-8b39-8af08337075b";
const caps = (over: Partial<AgentCapabilities>): AgentCapabilities => ({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;
const rowsFor = (c: AgentCapabilities) => projectToolListing(resolveToolPolicy(c, [], allToolPolicyInputs(), []), { allowedOnly: true, schemas: true }) as GuideToolRow[];
const guidance = (c: AgentCapabilities) => buildOperatorGuidance({ instanceId: INSTANCE, surfaces: c.surfaces, runtime: c.runtime, tools: rowsFor(c) });

/** The Pro App Store Coder's 37 allowed tools, as `list_instance_tools allowed_only` returned them live on 2026-10-17. */
const PAS_CODER_TOOLS = [
	"github_workflow_runs", "github_workflow_run_logs", "github_list_issues", "github_read_issue", "github_list_issue_comments",
	"github_list_pulls", "github_read_pull", "github_create_issue", "github_comment_issue", "github_update_issue",
	"repo_tree", "repo_read_file", "repo_git", "repo_find", "repo_grep", "repo_remote",
	"start_work", "check_work", "stop_work", "end_coding_session", "get_behaviour", "set_behaviour", "get_stats", "set_stats_card",
	"run_pipeline", "record_feedback", "read_memory", "write_memory", "delete_memory", "get_tasks", "create_task", "update_task",
	"fetch_url", "configure_board", "get_activity", "get_user_context", "set_user_preference",
];
const PAS_CODER = caps({ surfaces: ["coding"], runtime: "coding", tools: PAS_CODER_TOOLS });

/** Each tool's block in the rendered text: its entry line and the lines under it. */
function entries(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const blocks = text.split("\n- `").slice(1);
	for (const b of blocks) out.set(b.slice(0, b.indexOf("`")), `- \`${b.split("\n- ")[0]}`);
	return out;
}
const callJson = (block: string) => {
	const m = block.match(/Call: `call_instance_tool` `(.+)`$/m);
	return m ? (JSON.parse(m[1]) as { instance_id: string; tool: string; input: Record<string, unknown> }) : null;
};

const SHAPES: Array<[string, AgentCapabilities]> = [
	["declares nothing (the permissive default)", caps({})],
	["declares EVERY tool — the worst case for size", caps({ tools: allToolPolicyInputs().map((t) => t.name) })],
	["the Pro App Store Coder's declaration", PAS_CODER],
	["a Repo Coder with the #1110 remote GitHub reads declared", caps({ surfaces: ["coding"], runtime: "coding", tools: [...PAS_CODER_TOOLS, "github_read_file", "github_tree"] })],
	["an Application Runner", caps({ runtime: "local_apply", tools: ["get_tasks"] })],
];

describe("every allowed tool is documented — for every shape (#1109)", () => {
	it.each(SHAPES)("%s", (_label, c) => {
		const rows = rowsFor(c);
		expect(rows.length, "the listing collapsed — coverage over nothing proves nothing").toBeGreaterThan(5);
		const text = buildOperatorGuidance({ instanceId: INSTANCE, surfaces: c.surfaces, runtime: c.runtime, tools: rows });
		expect(text.length).toBeLessThanOrEqual(OPERATOR_GUIDANCE_MAX_CHARS);
		expect(text, "the guidance was cut — a cut document cannot cover every tool").not.toContain("call list_instance_tools for the rest");
		const blocks = entries(text);
		const undocumented = rows.filter((r) => !blocks.has(r.name)).map((r) => r.name);
		expect(undocumented, "allowed tools missing from the operator guidance").toEqual([]);
		for (const r of rows) {
			const block = blocks.get(r.name) as string;
			expect(block, r.name).toContain(toolPurpose(r.description));
			expect(block, r.name).toMatch(/Args: /);
			expect(block, r.name).toMatch(r.mutates ? /\*\*changes something\*\*/ : /read-only/);
		}
	});
});

describe("callable vs chat-only — no false direct calls (#1109)", () => {
	it("a chat-only tool never gets a call_instance_tool example; every example parses, names its own tool and is callable", () => {
		const rows = rowsFor(PAS_CODER);
		const blocks = entries(guidance(PAS_CODER));
		const chatOnly = rows.filter((r) => !(r.invocableBy ?? []).includes("call_instance_tool"));
		expect(chatOnly.map((r) => r.name)).toEqual(expect.arrayContaining(["write_memory", "get_tasks", "fetch_url"]));
		for (const r of chatOnly) {
			expect(callJson(blocks.get(r.name) as string), r.name).toBeNull();
			expect(blocks.get(r.name), r.name).toMatch(/chat only — ask the agent with `chat_with_instance`; NOT directly callable/);
		}
		for (const r of rows.filter((x) => (x.invocableBy ?? []).includes("call_instance_tool"))) {
			const call = callJson(blocks.get(r.name) as string);
			expect(call, r.name).toMatchObject({ instance_id: INSTANCE, tool: r.name });
		}
	});

	it("the Pro App Store Coder: all 37 tools, the GitHub workflow/issue tools with their exact arguments, and the call_instance_tool procedure", () => {
		const text = guidance(PAS_CODER);
		const blocks = entries(text);
		for (const name of PAS_CODER_TOOLS) expect(blocks.has(name), name).toBe(true);
		expect(blocks.get("github_workflow_run_logs")).toMatch(/`repo` string \(required\), `run_id` number \(required\)/);
		expect(callJson(blocks.get("github_read_issue") as string)).toEqual({ instance_id: INSTANCE, tool: "github_read_issue", input: { repo: "<repo>", number: 0 } });
		expect(blocks.get("github_create_issue")).toMatch(/\*\*changes something\*\*, write consent required/);
		expect(text).toMatch(/\*\*Call a nested tool\.\*\* `call_instance_tool` with `instance_id`, `tool` and `input`/);
		expect(text).toMatch(/`coding_loop_start`.*`coding_loop_queue`.*`coding_loop_queue_reorder`.*`coding_loop_status`/s);
		expect(text).toMatch(/`task_action_log`.*`agent_trace`/s);
	});

	it("the #1110 remote reads, once declared, are documented and callable", () => {
		const blocks = entries(guidance(caps({ surfaces: ["coding"], tools: ["github_read_file", "github_tree"] })));
		expect(callJson(blocks.get("github_read_file") as string)).toEqual({ instance_id: INSTANCE, tool: "github_read_file", input: { repo: "<repo>", path: "<path>" } });
		expect(blocks.get("github_tree")).toMatch(/`repo` string \(required\), `path` string, `ref` string\. read-only/);
	});

	it("procedures follow the agent: no coding queue for a non-coding agent, the applications tools for an applications one", () => {
		expect(guidance(caps({ runtime: "local_apply" }))).toMatch(/`list_applications`.*`application_trace`/s);
		expect(guidance(caps({ runtime: "local_artifact" }))).not.toMatch(/coding_loop_start/);
		expect(guidance(PAS_CODER)).not.toMatch(/list_applications/);
	});

	it("is pure — the same rows render the same text", () => {
		expect(guidance(PAS_CODER)).toBe(guidance(PAS_CODER));
	});
});

describe("GET /v1/instances/:id/operator-manual (#1109)", () => {
	let d1: RealSchemaD1;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: [INSTANCE] });
	});
	afterEach(() => d1.close());

	it("returns the owner's manual byte-for-byte and a non-empty generated context; stores nothing", async () => {
		const owner = "  Drive me through the console.\n\nNever ask for a PR.  \n";
		d1.DB.prepare("UPDATE agent_instances SET operator_manual = ?1 WHERE id = ?2").bind(owner, INSTANCE).run();
		const { instanceRoutes } = await import("../routes/instances.js");
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", instanceRoutes);
		app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
		const res = await app.request(`/v1/instances/${INSTANCE}/operator-manual`, {}, { DB: d1.DB } as unknown as Env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { manual: string; context: string };
		expect(body.manual).toBe(owner);
		expect(body.context).toMatch(/^## Operating this instance \(generated\)/);
		expect(body.context).toContain("`call_instance_tool`");
		expect((d1.sqlite.prepare("SELECT operator_manual FROM agent_instances WHERE id = ?").get(INSTANCE) as { operator_manual: string }).operator_manual).toBe(owner);
	});
});

describe("operator manual and instance list carry the pinned machine's environment (#405)", () => {
	let d1: RealSchemaD1;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: [INSTANCE] });
	});
	afterEach(() => d1.close());
	const GiB = 1024 ** 3;
	const sampleJson = JSON.stringify({ loadAvg: null, cpus: 8, memTotalBytes: 16 * GiB, memFreeBytes: 8 * GiB, platform: "win32", sampledAt: Date.UTC(2026, 9, 26, 1, 0), host: { arch: "x64", shell: "msys-bash", home: "C:\\Users\\admin", node: "v22.4.0" } });
	const pin = (node: string) => d1.DB.prepare("UPDATE agent_instances SET config = ?1 WHERE id = ?2").bind(JSON.stringify({ runnerNode: node }), INSTANCE).run();
	const node = (name: string, resources: string | null) => d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status, resources) VALUES (?, 'u1', ?, 'relay://', 'registered', ?)").run(INSTANCE, name, resources);
	const call = async (path: string) => {
		const { instanceRoutes } = await import("../routes/instances.js");
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", instanceRoutes);
		app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
		const res = await app.request(path, {}, { DB: d1.DB } as unknown as Env);
		expect(res.status).toBe(200);
		return (await res.json()) as { environment: Record<string, unknown> | null; context: string; instances?: Array<{ id: string; environment?: Record<string, unknown> }> } & Array<{ id: string; environment?: Record<string, unknown> }>;
	};

	it("a pinned instance's manual says Windows / x64 / msys-bash, in `environment` and in the generated context", async () => {
		await pin("dell-laptop");
		node("dell-laptop", sampleJson);
		const body = await call(`/v1/instances/${INSTANCE}/operator-manual`);
		expect(body.environment).toMatchObject({ node: "dell-laptop", os: "win32", arch: "x64", shell: "msys-bash", home: "C:\\Users\\admin", nodeVersion: "v22.4.0" });
		expect(body.context).toContain("- default shell: msys-bash");
	});

	it("an instance pinned to a machine that has reported nothing is told not to assume", async () => {
		await pin("dell-laptop");
		node("dell-laptop", null);
		const body = await call(`/v1/instances/${INSTANCE}/operator-manual`);
		expect(body.environment).toBeNull();
		expect(body.context).toContain("has not reported its environment");
	});

	it("an unpinned instance has no environment and no section", async () => {
		node("dell-laptop", sampleJson); // a machine exists, but this instance is not pinned to it
		const body = await call(`/v1/instances/${INSTANCE}/operator-manual`);
		expect(body.environment).toBeNull();
		expect(body.context).not.toContain("Runner environment");
	});

	it("the instance list echoes the environment for the pinned instance only", async () => {
		await pin("dell-laptop");
		node("dell-laptop", sampleJson);
		const list = await call("/v1/instances/my/instances");
		// The route answers a bare array or `{ instances }`; `call` types it as both at once, which narrows one branch to `never`.
		type Row = { id: string; environment?: Record<string, unknown> };
		const rows = list as unknown as Row[] | { instances?: Row[] };
		const mine = (Array.isArray(rows) ? rows : (rows.instances ?? [])).find((i) => i.id === INSTANCE);
		expect(mine?.environment).toMatchObject({ os: "win32", arch: "x64", shell: "msys-bash" });
	});
});

describe("the runner environment section (#405)", () => {
	const e: RunnerEnvironment = { node: "dell-laptop", os: "win32", arch: "x64", shell: "msys-bash", home: "C:\\Users\\admin", nodeVersion: "v22.4.0", sampledAt: "2026-10-26T01:00:00.000Z" };
	const c = caps({ surfaces: [], runtime: null });
	const withEnv = (environment: typeof e | null | undefined) => buildOperatorGuidance({ instanceId: INSTANCE, surfaces: c.surfaces, runtime: c.runtime, tools: rowsFor(c), ...(environment === undefined ? {} : { environment }) });

	it("names OS, arch, default shell and home for a pinned machine, ahead of the procedures", () => {
		const text = withEnv(e);
		for (const line of ["- os: win32", "- arch: x64", "- default shell: msys-bash", "- home: C:\\Users\\admin", "- node: v22.4.0"]) expect(text).toContain(line);
		expect(text).toContain("`dell-laptop`");
		expect(text.indexOf("### Runner environment")).toBeLessThan(text.indexOf("### Tools this instance may run"));
	});

	it("says 'not reported' for a field a CLI did not send, instead of omitting it", () => {
		expect(withEnv({ ...e, arch: null, shell: null })).toMatch(/- arch: not reported[\s\S]*- default shell: not reported/);
	});

	it("tells a caller not to assume when the pinned machine has reported nothing", () => {
		expect(withEnv(null)).toMatch(/has not reported its environment[\s\S]*Do not assume the OS or shell/);
	});

	it("leaves an unpinned instance's guide exactly as it was", () => {
		expect(withEnv(undefined)).not.toContain("Runner environment");
		expect(environmentSection(undefined)).toEqual([]);
	});
});
