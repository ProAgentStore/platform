import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerAccountTools } from "./account.js";
import { registerApplyTools } from "./apply.js";
import { registerBaseTools } from "./base.js";
import { registerBoardTools } from "./board.js";
import { registerCodingTools } from "./coding.js";
import { registerCompositionTools } from "./composition.js";
import { registerConnectorGrantTools } from "./connectors.js";
import { registerInstanceTools } from "./index.js";
import { registerKnowledgeTools } from "./knowledge.js";
import { registerObservabilityTools } from "./observability.js";
import { registerRepoTools } from "./repo.js";
import { registerRuntimeTools } from "./runtime.js";
import { registerSettingsTools } from "./settings.js";
import type { InstanceToolsCtx } from "./shared.js";
import { registerStatsTools } from "./stats.js";
import { registerTriggerTools } from "./triggers.js";

// ── Why this file exists ─────────────────────────────────────────────────────
//
// `instance-tools.test.ts` next door drives individual tools hard: this route, this body,
// this audit event. It is a good test and this is not a replacement for it. What it cannot
// do — what nothing did — is answer a question about the SURFACE: is every tool still
// gated, and gated at the scope it was gated at yesterday?
//
// That question was unanswerable while 67 of the 86 instance tools lived in one 1871-line
// file (#305). A tool's scope is the fourth argument of a `requirePermission` call buried
// 20 lines into a closure; its confirmation string is a string literal repeated twice; its
// dry-run branch is an early return. Losing one in a refactor changes nothing that
// typechecks, nothing that any other test asserts, and nothing a reviewer scrolling past
// the fiftieth near-identical block will see.
//
// So the table below is DERIVED, not declared — every value in it is read back out of the
// registered handler by driving it:
//
//   scope    call the tool holding only `read`, then holding everything BUT `read`, and
//            read the required scope out of whichever denial comes back. A tool with no
//            gate at all denies neither, and shows up as "none" — which is the honest
//            answer and is itself worth pinning.
//   confirm  call it with full scopes and no `confirm`, and capture the string the
//            refusal demands.
//   dryRun   call it with `dry_run: true` and assert the network was never touched.
//
// Because it is derived, it is also the proof that the #305 split moved 67 registrations
// between nine files WITHOUT changing any of them: this table was generated against the
// pre-split `base.ts`, and is byte-identical against the post-split modules.
//
// The arguments are generated from each tool's own zod shape, so adding a tool cannot
// forget to add a probe — it appears in the derived table immediately and fails against
// the golden until someone writes down what it is allowed to do.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;
interface Captured {
	name: string;
	schema: Shape;
	handler: Handler;
}

/** A value the tool's own schema would accept, so a probe never fails on a missing
 *  argument rather than on the thing it is probing. */
// biome-ignore lint/suspicious/noExplicitAny: reading zod's internals is the point
function sample(t: any): unknown {
	const d = t?._def;
	switch (d?.typeName) {
		case "ZodOptional":
		case "ZodNullable":
		case "ZodDefault":
			return sample(d.innerType);
		case "ZodString":
			return "x";
		case "ZodNumber":
			return 1;
		case "ZodBoolean":
			return false;
		case "ZodEnum":
			return d.values[0];
		case "ZodArray":
			return [];
		case "ZodRecord":
		case "ZodObject":
			return {};
		case "ZodUnion":
			return sample(d.options[0]);
		default:
			return "x";
	}
}

/** `token`, `confirm` and `dry_run` are the probe's own controls, so they are supplied per
 *  probe rather than generated. */
function argsFor(schema: Shape): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, t] of Object.entries(schema)) {
		if (key === "token" || key === "confirm" || key === "dry_run") continue;
		out[key] = sample(t);
	}
	return out;
}

function fakeServer(into: Map<string, Captured>) {
	return {
		tool(name: string, _description: string, schema: Shape, handler: Handler) {
			if (into.has(name)) throw new Error(`registered twice: ${name}`);
			into.set(name, { name, schema, handler });
		},
	};
}

const ALL_SCOPES = ["read", "write", "runtime", "destructive"];
const env: McpEnv = { API_BASE: "https://api.test" };

/** Every instance tool, registered once. `scopes` is read at CALL time, so one
 *  registration serves every probe — the tool set cannot differ between them. */
