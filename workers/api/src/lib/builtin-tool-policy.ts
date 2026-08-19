// The agent's BUILT-IN tools, as rows of the same policy listing the connector tools appear in (#525).
//
// ── The claim that was false
//
// `list_instance_tools` told an operator, verbatim: *"Use this to verify an agent is read-only
// before trusting it with sensitive data — a tool absent from the allowed set cannot be invoked, by
// chat or by call_instance_tool."* True for `call_instance_tool`, which dispatches through
// `getRegistryTool` and 404s anything else. False for chat, which resolves its tools from
// `toolNamesFor` — and `toolNamesFor` seeds `BASE` unconditionally.
//
// Measured on one production instance: the listing returned 70 tools and **11 of the 19 BASE names
// were absent from it**, six of them writes. Two of the absent eleven were observed running on that
// same instance inside the audit window — `fetch_url` at 21:45 and `write_memory` at 03:22 the next
// morning. An auditor who did exactly what the description says would have concluded the agent
// could not write to its own memory nineteen hours before it did.
//
// ── Why the listing was partial
//
// `resolveToolPolicy` maps over whatever tool list it is handed, and every caller handed it
// `registryTools()`. The DO's own catalog — `AGENT_TOOLS` (lib/tools.ts) and `STORAGE_TOOLS`
// (lib/storage-tools.ts) — is a different collection, dispatched by a different executor, and was
// never walked. That is the whole of it: `start_work` and `get_behaviour` appeared because they
// happen to be registry tools, while `write_memory` and `fetch_url` did not because they are not.
//
// This module supplies the missing rows so the listing is exhaustive and the sentence can be true.
// The alternative — narrowing the claim to "registry tools only" — was rejected in the issue and
// here for the same reason: the auditor's question is "what can this thing reach", and arbitrary
// outbound HTTP is squarely inside it.
//
// ── What is derived, and what is declared
//
// Name, description and schema are DERIVED from the same definition arrays `buildAgentToolDefinitions`
// hands the model, through the same `legacyToolSchema` converter — so a row here and the schema the
// model is shown cannot describe different tools.
//
// `scope` cannot be derived: nothing in a `ToolDef` says whether the handler mutates. It is declared
// below, once, and `builtin-tool-policy.test.ts` fails when a definition exists with no entry — so a
// new built-in tool forces the read/write decision instead of defaulting into the listing as
// harmless. `scopeOfBuiltin` also fails CLOSED (`write`) for a name it does not know, because the
// direction of a wrong guess matters: over-reporting a read as a write costs an auditor a question,
// under-reporting a write as a read is the bug this file exists to close.
import { AGENT_TOOLS, legacyToolSchema, type ToolDef } from "./tools.js";
import { STORAGE_TOOLS } from "./storage-tools.js";
import { TOOL_CATALOG } from "../agent-do-tools.js";
import { registryToolNameSet } from "./tool-registry.js";

/**
 * The catalog group a tool belongs to — the same vocabulary `ToolCatalogGroup.tier` uses.
 *
 * A LIST first and a type second (#569), because the vocabulary has to be readable at RUNTIME.
 * `list_instance_tools` documented two of these four values while returning all four: 34 of 104
 * rows on the audited instance carried a tier the description did not define, including every
 * `runtime` tool — the set that reaches the owner's own machine. The guard that stops that
 * recurring has to iterate the real vocabulary, and a TS union cannot be iterated; a hand-copied
 * list in the test would be the same defect one layer over.
 */
export const TOOL_TIERS = ["base", "standard", "runtime", "connector"] as const;

/** base = always granted · standard = creator-selectable · runtime = needs a local runner · connector = external system. */
export type ToolTier = (typeof TOOL_TIERS)[number];

/**
 * Which invocation surface can actually REACH a tool.
 *
 * The distinction the old description flattened. Every allowed tool runs in the agent's own chat
 * loop; only a REGISTRY tool can additionally be invoked through `POST /v1/instances/:id/tools/:name`
 * and its MCP proxy `call_instance_tool`, because that route dispatches through `getRegistryTool`
 * and has no access to the instance's Durable Object executor. Reported per row rather than
 * explained in prose, so "which surface is covered" is answerable from the data.
 */
