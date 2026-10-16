/**
 * The generated half of an instance's operator manual (#1109) — every tool this instance may run,
 * and how to operate it, rendered from the same rows `list_instance_tools` returns.
 *
 * ── Why it is the manual's `context`, and never stored
 *
 * #739 made the operator manual an OWNER-written document and reserved `context` for live facts
 * rendered on read ("Slice 3", left unbuilt). This fills that slot. The owner's `manual` is returned
 * byte-for-byte; nothing here is written anywhere (#739 Decision 4: a generated fact frozen into
 * storage describes an instance that no longer exists). Call it again and it says what is true now.
 *
 * ── Why from the policy rows
 *
 * The tool list is `instanceToolPolicy` + `projectToolListing({allowedOnly, schemas})` — the same two
 * calls `GET /v1/instances/:id/tools` and the connection guide (#772) make. A list built any other
 * way is a second answer to "what may this instance run", and the second answer is the one that drifts.
 *
 * ── Callable vs chat-only
 *
 * Only a row whose `invocableBy` includes `call_instance_tool` gets a `call_instance_tool` example.
 * A chat-only tool is named, with its purpose and arguments, as reachable through
 * `chat_with_instance` only — telling a caller to invoke it directly is the call that always fails.
 *
 * ── Size
 *
 * One compact entry per tool (purpose cut to its first sentence, one-line JSON example), so a real
 * coding instance (~37 tools) is ~13k characters and an agent declaring every tool stays inside
 * {@link OPERATOR_GUIDANCE_MAX_CHARS}. A test holds the whole catalogue to it.
 */
import { clipMarked } from "./clip-marked.js";
import { type GuideToolRow, placeholderFor, schemaShape } from "./connection-guide.js";

export interface OperatorGuidanceInput {
	instanceId: string;
	/** The agent's console surfaces — they decide which procedures apply (coding queue, applications). */
	surfaces: readonly string[];
	runtime: string | null;
	/** ALLOWED rows only, schemas included — `projectToolListing(policy, { allowedOnly: true, schemas: true })`. */
	tools: readonly GuideToolRow[];
}

/** The ceiling on the generated text. An agent declaring the whole catalogue fits under it (tested). */
export const OPERATOR_GUIDANCE_MAX_CHARS = 45_000;
/** A tool's purpose: its description's first sentence, at most this long. */
export const PURPOSE_MAX_CHARS = 200;

const MCP_INVOCATION = "call_instance_tool";

