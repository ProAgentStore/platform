/**
 * The per-instance connection guide (#772) — the exact contract for driving ONE instance over
 * MCP, rendered as pasteable Markdown.
 *
 * ── What it is for
 *
 * A caller that already knows which instance it is targeting still has to discover, by trial and
 * error, which tools that instance exposes and what fields each one takes. The issue was filed
 * from a session that did exactly that: it guessed tool names and then guessed FIELD names before
 * landing on the right call shape. `list_instance_tools` answers both questions and
 * `call_instance_tool` states the envelope, but the answer arrives as ~54 KB of JSON that a caller
 * has to read before it can act. This renders the same facts as the short briefing a human (or
 * another assistant's system prompt) can hold.
 *
 * ── Everything here is rendered, nothing is stored
 *
 * The rule #739 Decision 4 settled for the operator manual applies with more force to a document
 * that is entirely derived: a generated fact frozen into storage goes stale inside PAGS exactly as
 * it goes stale inside a Claude project, and the guide would then describe an instance that no
 * longer exists. So this module is a PURE function over inputs the route has already fetched, it
 * writes nothing, and there is deliberately no cache, no `generatedFrom` provenance and no
 * regenerate action. Call it again and it tells you what is true now.
 *
 * ── Why it renders from the policy rows rather than from the registry
 *
 * The tool list must come from `instanceToolPolicy` + `projectToolListing` — the same two calls
 * `GET /v1/instances/:id/tools` makes (`routes/tools.ts:145`). A guide that enumerated the
 * registry itself would be a SECOND answer to "what may this instance run", and the second answer
 * is the one that drifts. `routes/tools.ts:66` records the same finding from the other direction:
 * "The gate is the LISTING, not the registry (#525)".
 *
 * ── Why placeholders are angle-bracketed
 *
 * The worked example has to be valid JSON a caller can paste AND has to be obviously not a real
 * value. `"<repo>"` is both: it parses, and nobody sends it by accident. Inventing a plausible
 * value instead (`"owner/name"`) would be the platform fabricating an argument, which is the
 * failure mode this codebase fences everywhere else.
 */

/**
 * The body `GET /v1/instances/:id/connection-guide` returns.
 *
 * Named rather than inlined at the two call sites because #616/#617 measured what an anonymous
 * `api<{ guide: string }>` costs: 90 console response shapes hand-copied from the worker, 15 of
 * them already disagreeing with their producer and none of the disagreements visible at runtime.
 * A name is what lets `store/console/src/lib/types.test.ts` compare the two declarations.
 */
export interface ConnectionGuideResponse {
	/** The rendered Markdown document. Always a string — an instance with nothing to say still
	 *  gets its identity section, so this is never null and never absent. */
	guide: string;
}

/** A tool row as this renderer reads one — the fields of `ToolPolicyEntry` it actually uses. */
export interface GuideToolRow {
	name: string;
	description?: string;
	/** Present only for allowed rows the caller asked schemas for (`projectToolListing`). */
	jsonSchema?: unknown;
	/** The surfaces that can reach it. Only `call_instance_tool` rows are callable from MCP. */
	invocableBy?: readonly string[];
	tier?: string;
	connector?: string;
	mutates?: boolean;
	writeConsent?: string;
}

/** A repo row as this renderer reads one. */
export interface GuideRepoRow {
	name: string;
	githubRepo?: string;
	workdir?: string;
}

/**
 * Everything the guide is rendered FROM. The route fetches all of it; this module reaches for
 * nothing itself, which is what makes the whole document unit-testable without a database.
 */
export interface ConnectionGuideInput {
	instanceId: string;
	/** The instance's display name, or the agent's name when it has none. */
	instanceName: string;
	agentSlug: string;
	surfaces: readonly string[];
	runtime: string | null;
	/** ALLOWED rows only, schemas included — see `projectToolListing({allowedOnly, schemas})`. */
	tools: readonly GuideToolRow[];
	repos: readonly GuideRepoRow[];
	/** The owner's hand-written operator manual (#739), verbatim. May be "". */
	manual: string;
	/** The agent's standing orders (`config.specialInstructions`). May be "". */
	rules: string;
}

/**
 * A ceiling on the whole document, in characters.
 *
 * `list_instance_tools` overflows a calling host's 64 KiB response limit on real instances —
 * measured at 61,796–66,189 B across 34 instances, with 20 over the limit
 * (`workers/mcp/src/instance-tools/base.ts:52-98`). This guide is far smaller by construction
 * because it renders one LINE per tool rather than a schema, but "far smaller by construction"
 * is exactly the kind of claim that stops being true when a catalogue grows. The cap is named,
 * exported and tested so the failure is a visible truncation notice rather than a host silently
 * dropping the response.
 */