export type ToolInvocation = "chat" | "call_instance_tool";

/**
 * Does this built-in tool mutate anything?
 *
 * `read` means the handler cannot change state on its own. `fetch_url` is `read` for exactly the
 * reason `http_request` is (`instance-tool-policy.ts` / #307 / #351): the tool does not choose to
 * write, the CALLER picks the method, and its schema — carried on the same row — shows `method` and
 * `body`. Classifying it differently from the registry tool with the same shape would put two
 * answers to one question in one listing, which is the failure `lib/toolPolicy.ts` records on the
 * console side.
 */
export const BUILTIN_TOOL_SCOPES: Readonly<Record<string, "read" | "write">> = {
	// ── AGENT_TOOLS (lib/tools.ts) — the universal facilities.
	read_memory: "read",
	write_memory: "write",
	delete_memory: "write",
	get_tasks: "read",
	create_task: "write",
	update_task: "write",
	fetch_url: "read",
	configure_board: "write",
	// ── STORAGE_TOOLS (lib/storage-tools.ts).
	// PDF forms (#712). `fill_pdf_form` and `build_answer_sheet` are "write" because each
	// stores a NEW file in the instance; neither modifies the source document.
	inspect_pdf_form: "read",
	fill_pdf_form: "write",
	build_answer_sheet: "write",
	search_knowledge: "read",
	list_knowledge: "read",
	read_knowledge: "read",
	update_knowledge: "write",
	delete_knowledge: "write",
	add_knowledge: "write",
	upload_file: "write",
	list_files: "read",
	read_file: "read",
	delete_file: "write",
	create_collection: "write",
	list_collections: "read",
	insert_record: "write",
	query_records: "read",
	update_record: "write",
	delete_record: "write",
	get_activity: "read",
	get_user_context: "read",
	set_user_preference: "write",
	submit_job_application: "write",
	// Reads the owner's connected Gmail. Granted by the `permissions.email` toggle rather than by
	// declaration, so it is never in `toolNamesFor`'s output and reports `not_declared` here; it is
	// listed anyway because "can this agent read my email" is the auditor's question, and a tool
	// absent from the listing entirely is the thing this file exists to stop.
	find_confirmation_link: "read",
	list_coding_repos: "read",
	read_terminal: "read",
	send_to_cli: "write",
};

/** Is this one of the DO's own tools — i.e. runnable in chat and nowhere else? */
export function isBuiltinTool(name: string): boolean {
	return builtinToolPolicyInputs().some((t) => t.name === name);
}

/**
 * What `POST /v1/instances/:id/tools/:name` should say about a built-in name, or null when the
 * name is not one — in which case the route's own "Unknown tool" is the true answer.
 *
 * A separate sentence because the two facts are different: the listing describes this tool, so it
 * is not unknown; what it cannot do is reach the instance's Durable Object from an HTTP route.
 * Telling a caller "Unknown tool: write_memory" moments after `GET …/tools` returned it is the same
 * kind of confident-and-wrong the listing itself was.
 */
export function builtinToolRouteRefusal(name: string): string | null {
	if (!isBuiltinTool(name)) return null;
	return (
		`"${name}" is one of the agent's built-in tools: it runs in the agent's own chat loop and nowhere else. This route` +
		" (and MCP call_instance_tool) dispatches connector tools — see `invocableBy` on GET /v1/instances/:id/tools."
	);
}

/** The tier of every catalogued tool name, read off `TOOL_CATALOG` rather than restated. */
function tierByName(): Map<string, ToolTier> {
	const map = new Map<string, ToolTier>();
	for (const group of TOOL_CATALOG) for (const name of group.tools) map.set(name, group.tier);
	return map;
}

/**
 * The scope of one built-in tool. Fails closed on an unknown name — see the header.
 */
export function scopeOfBuiltin(name: string): "read" | "write" {
	return BUILTIN_TOOL_SCOPES[name] ?? "write";
}