/** The first sentence of a description, bounded and marked when cut. Never invented: no description reads as such. */
export function toolPurpose(description: string | undefined): string {
	const text = (description ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "(no description declared)";
	const m = text.match(/^.+?[.!?](?=\s|$)/);
	return clipMarked(m ? m[0] : text, PURPOSE_MAX_CHARS, { within: true });
}

const typeOf = (spec: unknown): string => {
	const t = typeof spec === "object" && spec !== null ? (spec as { type?: unknown }).type : undefined;
	return typeof t === "string" ? t : Array.isArray(t) ? t.filter((x) => typeof x === "string").join("|") : "any";
};

/** Every argument with its type, required ones first and marked. */
export function toolArgs(tool: GuideToolRow): string {
	const { properties, required } = schemaShape(tool.jsonSchema);
	const names = Object.keys(properties);
	if (!names.length) return "none — send `{}`";
	const ordered = [...required.filter((n) => names.includes(n)), ...names.filter((n) => !required.includes(n))];
	return ordered.map((n) => `\`${n}\` ${typeOf(properties[n])}${required.includes(n) ? " (required)" : ""}`).join(", ");
}

/** One-line, pasteable `call_instance_tool` arguments for a callable tool — required fields, placeholder values. */
export function compactCallExample(instanceId: string, tool: GuideToolRow): string {
	const { properties, required } = schemaShape(tool.jsonSchema);
	const input: Record<string, unknown> = {};
	for (const key of required) input[key] = placeholderFor(key, properties[key]);
	return JSON.stringify({ instance_id: instanceId, tool: tool.name, input });
}

const isCallable = (t: GuideToolRow) => (t.invocableBy ?? []).includes(MCP_INVOCATION);

function toolEntry(instanceId: string, t: GuideToolRow): string[] {
	const effect = t.mutates ? "**changes something**" : "read-only";
	const consent = t.writeConsent === "required" || t.writeConsent === "per_call" ? `, write consent ${t.writeConsent}` : "";
	const reach = isCallable(t) ? `\`call_instance_tool\`${(t.invocableBy ?? []).includes("chat") ? " or chat" : ""}` : "chat only — ask the agent with `chat_with_instance`; NOT directly callable";
	const lines = [`- \`${t.name}\` — ${toolPurpose(t.description)}`, `  Args: ${toolArgs(t)}. ${effect}${consent}. Reach: ${reach}.`];
	if (isCallable(t)) lines.push(`  Call: \`call_instance_tool\` \`${compactCallExample(instanceId, t)}\``);
	return lines;
}

/** The procedures section — what to call, in what order — chosen by what this agent actually has. */
function procedures(input: OperatorGuidanceInput, callable: number): string[] {
	const out = [
		"### Procedures",
		"",
		`1. **Discover.** \`list_instance_tools\` with \`{"instance_id":"${input.instanceId}","allowed_only":true,"schemas":true}\` is the authority; this reference is rendered from it on every read.`,
		callable
			? '2. **Call a nested tool.** `call_instance_tool` with `instance_id`, `tool` and `input` — `input` is the tool\'s OWN argument object: do not wrap it again or rename its fields. Angle-bracketed values are placeholders.'
			: "2. **No nested tool is callable here.** Every tool below runs inside the agent's own conversation.",
		"3. **Chat-only tools** run inside the conversation: ask for them with `chat_with_instance`. `call_instance_tool` refuses them.",
	];
	let n = 4;
	if (input.surfaces.includes("coding")) {
		out.push(
			`${n++}. **Give it work (coding).** \`coding_loop_start\` with an objective — it runs at once, or joins the objective queue when the instance is busy. \`coding_loop_queue\` lists the queue; \`coding_loop_queue_reorder\` and \`coding_loop_queue_cancel\` change it; \`coding_loop_status\` is the live run; \`coding_loop_stop\` stops it (cooperatively); \`coding_loop_lifecycle\` is one objective's history.`,
			`${n++}. **See what it did (coding).** \`coding_loop_trace\` for a run's steps, \`coding_sessions_list\` and \`coding_timeline\` for its sessions and conversation, \`coder_questions\` for questions it is waiting on.`,
		);
	}
	// The Applications queue belongs to a RUNTIME, as the console decides it (#958): the Tailor and the Runner.
	if (input.runtime === "local_artifact" || input.runtime === "local_apply") {
		out.push(`${n++}. **Applications.** \`list_applications\` is the queue, \`application_trace\` one application's ordered history (paged), \`application_run\` / \`application_runs\` the Runner's fills.`);
	}
	out.push(
		`${n++}. **Status and history.** \`instance_board\` lists the cards; \`task_action_log\` is one card's ordered steps (poll with its \`tail\`); \`agent_trace\` is the run timeline; \`list_errors\` the failures. A started run reports back — do not claim it finished until one of these says so.`,
		"",
		"**Pitfalls.** A tool marked **changes something** is not safe to retry blindly — read status first. A write-consent gate refuses until the owner grants it. Copy ids exactly as returned.",
	);
	if (input.runtime) out.push(`Tools that reach the machine need \`pags up\` running there (runtime \`${input.runtime}\`); they fail while no runner is connected.`);
	return out;
}

/** Render the generated guidance. Pure: same input, same text; writes nothing. */
export function buildOperatorGuidance(input: OperatorGuidanceInput): string {
	const callable = input.tools.filter(isCallable);
	const chatOnly = input.tools.filter((t) => !isCallable(t));
	const out: string[] = [
		"## Operating this instance (generated)",
		"",
		"Rendered by ProAgentStore from this instance's allowed tools on every read — never stored, so it cannot go stale. The owner's own notes are the separate `manual` field.",
		"",
		...procedures(input, callable.length),
		"",
		`### Tools this instance may run (${input.tools.length}: ${callable.length} callable via \`call_instance_tool\`, ${chatOnly.length} chat-only)`,
		"",
	];
	if (!input.tools.length) out.push("_None. This instance has no tools enabled._");
	for (const t of [...callable, ...chatOnly]) out.push(...toolEntry(input.instanceId, t));
	const text = out.join("\n").trimEnd();
	return text.length <= OPERATOR_GUIDANCE_MAX_CHARS ? text : clipMarked(text, OPERATOR_GUIDANCE_MAX_CHARS, { within: true, what: "characters (call list_instance_tools for the rest)" });
}