let scopes: string[] | null = ALL_SCOPES;
let calls: string[] = [];
let tools: Map<string, Captured>;

beforeEach(() => {
	calls = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(`${(init?.method || "GET").toUpperCase()} ${String(input)}`);
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	scopes = ALL_SCOPES;
	tools = new Map();
	registerInstanceTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		fakeServer(tools) as any,
		env,
		(provided?: string) => provided || "session-token",
		(): SafetyContext => ({ env, subject: "user-1", scopes }),
		new Set(["apply", "repo", "coding"]),
	);
});

afterEach(() => vi.unstubAllGlobals());

async function say(name: string, extra: Record<string, unknown> = {}): Promise<string> {
	const t = tools.get(name);
	if (!t) throw new Error(`no such tool: ${name}`);
	return (await t.handler({ ...argsFor(t.schema), ...extra })).content[0].text;
}

/** The scope a tool actually enforces — read out of the refusal, not out of the source. */
async function scopeOf(name: string): Promise<string> {
	scopes = ["read"];
	const withoutWrite = await say(name);
	scopes = ["write", "runtime", "destructive"];
	const withoutRead = await say(name);
	scopes = ALL_SCOPES;
	return (
		withoutWrite.match(/requires MCP scope "(\w+)"/)?.[1] ??
		withoutRead.match(/requires MCP scope "(\w+)"/)?.[1] ??
		"none"
	);
}

/** The exact string the tool demands in `confirm`, or null if it demands none. */
async function confirmOf(name: string): Promise<string | null> {
	return (await say(name)).match(/requires confirm="([^"]+)"/)?.[1] ?? null;
}

/** How the tool answers `dry_run: true` — and whether it stayed off the network while
 *  doing so, which is the only property that makes a dry run worth having. */
async function dryRunOf(name: string): Promise<string | null> {
	const t = tools.get(name);
	if (!t || !("dry_run" in t.schema)) return null;
	const before = calls.length;
	const txt = await say(name, { dry_run: true });
	const touchedNetwork = calls.length !== before;
	let envelope = false;
	try {
		envelope = (JSON.parse(txt) as { dryRun?: boolean }).dryRun === true;
	} catch {
		envelope = false;
	}
	if (touchedNetwork) return "LEAKED";
	return envelope ? "envelope" : "text";
}