export const CONNECTION_GUIDE_MAX_CHARS = 24_000;

/** What a truncated guide ends with, so a reader knows the document is short rather than complete. */
export const GUIDE_TRUNCATION_NOTICE =
	"\n\n---\n\n_(This guide was truncated at its size limit. Call `list_instance_tools` for the complete tool set.)_";

/** The invocation surface that `call_instance_tool` can actually reach (`ToolPolicyEntry.invocableBy`). */
const MCP_INVOCATION = "call_instance_tool";

/**
 * A JSON value that stands in for an argument, derived from the schema's declared type.
 *
 * Never guesses a plausible value — see the module note. The field NAME goes inside the
 * placeholder because that is the thing the caller was guessing wrong.
 */
function placeholderFor(name: string, spec: unknown): unknown {
	const type = typeof spec === "object" && spec !== null ? (spec as { type?: unknown }).type : undefined;
	switch (type) {
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		case "array":
			return [];
		case "object":
			return {};
		default:
			// Strings and anything undeclared. A schema with no `type` is common enough that
			// refusing to render it would drop real tools from the example.
			return `<${name}>`;
	}
}

/** The `{properties, required}` pair, when the schema declares them. Never throws. */
function schemaShape(schema: unknown): { properties: Record<string, unknown>; required: string[] } {
	if (typeof schema !== "object" || schema === null) return { properties: {}, required: [] };
	const s = schema as { properties?: unknown; required?: unknown };
	const properties =
		typeof s.properties === "object" && s.properties !== null ? (s.properties as Record<string, unknown>) : {};
	const required = Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === "string") : [];
	return { properties, required };
}

/**
 * One tool's field list: exactly the names the caller must send, and exactly the ones it may.
 *
 * This is the half of #772 that fixes guessed FIELD names, and it is why the guide lists names
 * rather than embedding the schema — a name list is ~40 bytes where a schema is ~350, and the
 * caller was never missing the types.
 */
export function describeToolFields(tool: GuideToolRow): string {
	const { properties, required } = schemaShape(tool.jsonSchema);
	const all = Object.keys(properties);
	if (all.length === 0) {
		// A tool with no declared inputs takes `{}`. Saying so is worth a line: the alternative is
		// a caller inventing an argument for a tool that accepts none.
		return "takes no arguments — send `{}`";
	}
	const optional = all.filter((k) => !required.includes(k));
	const parts: string[] = [];
	if (required.length > 0) parts.push(`required: ${required.map((k) => `\`${k}\``).join(", ")}`);
	if (optional.length > 0) parts.push(`optional: ${optional.map((k) => `\`${k}\``).join(", ")}`);
	return parts.join(" · ");
}

/**
 * A complete, pasteable `call_instance_tool` invocation for one tool.
 *
 * Required fields only. An example carrying every optional argument reads as though they are all
 * expected, which trades one guessing problem for another.
 */
export function renderCallExample(instanceId: string, tool: GuideToolRow): string {
	const { properties, required } = schemaShape(tool.jsonSchema);
	const args: Record<string, unknown> = {};
	for (const key of required) args[key] = placeholderFor(key, properties[key]);
	const payload = {
		instance_id: instanceId,
		tool: tool.name,
		input: args,
	};
	return `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

/** Trim, and treat a whitespace-only field as unset — a cleared textarea stores "\n", not "". */
function present(value: string | null | undefined): string {
	return (value ?? "").trim();
}

/**
 * Render the guide.
 *
 * Sections are emitted in the order a caller needs them: what this is, how to address it, what it
 * can do, what it is attached to, and only then the owner's prose. A caller that reads the first
 * two sections and stops can already make a correct call, which is the whole point of the ticket.
 */
