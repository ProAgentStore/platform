/**
 * Can a field the MCP WRITER accepts be read back by some MCP READER? (#574)
 *
 * ── The bug this generalises ────────────────────────────────────────────────────────────
 *
 * `create_instance_ticket` has always taken a `reasoning` argument, described as the
 * decision/audit. `instance_board` built each card from a fixed field list that mapped
 * `detail: it.description` and never carried `reasoning`. So MCP could WRITE the field and no
 * MCP reader could FETCH it — `ask_ticket` reaches it, but that is a model call over one
 * ticket, not a read. Measured on one real card: `description` 375 chars, `reasoning` 691.
 *
 * `reasoning` is one instance. The general defect is a write surface and a read surface that
 * are specified separately and never checked against each other, and nothing in this repo
 * looked at the pair. This file looks — over the WHOLE write-tool argument set, not a
 * hand-picked list, because a guard that examines a subset certifies ground it never walked
 * (ADR 0002).
 *
 * ── How it gets its input ───────────────────────────────────────────────────────────────
 *
 * From the WIRE: the real `PagsMcp.init()`, a real `Client` over `InMemoryTransport`, and
 * `listTools()` — the same harness `conformance.test.ts` uses, and for the same reason. Every
 * surface is gated on so the denominator is the whole registrable surface
 * (`MCP_TOOL_COUNT`), not the always-on subset. A tool is a WRITER when the annotations it
 * publishes say `readOnlyHint !== true`, so the classification is the one a host actually
 * receives rather than a second opinion held here.
 *
 * ── What is DECLARED, and why it cannot be derived ──────────────────────────────────────
 *
 * "Does reader R return field F" is not statically decidable: a reader returns whatever
 * `workers/api` sends, and this worker cannot import that. So the readback is DECLARED, once,
 * in {@link READBACK} — and every write argument must appear either there or in
 * {@link CONTROL_ARGS}. An argument in neither FAILS this test rather than being skipped,
 * which is the property that makes the denominator real: a new write argument cannot join the
 * surface without someone writing down where it can be read back, exactly as
 * `BUILTIN_TOOL_SCOPES` forces the read/write decision in the API worker.
 *
 * The honest limit, stated: this file proves the QUESTION was asked of every argument. It
 * cannot prove a declared answer is true. `reasoning` gets that second proof separately, in
 * `board-reasoning.test.ts`, by driving the tool.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

const { PagsMcp } = await import("./index.js");
const { MCP_TOOL_COUNT } = await import("./tool-count.js");

type WireTool = {
	name: string;
	annotations?: { readOnlyHint?: boolean };
	inputSchema?: { properties?: Record<string, unknown> };
};

/**
 * Arguments that are not persisted content, so "can it be read back" does not apply:
 * authentication, addressing (which record), preview/confirmation, and read-shaping
 * (paging, filtering, projection).
 *
 * A NAME-level list, because these mean the same thing on every tool that takes them. It is
 * deliberately short and closed — anything not here has to be decided per tool.
 */
const CONTROL_ARGS: ReadonlySet<string> = new Set([
	// auth + preview + confirmation
	"token",
	"dry_run",
	"confirm",
	// addressing: which record this call is about
	"instance_id",
	"agent_id",
	"task_id",
	"trigger_id",
	"feedback_id",
	"supervision_id",
	"supervisor_instance_id",
	"document_id",
	"file_id",
	"record_id",
	"session_id",
	"connection_id",
	"grant_id",
	"run_id",
	"job_key",
	"repo_id",
	"node_id",
	// read-shaping on a tool that also writes
	"limit",
	"before",
	"trace_id",
	"source",
	"scope",
	"status",
	"query",
	"top_k",
	"pipeline",
	"allowed_only",
	"schemas",
	"probe",
	"reset",
	"enabled",
]);

/**
 * Every CONTENT argument of every write tool → the MCP reader that can fetch it back.
 *
 * `null` means "written and NOT readable over MCP" — the `reasoning` shape. Those are counted
 * and printed, because the number is the finding: the issue deliberately declined to claim
 * whether others existed, and this is what measures it.
 */