// ── The table ────────────────────────────────────────────────────────────────
//
// name -> [group, scope, confirm, dryRun, input fields]
//
// `group` is which registrar owns it — the #305 seam, and the only column the split
// changed. Everything else was generated against the pre-split file and must not move.
//
// `dryRun`:  "envelope"  the standard `{dryRun:true, tool, action, wouldDo}` payload
//            "text"      a plain sentence instead of the envelope — only
//                        `set_instance_tool`, which does not call the `dryRun()` helper.
//                        Recorded because it is what the tool does, not because it is
//                        what it should do.
//            null        the tool declares no `dry_run` at all
//
// One row is knowingly incomplete: `remove_repo` picks its scope from its arguments
// (`write` for one repo, `destructive` for all), and a table has one cell per tool. The
// probe takes the one-repo path, and the escalation gets its own test at the bottom.
type Row = [string, string, string | null, string | null, string];
const TABLE: Record<string, Row> = {
	add_instance_knowledge: ["knowledge", "write", null, "envelope", "content,dry_run,instance_id,source,source_url,title,token"],
	agent_trace: ["observability", "none", null, null, "instance_id,level,limit,offset,source,token,trace_id"],
	apply_to_job: ["apply", "runtime", null, "envelope", "dry_run,instance_id,submit,token,url"],
	approve_instance_task: ["runtime", "runtime", null, "envelope", "dry_run,instance_id,task_id,token"],
	ask_ticket: ["board", "write", null, "envelope", "dry_run,instance_id,question,task_id,token"],
	billing_status: ["account", "none", null, null, "token"],
	get_budget_limits: ["account", "none", null, null, "token"],
	set_budget_limits: [
		"account",
		"write",
		null,
		"envelope",
		// All six columns of account_budget_limits (#501) — a field this tool cannot name is a
		// field an MCP caller cannot set, and used to be one it silently cleared.
		"charged_micros_ceiling,dry_run,loop_max_iterations,per_tree_cost_micros,per_tree_delegations,per_tree_max_depth,token,token_ceiling",
	],
	call_instance_tool: ["base", "write", null, null, "input,instance_id,token,tool"],
	cancel_instance: ["base", "destructive", "cancel_instance", "envelope", "confirm,dry_run,instance_id,token"],
	cancel_instance_task: ["runtime", "destructive", "cancel_instance_task", "envelope", "confirm,dry_run,instance_id,task_id,token"],
	chat_with_instance: ["base", "runtime", null, "envelope", "dry_run,instance_id,message,token"],
	check_instance_loop: ["composition", "read", null, null, "instance_id,run_id,token"],
	coding_timeline: ["coding", "read", null, null, "instance_id,limit,session_id,since_seq,token"],
	clear_finished_tasks: ["board", "write", null, "envelope", "dry_run,instance_id,token"],
	clear_instance_messages: ["observability", "destructive", "clear_instance_messages", "envelope", "confirm,dry_run,instance_id,token"],
	coding_loop_start: ["coding", "runtime", null, "envelope", "dry_run,instance_id,max_iterations,objective,token"],
	// Both were ungated ("none") while they read and mutated MCP-DO memory, which nothing else
	// could see. Now they read and cancel the SERVER's run record, so they are scoped like every
	// other read and every other write (#502).
	coding_loop_status: ["coding", "read", null, null, "instance_id,run_id,token"],
	coding_loop_stop: ["coding", "write", null, null, "instance_id,run_id,token"],
	connector_status: ["connectors", "none", null, null, "provider,token"],
	create_connection: ["composition", "write", null, "envelope", "action,config,dry_run,event_type,instance_id,target_instance_id,token"],
	create_instance_trigger: ["triggers", "write", null, "envelope", "action,config,dry_run,instance_id,name,schedule,token,type"],
	create_supervision: ["composition", "write", null, "envelope", "dry_run,subordinate_instance_id,supervisor_instance_id,token"],
	delete_instance_connector_grant: ["connectors", "destructive", "delete_instance_connector_grant", "envelope", "confirm,dry_run,grant_id,instance_id,provider,token"],
	delete_instance_file: ["knowledge", "destructive", "delete_instance_file", "envelope", "confirm,dry_run,file_id,instance_id,token"],
	delete_instance_knowledge: ["knowledge", "destructive", "delete_instance_knowledge", "envelope", "confirm,document_id,dry_run,instance_id,token"],
	delete_instance_memory: ["knowledge", "destructive", "delete_instance_memory", "envelope", "confirm,dry_run,instance_id,key,token"],
	delete_instance_trigger: ["triggers", "destructive", "delete_instance_trigger", "envelope", "confirm,dry_run,token,trigger_id"],
	delete_supervision: ["composition", "destructive", "delete_supervision", "envelope", "confirm,dry_run,supervision_id,supervisor_instance_id,token"],
	email_status: ["account", "none", null, null, "token"],
	get_agent_settings_schema: ["settings", "none", null, null, "agent_id,token"],
	get_agent_stats_schema: ["stats", "none", null, null, "agent_id,token"],
	get_apply_tips: ["apply", "none", null, null, "instance_id,token"],
	get_instance_board_config: ["board", "none", null, null, "instance_id,token"],
	get_instance_instructions: ["settings", "none", null, null, "instance_id,token"],
	get_instance_memory: ["knowledge", "none", null, null, "instance_id,token"],
	get_instance_settings: ["settings", "none", null, null, "instance_id,token"],
	get_instance_state: ["settings", "none", null, null, "instance_id,token"],
	get_instance_stats: ["stats", "none", null, null, "instance_id,schema_only,token,window"],
	get_profile: ["apply", "none", null, null, "token"],
	get_translation_config: ["settings", "none", null, null, "instance_id,token"],
	grant_instance_connector_folder: ["connectors", "write", null, "envelope", "dry_run,instance_id,name,provider,resource_id,token,url"],
	hint_instance_task: ["board", "write", null, "envelope", "dry_run,hint,instance_id,task_id,token"],
	ingest_repo: ["repo", "write", null, "envelope", "branch,dry_run,instance_id,repo_url,token"],
	ingest_repo_status: ["repo", "none", null, null, "instance_id,token"],
	instance_activity: ["observability", "none", null, null, "instance_id,token"],
	// `reasoning` (a BOOLEAN here, not the writer's string) added by #574: the field
	// `create_instance_ticket` accepts had no reader, so this tool gained the argument that asks
	// for it. Still ungated — it widens a read, and reads nothing the caller could not already see.
	instance_board: ["board", "none", null, null, "instance_id,limit,offset,reasoning,token"],
	// `before` added at #566: the response has always carried `nextCursor`/`hasMore` and no input
	// could use either, so every message older than the newest page was unreachable over MCP.
	instance_messages: ["observability", "none", null, null, "before,instance_id,limit,token"],
	instance_runtime_status: ["runtime", "none", null, null, "instance_id,probe,token"],
	instance_task_events: ["runtime", "none", null, null, "instance_id,limit,token"],
	keys_status: ["account", "none", null, null, "token"],
	list_connections: ["composition", "read", null, null, "instance_id,token"],
	list_errors: ["observability", "none", null, null, "limit,scope,source,token"],
	list_instance_connector_grants: ["connectors", "none", null, null, "instance_id,provider,token"],
	list_instance_files: ["knowledge", "none", null, null, "instance_id,token"],
	list_instance_knowledge: ["knowledge", "none", null, null, "instance_id,token"],
	// +schemas at #569: the input schemas are opt-in now, because the default response was 89 KB.
	list_instance_tools: ["base", "none", null, null, "allowed_only,instance_id,schemas,token"],
	list_instance_trigger_events: ["triggers", "read", null, null, "limit,token,trigger_id"],
	list_instance_triggers: ["triggers", "read", null, null, "instance_id,token"],
	get_instance_pipeline: ["observability", "none", null, null, "instance_id,pipeline,token"],
	list_feedback: ["observability", "none", null, null, "instance_id,limit,status,token"],
	list_pipeline_runs: ["observability", "none", null, null, "instance_id,limit,pipeline,token"],
	list_supervision: ["composition", "read", null, null, "supervisor_instance_id,token"],
	my_instances: ["base", "none", null, null, "token"],
	register_instance_runtime: ["runtime", "runtime", null, "envelope", "capabilities,dry_run,endpoint_url,instance_id,placement,runner_token,runner_version,token"],
	resolve_feedback: ["observability", "write", null, "envelope", "dry_run,feedback_id,issue_url,status,token"],
	remove_repo: ["repo", "write", null, "envelope", "confirm,dry_run,instance_id,repo_url,token"],
	rename_instance: ["settings", "write", null, "envelope", "dry_run,instance_id,name,token"],
	run_instance_task: ["runtime", "runtime", null, "envelope", "approval_prompt,dry_run,input,instance_id,requires_approval,token,type"],
	run_instance_trigger: ["triggers", "runtime", null, "envelope", "dry_run,payload,token,trigger_id"],
	search_instance_knowledge: ["knowledge", "none", null, null, "instance_id,query,token,top_k"],
	set_agent_settings_schema: ["settings", "write", null, "envelope", "agent_id,dry_run,settings_schema,token"],
	set_agent_stats_schema: ["stats", "write", null, "envelope", "agent_id,cards,dry_run,token"],
	set_board_item_status: ["board", "write", null, "envelope", "dry_run,instance_id,job_key,status,token"],
	update_board_ticket: ["board", "write", null, "envelope", "description,dry_run,instance_id,job_key,reasoning,title,token"],
	set_instance_board_config: ["board", "write", null, "envelope", "columns,dry_run,instance_id,reset,token,view"],
	set_instance_instructions: ["settings", "write", null, "envelope", "dry_run,instance_id,instructions,token"],
	set_instance_model: ["settings", "write", null, "envelope", "dry_run,instance_id,model,token"],
	set_instance_settings: ["settings", "write", null, "envelope", "dry_run,instance_id,settings,token"],
	set_instance_stats: ["stats", "write", null, "envelope", "dry_run,instance_id,ops,token"],
	set_instance_tool: ["base", "write", null, "text", "dry_run,enabled,instance_id,token,tool"],
	set_translation_config: ["settings", "write", null, "envelope", "dry_run,enabled,font_size,instance_id,target,token,transliterate,word_tap"],
	start_instance_loop: ["composition", "write", null, "envelope", "dry_run,instance_id,max_iterations,objective,token"],
	stop_instance_loop: ["composition", "write", null, null, "instance_id,run_id,token"],
	subscribe_agent: ["base", "write", null, "envelope", "agent_id,dry_run,token"],
	system_status: ["coding", "none", null, null, "instance_id,token"],
	ticket_thread: ["board", "none", null, null, "instance_id,task_id,token"],
	unregister_instance_runtime: ["runtime", "destructive", "unregister_instance_runtime", "envelope", "confirm,dry_run,instance_id,token"],
	update_profile: ["account", "write", null, "envelope", "dry_run,fields,token"],
	upload_resume: ["apply", "write", null, "envelope", "content_base64,dry_run,filename,instance_id,token,url"],
	usage_summary: ["account", "none", null, null, "range,token"],
	// `offset`/`limit` at #595: 315 sources measured at 151,700 bytes, 2.3x a calling host's
	// 64 KiB limit, so the inventory is paged. Still ungated — paging a read changes nothing
	// about what it may see.
	vector_stats: ["knowledge", "none", null, null, "instance_id,limit,offset,token"],
	write_instance_memory: ["knowledge", "write", null, "envelope", "content,dry_run,instance_id,key,token,type"],
};