export function buildConnectionGuide(input: ConnectionGuideInput): string {
	const out: string[] = [];

	out.push(`# Connection guide — ${input.instanceName}`);
	out.push("");
	out.push(
		"Generated by ProAgentStore for this one agent instance. It is a snapshot of live state: " +
			"re-fetch it rather than storing it, because everything below can change.",
	);
	out.push("");

	// ── Identity ─────────────────────────────────────────────────────────────────────────────
	out.push("## What you are talking to");
	out.push("");
	out.push(`- **Instance id:** \`${input.instanceId}\` — pass this as \`instance_id\` on every call.`);
	out.push(`- **Agent type:** \`${input.agentSlug}\``);
	out.push(`- **Console surfaces:** ${input.surfaces.length > 0 ? input.surfaces.map((s) => `\`${s}\``).join(", ") : "none"}`);
	// The runtime answer is load-bearing rather than trivia: an agent with `runtime: null` is
	// cloud-only, and telling a caller to run `pags up` for one is a wrong instruction that costs
	// a whole debugging session.
	out.push(
		input.runtime
			? `- **Local runtime:** \`${input.runtime}\` — this agent needs a machine running \`pags up\`. Tools that reach it fail while no runner is connected.`
			: "- **Local runtime:** none. This agent runs entirely on the platform; there is no `pags up` to start.",
	);
	out.push("");

	// ── The envelope ─────────────────────────────────────────────────────────────────────────
	const callable = input.tools.filter((t) => (t.invocableBy ?? []).includes(MCP_INVOCATION));
	const chatOnly = input.tools.filter((t) => !(t.invocableBy ?? []).includes(MCP_INVOCATION));

	out.push("## How to call it");
	out.push("");
	if (callable.length === 0) {
		// Not a degraded guide — a real and common shape. A chat/RAG agent exposes no tool that
		// `call_instance_tool` can reach, and a caller told to keep hunting for one would hunt
		// forever.
		out.push(
			"This instance exposes **no tool reachable through `call_instance_tool`**. Talk to it with " +
				"`chat_with_instance`; its own tools run inside that conversation.",
		);
	} else {
		out.push(
			"Invoke a tool with `call_instance_tool`. `input` is the nested tool's own argument object — " +
				"do **not** wrap it again, and do not rename its fields. Angle-bracketed values below are " +
				"placeholders to replace.",
		);
		out.push("");
		out.push(renderCallExample(input.instanceId, callable[0]));
	}
	out.push("");

	// ── The tools ────────────────────────────────────────────────────────────────────────────
	out.push("## Tools this instance actually exposes");
	out.push("");
	if (input.tools.length === 0) {
		out.push("_None. This instance has no tools enabled._");
	} else {
		if (callable.length > 0) {
			out.push(`### Callable via \`call_instance_tool\` (${callable.length})`);
			out.push("");
			for (const tool of callable) {
				// `mutates`, not `scope` — the two were one field for a while and it made the listing
				// wrong (#563). A caller deciding whether a call is safe to retry needs the former.
				const marks: string[] = [];
				if (tool.mutates) marks.push("**writes**");
				if (tool.writeConsent === "required" || tool.writeConsent === "per_call") {
					marks.push(`consent: ${tool.writeConsent}`);
				}
				const suffix = marks.length > 0 ? ` — ${marks.join(", ")}` : "";
				out.push(`- \`${tool.name}\` — ${describeToolFields(tool)}${suffix}`);
			}
			out.push("");
		}
		if (chatOnly.length > 0) {
			out.push(`### Chat-only (${chatOnly.length})`);
			out.push("");
			out.push(
				"The agent runs these inside `chat_with_instance`. `call_instance_tool` **cannot** reach them — " +
					"asking it to is the call that returns an error.",
			);
			out.push("");
			out.push(chatOnly.map((t) => `\`${t.name}\``).join(", "));
			out.push("");
		}
	}

	// ── Attachments ──────────────────────────────────────────────────────────────────────────
	if (input.repos.length > 0) {
		out.push("## Repositories attached");
		out.push("");
		for (const repo of input.repos) {
			const coordinate = repo.githubRepo
				? `\`${repo.githubRepo}\``
				: repo.workdir
					? `local checkout at \`${repo.workdir}\``
					: "no coordinate recorded";
			out.push(`- **${repo.name}** — ${coordinate}`);
		}
		out.push("");
	}

	// ── The owner's own prose ────────────────────────────────────────────────────────────────
	const manual = present(input.manual);
	if (manual) {
		out.push("## Operating notes from the owner");
		out.push("");
		out.push(manual);
		out.push("");
	}

	const rules = present(input.rules);
	if (rules) {
		out.push("## The agent's standing orders");
		out.push("");
		// Echoed for the reason #739 Decision 2 gives: a caller reading the guide should see, in the
		// same document, the rules that will make the agent refuse things — otherwise a refusal
		// reads as a malfunction. Labelled as the AGENT's so it is not mistaken for instructions to
		// the caller, which is the exact confusion #739 was filed about.
		out.push("These are instructions to the **agent**, not to you. They are why it may decline something you ask for.");
		out.push("");
		out.push(rules);
		out.push("");
	}

	const guide = out.join("\n").trimEnd();
	if (guide.length <= CONNECTION_GUIDE_MAX_CHARS) return guide;
	return guide.slice(0, CONNECTION_GUIDE_MAX_CHARS - GUIDE_TRUNCATION_NOTICE.length) + GUIDE_TRUNCATION_NOTICE;
}