const READBACK: Record<string, string | null> = {
	// ── the ticket the issue is about ──
	"create_instance_ticket.title": "instance_board",
	"create_instance_ticket.description": "instance_board",
	"create_instance_ticket.type": "instance_board",
	// #574: the fix. `instance_board(reasoning:true)` returns it; `board-reasoning.test.ts`
	// proves that by driving the tool, not by trusting this line.
	"create_instance_ticket.reasoning": "instance_board",
	// PAS #137 — the same three fields, amended rather than filed. They read back through the
	// same card, so if `instance_board` ever stops returning one of them BOTH the create and
	// the edit path go unreadable together, which is the honest coupling.
	"update_board_ticket.title": "instance_board",
	"update_board_ticket.description": "instance_board",
	"update_board_ticket.reasoning": "instance_board",

	// ── conversation ──
	"chat_with_agent.message": "instance_messages",
	"chat_with_instance.message": "instance_messages",
	"coding_session_message.message": "coding_session_capture",
	"coding_overseer.message": "instance_messages",

	// ── memory / knowledge / files / collections ──
	"write_instance_memory.key": "get_instance_memory",
	"write_instance_memory.type": "get_instance_memory",
	"write_instance_memory.content": "get_instance_memory",
	"delete_instance_memory.key": "get_instance_memory",
	"add_instance_knowledge.title": "list_instance_knowledge",
	"add_instance_knowledge.content": "search_instance_knowledge",
	"add_instance_knowledge.source_url": "list_instance_knowledge",
	"add_knowledge.title": "list_knowledge",
	"add_knowledge.content": "search_agent_knowledge",
	"upload_agent_file.name": "list_agent_files",
	"upload_agent_file.content": "read_agent_file",
	"upload_agent_file.content_base64": null, // raw bytes — no MCP reader returns them; extracted text is readable via read_agent_file
	"upload_agent_file.mime_type": "list_agent_files",
	"upload_agent_file.tags": "list_agent_files",
	"create_collection.name": "list_collections",
	"create_collection.fields": "list_collections",
	"insert_record.collection": "query_records",
	"insert_record.data": "query_records",
	"update_record.collection": "query_records",
	"update_record.data": "query_records",
	"insert_instance_record.collection": "query_instance_records",
	"insert_instance_record.data": "query_instance_records",

	// ── settings / identity / behaviour ──
	"rename_instance.name": "my_instances",
	"set_instance_settings.settings": "get_instance_settings",
	"set_instance_instructions.instructions": "get_instance_instructions",
	"set_instance_model.model": "get_instance_state",
	// #671. Readable by the tool added alongside it — the gap this closed was precisely that the
	// pin could be neither read nor written here, so a reader had to exist for the writer to land.
	"set_instance_runner_node.runner_node": "instance_runner_node",
	"set_agent_settings_schema.settings_schema": "get_agent_settings_schema",
	"set_translation_config.enabled": "get_translation_config",
	"set_translation_config.target": "get_translation_config",
	"set_translation_config.transliterate": "get_translation_config",
	"set_translation_config.word_tap": "get_translation_config",
	"set_translation_config.font_size": "get_translation_config",
	"update_profile.fields": "get_profile",

	// ── board ──
	"set_board_item_status.status": "instance_board",
	"set_instance_board_config.columns": "get_instance_board_config",
	"set_instance_board_config.view": "get_instance_board_config",
	"update_agent_board_config.config": "get_agent_board_config",
	"hint_instance_task.hint": "ticket_thread",
	"ask_ticket.question": "ticket_thread",

	// ── tasks / runtime ──
	"run_instance_task.type": "instance_task_events",
	"run_instance_task.input": "instance_task_events",
	"run_instance_task.requires_approval": "instance_task_events",
	"run_instance_task.approval_prompt": "instance_task_events",
	"register_instance_runtime.endpoint_url": "instance_runtime_status",
	"register_instance_runtime.placement": "instance_runtime_status",
	"register_instance_runtime.capabilities": "instance_runtime_status",
	"register_instance_runtime.runner_version": "instance_runtime_status",
	// A shared secret. Never returned by any reader, and that is the correct design, not a
	// gap — the same rule keeps the credentials vault and the Gmail refresh token off MCP.
	"register_instance_runtime.runner_token": null,

	// ── tools / invocation ──
	"set_instance_tool.tool": "list_instance_tools",
	"call_instance_tool.tool": "mcp_audit_log",
	"call_instance_tool.input": "mcp_audit_log",

	// ── triggers / connections / supervision ──
	"create_instance_trigger.name": "list_instance_triggers",
	"create_instance_trigger.type": "list_instance_triggers",
	"create_instance_trigger.action": "list_instance_triggers",
	"create_instance_trigger.schedule": "list_instance_triggers",
	"create_instance_trigger.config": "list_instance_triggers",
	"run_instance_trigger.payload": "list_instance_trigger_events",
	"create_supervision.subordinate_instance_id": "list_supervision",
	"create_connection.event_type": "list_connections",
	"create_connection.target_instance_id": "list_connections",
	"create_connection.action": "list_connections",
	"create_connection.config": "list_connections",

	// ── loops ──
	"start_instance_loop.objective": "check_instance_loop",
	"start_instance_loop.max_iterations": "check_instance_loop",
	"coding_loop_start.objective": "coding_loop_status",
	"coding_loop_start.max_iterations": "coding_loop_status",

	// ── feedback ──
	"resolve_feedback.issue_url": "list_feedback",

	// ── budget ──
	"set_budget_limits.token_ceiling": "usage_summary",
	"set_budget_limits.charged_micros_ceiling": "usage_summary",
	"set_budget_limits.per_tree_cost_micros": "usage_summary",
	"set_budget_limits.per_tree_delegations": "usage_summary",
	"set_budget_limits.per_tree_max_depth": "usage_summary",
	"set_budget_limits.loop_max_iterations": "usage_summary",

	// ── connector grants ──
	"grant_instance_connector_folder.provider": "list_instance_connector_grants",
	"grant_instance_connector_folder.url": "list_instance_connector_grants",
	"grant_instance_connector_folder.resource_id": "list_instance_connector_grants",
	"grant_instance_connector_folder.name": "list_instance_connector_grants",
	"delete_instance_connector_grant.provider": "list_instance_connector_grants",

	// ── stats ──
	"set_agent_stats_schema.cards": "get_agent_stats_schema",
	"set_instance_stats.ops": "get_instance_stats",

	// ── repos ──
	"ingest_repo.repo_url": "ingest_repo_status",
	"ingest_repo.branch": "ingest_repo_status",
	"remove_repo.repo_url": "ingest_repo_status",
	"coding_repo_add.path": "coding_repos_list",
	"coding_session_fresh.engine_id": "coding_sessions_list",
	"coding_session_open.engine_id": "coding_sessions_list",

	// ── subscribe ──
	// The idempotency key is stored on the instance row as a dedup guard (#716). It is not
	// a piece of content the subscriber manages; no reader surfaces it, and that is correct —
	// the same rule keeps the credentials vault and the relay token off MCP.
	"subscribe_agent.idempotency_key": null,

	// ── apply ──
	"apply_to_job.url": "instance_board",
	"apply_to_job.submit": "instance_board",
	"upload_resume.url": "list_instance_files",
	"upload_resume.filename": "list_instance_files",
	// The résumé BYTES. `list_instance_files` returns the metadata; MCP deliberately exposes no
	// binary download (see the "Deliberately NOT exposed via MCP" list in the platform docs).
	"upload_resume.content_base64": null,

	// ── agent authoring ──
	"create_agent.slug": "agent_info",
	"create_agent.name": "agent_info",
	"create_agent.description": "agent_info",
	"create_agent.category": "agent_info",
	"create_agent.model": "agent_info",
	"create_agent.personality": "agent_info",
	"create_agent.goal": "agent_info",
	"create_agent.capabilities": "agent_info",
	"create_agent.settings_schema": "get_agent_settings_schema",
	"scaffold_agent.slug": "agent_info",
	"scaffold_agent.name": "agent_info",
	"scaffold_agent.description": "agent_info",
	"scaffold_agent.category": "agent_info",
	"scaffold_agent.model": "agent_info",
	"scaffold_agent.template": "agent_deploy_status",
	"scaffold_agent.personality": "agent_info",
	"scaffold_agent.goal": "agent_info",
	"scaffold_agent.auto_deploy": "agent_deploy_status",
	"update_agent.name": "agent_info",
	"update_agent.description": "agent_info",
	"update_agent.visibility": "agent_info",
	"update_agent.model": "agent_info",
	"update_agent.capabilities": "agent_info",
	"write_agent_file.path": "list_agent_files",
	"write_agent_file.content": "read_agent_file",
	"write_agent_file.message": "agent_deploy_status",
	"batch_write_agent_files.files": "list_agent_files",
	"batch_write_agent_files.message": "agent_deploy_status",
};