/** Which registrar owns each tool — the seam #305 introduced, checked rather than
 *  described, so a tool cannot drift into a group whose header says something else. */
const REGISTRARS: Record<string, (s: unknown, c: InstanceToolsCtx) => void> = {
	// biome-ignore-start lint/suspicious/noExplicitAny: minimal fake MCP server
	account: registerAccountTools as any,
	apply: registerApplyTools as any,
	base: registerBaseTools as any,
	board: registerBoardTools as any,
	coding: registerCodingTools as any,
	composition: registerCompositionTools as any,
	connectors: registerConnectorGrantTools as any,
	knowledge: registerKnowledgeTools as any,
	observability: registerObservabilityTools as any,
	repo: registerRepoTools as any,
	runtime: registerRuntimeTools as any,
	settings: registerSettingsTools as any,
	stats: registerStatsTools as any,
	triggers: registerTriggerTools as any,
	// biome-ignore-end lint/suspicious/noExplicitAny: minimal fake MCP server
};

describe("the instance tool surface", () => {
	it("registers exactly the tools in the table, and each exactly once", () => {
		expect([...tools.keys()].sort()).toEqual(Object.keys(TABLE).sort());
	});

	it("assigns every tool to exactly one group registrar", () => {
		const ctx: InstanceToolsCtx = {
			env,
			tokenFor: (p?: string) => p || "t",
			safetyFor: (): SafetyContext => ({ env, scopes: ALL_SCOPES }),
			groups: new Set(["apply", "repo", "coding"]),
		};
		const owner = new Map<string, string>();
		for (const [group, register] of Object.entries(REGISTRARS)) {
			const into = new Map<string, Captured>();
			register(fakeServer(into), ctx);
			for (const name of into.keys()) {
				expect(owner.has(name), `${name} is registered by two groups`).toBe(false);
				owner.set(name, group);
			}
		}
		const actual = Object.fromEntries([...owner.entries()].sort());
		const expected = Object.fromEntries(
			Object.entries(TABLE)
				.map(([name, row]) => [name, row[0]] as const)
				.sort(),
		);
		expect(actual).toEqual(expected);
	});

	it("enforces the scope, confirmation and dry-run each tool is recorded with", async () => {
		const actual: Record<string, unknown[]> = {};
		for (const name of Object.keys(TABLE).sort()) {
			const t = tools.get(name);
			if (!t) continue;
			actual[name] = [
				await scopeOf(name),
				await confirmOf(name),
				await dryRunOf(name),
				Object.keys(t.schema).sort().join(","),
			];
		}
		const expected = Object.fromEntries(
			Object.entries(TABLE).map(([name, row]) => [name, row.slice(1)]),
		);
		expect(actual).toEqual(expected);
	});
});