/**
 * Does the caller pick the HTTP verb for this tool?
 *
 * The one shape where `scope:"read"` and "changes nothing" come apart: `fetch_url` and
 * `http_request` both take `method` as an input, so both are honestly read-SCOPED (the tool does
 * not choose to write) and both can POST. Lives here rather than in `instance-tool-policy.ts`
 * because both the built-in `mutates` derivation below and that module's `perCallGateOf` need the
 * SAME predicate, and this module is the one they can both import without a cycle.
 */
export function callerChoosesMethod(scope: "read" | "write" | undefined, jsonSchema: unknown): boolean {
	if ((scope ?? "read") !== "read") return false;
	const props = (jsonSchema as { properties?: Record<string, unknown> } | null | undefined)?.properties;
	return !!props && props.method !== undefined;
}

/**
 * Does a call to this built-in tool CHANGE anything (#563)?
 *
 * DERIVED from `BUILTIN_TOOL_SCOPES` rather than declared a second time, because on this side of
 * the listing the two questions really do have one answer: a built-in tool has no connector, so
 * nothing here is consent-gated and the table above is already a hand-made "does the handler
 * mutate" judgement — that is exactly what its header says it is. On the REGISTRY side the same
 * word means "does this need external write consent", which is why `ToolDef.mutates` is declared
 * there instead of derived. One field, two provenances, and this comment is the reason.
 *
 * The exception is `fetch_url`, and it is the reason this is a function and not `=== "write"`:
 * it is read-scoped because the CALLER picks the verb, and the header of this file forbids giving
 * it a different answer from `http_request`, the registry tool with the identical shape (which
 * declares `mutates:true` by hand). Deriving it from the schema keeps them equal by construction
 * rather than by memory.
 */
export function mutatesBuiltin(name: string, jsonSchema: unknown): boolean {
	return scopeOfBuiltin(name) === "write" || callerChoosesMethod(scopeOfBuiltin(name), jsonSchema);
}

/** A built-in tool as the policy resolver reads it. Structurally the resolver's `PolicyInput`. */
export interface BuiltinToolPolicyInput {
	name: string;
	scope: "read" | "write";
	/** Does a call change anything? See {@link mutatesBuiltin} for why this one is derived. */
	mutates: boolean;
	description: string;
	jsonSchema: unknown;
	tier: ToolTier;
	invocableBy: readonly ToolInvocation[];
}

/**
 * Every tool the Durable Object's own executors can run, as policy rows.
 *
 * Deduplicated in the SAME order and by the same rule as `buildAgentToolDefinitions`: AGENT_TOOLS
 * then STORAGE_TOOLS, later wins. That matters for `read_file`/`list_files`, which exist in both
 * arrays — the storage engine's versions are what actually run (agent-think checks
 * `storageToolNames` first), so they must be what the listing describes.
 *
 * Registry names are EXCLUDED: `registryToolDefs()` shadows both arrays in the same merge, and the
 * registry row is the one the listing already carries with its connector and consent verdict.
 */
export function builtinToolPolicyInputs(): BuiltinToolPolicyInput[] {
	const tiers = tierByName();
	const registry = registryToolNameSet();
	const byName = new Map<string, ToolDef>();
	for (const def of [...AGENT_TOOLS, ...STORAGE_TOOLS]) {
		if (!registry.has(def.name)) byName.set(def.name, def);
	}
	return [...byName.values()].map((def) => ({
		name: def.name,
		scope: scopeOfBuiltin(def.name),
		mutates: mutatesBuiltin(def.name, legacyToolSchema(def)),
		description: def.description,
		jsonSchema: legacyToolSchema(def),
		// A name outside every catalog group is `standard`: not universal (so not `base`), backed by
		// no external system (so not `connector`) and needing no local runner (so not `runtime`).
		// Today that is the legacy `submit_job_application` and the permission-gated
		// `find_confirmation_link`.
		tier: tiers.get(def.name) ?? "standard",
		// Chat only. There is no executor for these behind `POST /v1/instances/:id/tools/:name` —
		// that route reaches the registry, and the DO's tools run inside the DO.
		invocableBy: ["chat"] as const,
	}));
}