async function listPublishedTools(): Promise<WireTool[]> {
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;

	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		const body = url.endsWith("/v1/instances/my/instances")
			? { instances: ["apply", "repo", "coding"].map((s) => ({ capabilities: { surfaces: [s] } })) }
			: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});

	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "pags-write-readback", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);

	const tools: WireTool[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : {});
		tools.push(...(page.tools as WireTool[]));
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

describe("every field an MCP writer accepts is reachable by an MCP reader (#574)", () => {
	it("classifies the whole write-tool argument set, and states its size", async () => {
		const published = await listPublishedTools();

		// G1 — the input set is asserted, not assumed. A registration path that silently
		// produced a short list would otherwise make every count below look clean.
		expect(published.length).toBe(MCP_TOOL_COUNT);

		const writers = published.filter((t) => t.annotations?.readOnlyHint !== true);

		const unclassified: string[] = [];
		const unreadable: string[] = [];
		const readable: string[] = [];
		const control: string[] = [];
		let argCount = 0;

		for (const t of writers) {
			for (const arg of Object.keys(t.inputSchema?.properties ?? {})) {
				argCount++;
				const key = `${t.name}.${arg}`;
				if (CONTROL_ARGS.has(arg)) {
					control.push(key);
					continue;
				}
				if (!(key in READBACK)) {
					unclassified.push(key);
					continue;
				}
				(READBACK[key] === null ? unreadable : readable).push(key);
			}
		}

		// G3 — a thing the classifier could not place is REPORTED, never skipped. This is the arm
		// that fires when a new write argument ships: it names the argument and stops.
		expect(
			unclassified,
			`${unclassified.length} write-tool argument(s) are neither control nor declared in READBACK. ` +
				"Add each to CONTROL_ARGS (not persisted content) or to READBACK (naming the MCP reader " +
				"that returns it, or null if nothing does):\n" +
				unclassified.map((k) => `  "${k}": "<reader tool>" | null,`).join("\n"),
		).toEqual([]);

		// Sanity on the denominator itself: these numbers are the point of the file, so a
		// collapse to zero must fail rather than read as a clean surface.
		expect(writers.length).toBeGreaterThan(50);
		expect(argCount).toBeGreaterThan(300);

		// G2 — the denominator is stated in the passing output.
		console.log(
			`✓ write→read reachability: ${published.length} published tools, ${writers.length} writers, ` +
				`${argCount} arguments examined — ${control.length} control, ${readable.length} readable, ` +
				`${unreadable.length} written-but-unreadable (${unreadable.join(", ") || "none"})`,
		);
	});

	it("every declared reader is a tool that exists and actually only reads", async () => {
		// Without this, the table decays into prose: a reader could be renamed or removed and the
		// entries pointing at it would keep passing. It also catches the subtler error of naming a
		// WRITE tool as the readback path.
		const published = await listPublishedTools();
		const byName = new Map(published.map((t) => [t.name, t]));

		const declared = [...new Set(Object.values(READBACK).filter((v): v is string => v !== null))];
		expect(declared.length).toBeGreaterThan(20);

		const missing = declared.filter((n) => !byName.has(n));
		expect(missing, `READBACK names ${missing.length} reader(s) that no longer exist: ${missing.join(", ")}`).toEqual([]);

		const notReadOnly = declared.filter((n) => byName.get(n)?.annotations?.readOnlyHint !== true);
		expect(
			notReadOnly,
			`READBACK names ${notReadOnly.length} tool(s) that are not read-only, so they cannot be the read path: ${notReadOnly.join(", ")}`,
		).toEqual([]);

		console.log(`✓ readback targets: ${declared.length} distinct reader tools named, all published and all read-only`);
	});

	it("a ticket's reasoning is declared readable, by instance_board (#574)", () => {
		// AC4 — the specific regression. If someone drops `reasoning` from `groupBoard` again, the
		// honest thing is for this table to go back to `null`, and this arm is what stops that
		// happening quietly.
		expect(READBACK["create_instance_ticket.reasoning"]).toBe("instance_board");
	});
});