// ── Invariants read off the table ────────────────────────────────────────────
//
// Stated separately from the table so a NEW tool has to face them as rules rather than as
// a row someone pasted. Each one is a convention `workers/mcp/CLAUDE.md` states in prose
// and nothing checked.

describe("conventions the table has to keep", () => {
	const rows = Object.entries(TABLE);

	it("a confirmation string is always the tool's own name", () => {
		// `remove_repo` is the documented exception, and the table cannot see it: it demands
		// `remove_all_repos`, but only on the remove-everything path, which the probe does
		// not take. It gets its own test below rather than a footnote here.
		expect(rows.filter(([name, r]) => r[2] !== null && r[2] !== name).map(([n]) => n)).toEqual([]);
	});

	it("only a destructive tool asks for confirmation", () => {
		expect(rows.filter(([, r]) => r[2] !== null && r[1] !== "destructive").map(([n]) => n)).toEqual([]);
	});

	it("every destructive tool is confirmed", () => {
		// This assertion used to carry one exemption. `delete_supervision` (#183) took the
		// `destructive` scope but demanded no confirmation and offered no preview — the only
		// tool in the surface like that. #305 recorded it here rather than fixing it, because
		// that commit moved code and changed no behaviour; #328 closed it, and the exemption
		// went with it. There is no list any more, and adding one back needs a reason good
		// enough to survive being written next to this paragraph.
		expect(rows.filter(([, r]) => r[1] === "destructive" && r[2] === null).map(([n]) => n)).toEqual([]);
	});

	it("remove_repo escalates to destructive only when it removes everything", async () => {
		// The one tool in the surface whose scope depends on its ARGUMENTS, which is why a
		// single row in the table above records it as `write` and would happily go on
		// recording that if the escalation were deleted. Removing one repo is a write;
		// removing all of them is destructive AND confirmed, with a confirmation string
		// that deliberately is not the tool's own name so it cannot be typed by reflex.
		scopes = ["write", "runtime"];
		expect(await say("remove_repo", { repo_url: "https://github.com/o/r" })).not.toContain("requires MCP scope");
		expect(await say("remove_repo", { repo_url: undefined })).toContain('requires MCP scope "destructive"');
		scopes = ALL_SCOPES;
		expect(await say("remove_repo", { repo_url: undefined })).toContain('requires confirm="remove_all_repos"');
	});

	it("a declared dry run never reaches the network", async () => {
		// `dryRunOf` returns "LEAKED" when the handler called fetch anyway. Nothing may.
		for (const [name, row] of rows) {
			if (row[3] === null) continue;
			expect(await dryRunOf(name), `${name} performed its side effect during a dry run`).not.toBe("LEAKED");
		}
	});

	it("names the mutating tools that offer no dry run at all", () => {
		// Not a failure — a list, and a short one now. It held seven until #328, which went
		// through them one at a time rather than adding `dry_run` to all seven by reflex:
		// five gained a preview that says something the caller could not otherwise learn
		// without performing the mutation, and two did not, because for them it could not.
		//
		//   call_instance_tool   a generic invoker over the API's connector registry, which
		//                        this worker cannot see. Its preview would only echo the
		//                        caller's own arguments back. `list_instance_tools` is the
		//                        real preview: it reads the verdict and the schema out of
		//                        the registry, and it is a read tool.
		//   stop_instance_loop   the call is fully described by `run_id`, and the question
		//                        worth asking ("which run is that?") is answered better by
		//                        `check_instance_loop`. Stopping is also the safe direction:
		//                        cooperative, the in-flight step settles its own spend.
		//   coding_loop_stop     the same tool by another name since #502 — it cancels the same
		//                        durable run through the same route, so it inherits the same
		//                        argument for having no preview.
		//
		// All three carry that reasoning in a comment above their registration. Anything joining
		// this list needs the same — the entry here is the index, not the argument.
		expect(
			rows.filter(([, r]) => ["write", "runtime", "destructive"].includes(r[1]) && r[3] === null).map(([n]) => n),
		).toEqual(["call_instance_tool", "coding_loop_stop", "stop_instance_loop"]);
	});

	it("every tool takes the standard optional session token", () => {
		expect(rows.filter(([, r]) => !r[4].split(",").includes("token")).map(([n]) => n)).toEqual([]);
	});
});
