// Instance tool policy — the ONE answer to "what may this instance actually run?".
//
// Before this, `capabilities.tools` bounded the CHAT and nothing else. The generic invoker
// (`POST /v1/instances/:id/tools/:name`, and MCP `call_instance_tool` which proxies it)
// checked only that the caller owned the instance, then dispatched ANY tool in the registry.
// So a read-only agent was read-only in conversation while its instance could still be driven
// to `tmux_capture_pane` the owner's terminals or `sheets_read` their spreadsheets. "This agent
// is read-only" has to be a property of the INSTANCE, not of one surface's prompt-building.
//
// Two independent gates, both fail-closed, evaluated here so every surface shares them:
//
//   1. DECLARED — the agent's `capabilities.tools` allowlist (creator-side). A tool the agent
//      never declared is not part of it, no matter who asks.
//   2. DISABLED — the owner's per-instance off-switch (`config.disabledTools`). The subscriber's
//      veto over what their own copy may do, independent of what the creator declared.
//
// Write-consent (#90) is a THIRD, separate gate enforced in runRegistryTool. It is deliberately
// not merged here: consent answers "may this act on an external system as me", while this
// answers "is this tool part of this agent at all". A tool can be allowed here and still be
// refused there.
//
// It is REPORTED here, though, in its own field (#351). Not reporting it made the listing
// confidently wrong in the permissive direction: four `terminal_*` write tools read
// `allowed:true, reason:"ok"` on an instance that had never been granted `terminal` write, so the
// agent's only way to learn otherwise was to make a failed side-effecting call. Merging the gates
// would have been the wrong fix — "is this tool part of this agent" has to stay answerable while
// consent is off — so `allowed`/`reason` keep their exact meanings and `writeConsent` says
// separately what the consent machinery will do to the same tool.
import { agentCapabilities, type AgentCapabilities } from "./agent-capabilities.js";
import { toolNamesFor } from "../agent-do-tools.js";
import { builtinToolPolicyInputs, callerChoosesMethod, type ToolInvocation, type ToolTier } from "./builtin-tool-policy.js";
import { registryTools } from "./tool-registry.js";
import { reachOf, type ToolReach } from "./tool-reach.js";
import { listConsents } from "./connector-consent.js";
import type { Env } from "../types.js";
// The reason vocabulary + its wording moved to a LEAF (#381) so a pipeline step can refuse with
// the same sentence without importing the catalog/registry/consent graph this module needs.
// Re-exported here, its original home, so every existing import keeps working.
import { explainRefusal, type ToolPolicyReason } from "./tool-refusal.js";

export { explainRefusal, type ToolPolicyReason };

/**
 * What the write-consent machinery (#90 and the gates layered on it) will do to this tool, as
 * this instance is configured right now. Reported alongside `allowed`, never folded into it.
 *
 *   n/a       — no write gate can apply: nothing to grant, nothing to be refused by.
 *   granted   — a gate applies and is satisfied; no consent check will refuse this tool.
 *   required  — a gate applies and is NOT satisfied: every call is refused until the owner
 *               grants write on this tool's `connector`.
 *   per_call  — the answer is decided per call, not per tool. Two ways that happens today:
 *               a caller-chosen HTTP method (`http_request`, #307 — reads run, a mutating verb
 *               is refused), and outbound MCP (#262 — the connector row is only the outer gate;
 *               each call also needs a grant for that (endpoint, tool)).
 */
export type ToolWriteConsent = "n/a" | "granted" | "required" | "per_call";

export interface ToolPolicyEntry {
	name: string;
	connector?: string;
	/**
	 * Whether the #90 write-consent gate applies — NOT whether the tool changes anything. Read
	 * {@link ToolPolicyEntry.mutates} for that; the two are separate fields because they were one
	 * for a while and it made this listing wrong (#563).
	 */
	scope: "read" | "write";
	/**
	 * Does a call to this tool CHANGE anything — the external system, the owner's machine, or this
	 * instance's own stored data? The auditor's field.
	 *
	 * It is not `scope`, and it is not derivable from it. Nine tools — `start_work`, `stop_work`,
	 * `end_coding_session`, `set_behaviour`, `set_stats_card`, `run_pipeline`, `create_ticket`,
	 * `record_feedback`, `dedupe_upsert` — are `scope:"read"` because they have no connector to
	 * consent to, and every one of them changes something. Measured on a production instance
	 * (bd43f4de-…, 104 rows) and reported as read.
	 *
	 * Declared per tool on the registry side (`ToolDef.mutates`, a REQUIRED field, so the compiler
	 * asks) and derived from `BUILTIN_TOOL_SCOPES` on the built-in side, where the table already IS
	 * that judgement. `mutation-report.test.ts` pins the whole set with its denominator.
	 */
	mutates: boolean;
	description: string;
	/**
	 * The tool's input schema — present only when the caller asked for schemas AND the row is
	 * `allowed` (#569). See {@link projectToolListing} for the budget this pays for.
	 */
	jsonSchema?: unknown;
	/** The final answer: may this instance run this tool right now? */
	allowed: boolean;
	/** True when the agent declares it but the owner switched it off. */
	disabled: boolean;
	reason: ToolPolicyReason;
	/** The SEPARATE write-consent verdict (#351). Never folded into `allowed`. */
	writeConsent: ToolWriteConsent;
	/** Which catalog group it comes from — `base` is universal, `connector` reaches another system. */
	tier: ToolTier;
	/**
	 * The surfaces that can actually reach this tool (#525).
	 *
	 * Every tool here runs in the agent's own chat loop. Only a REGISTRY tool additionally answers
	 * to `POST /v1/instances/:id/tools/:name` and its MCP proxy `call_instance_tool`, because that
	 * route dispatches through `getRegistryTool` and cannot reach the DO's own executors. Stated
	 * per row because the description that flattened the two claimed a guarantee for chat that only
	 * held for the invoker.
	 */
	invocableBy: readonly ToolInvocation[];
	/**
	 * Where a call to this tool LANDS: `platform` | `machine` | `internet` (#584).
	 *
	 * The third axis of the same row, and the reason it is a field rather than something a reader
	 * works out: the console worked it out, from "does the tool name a connector", and told ten of
	 * this account's instances they had "no tool that reaches outside the platform" while
	 * `fetch_url` was switched on. `connector` cannot answer it in either direction — `fetch_url`
	 * has none and reaches the internet, every `supervision` tool has one and never leaves — and
	 * neither can `tier`, `scope` or `mutates`. See `tool-reach.ts` for the boundary rules.
	 */
	reach: ToolReach;
}

/** A tool as this module reads it — the fields of `ToolDef` the two verdicts are computed from. */
export type PolicyInput = {
	name: string;
	connector?: string;
	scope?: "read" | "write";
	/**
	 * Optional HERE and required on `ToolDef`, with the OPPOSITE default to `scope`: an omitted
	 * `mutates` resolves to `true`.
	 *
	 * Both directions are deliberate. `scope` defaults to `"read"` because it drives a gate, and
	 * the gate's honest answer for a tool that declared nothing is "no consent applies"; guessing
	 * `"write"` there would refuse a working tool. `mutates` drives nothing — it is reported — so
	 * the cost of a wrong guess is asymmetric in the other direction, and it takes the same fail
	 * direction `scopeOfBuiltin` takes for the same reason. Unreachable in production: every
	 * registry tool is compelled to declare it and every built-in row derives one.
	 */
	mutates?: boolean;
	description: string;
	jsonSchema: unknown;
	tier?: ToolTier;
	invocableBy?: readonly ToolInvocation[];
};

/**
 * Does a further gate decide this tool call-by-call, after (or instead of) the connector-level
 * consent row? Derived from the tool's own declaration so a new tool is classified by what it
 * IS, not by appearing on a list someone remembered to update.
 *
 *   method   — the caller picks the HTTP verb, so the tool is scope:"read" and honest about it;
 *              `executeHttpRequest` asks for write consent on the RESOLVED method (#307). Same
 *              derivation `security-invariants.test.ts` uses to find these.
 *   endpoint — outbound MCP names its remote system at call time, so `mcp` write consent cannot
 *              name it; reach is granted per (endpoint, tool) in `instance_mcp_consent` (#262).
 */
function perCallGateOf(t: PolicyInput): "method" | "endpoint" | null {
	const scope = t.scope ?? "read";
	// The predicate moved to builtin-tool-policy.ts so the built-in `mutates` derivation can use the
	// SAME one (#563) — `fetch_url` and `http_request` have to give one answer, and two copies of
	// "does the schema take a method" is how they would eventually stop.
	if (callerChoosesMethod(scope, t.jsonSchema)) return "method";
	if (scope === "write" && t.connector === "mcp") return "endpoint";
	return null;
}

/** The write-consent verdict for one tool, given the connectors this instance has granted. */
export function writeConsentOf(t: PolicyInput, granted: ReadonlySet<string>): ToolWriteConsent {
	// No connector → nothing to consent to. `runRegistryTool` refuses a connector-less write tool
	// outright, and that is a defect in the tool, not a consent state the owner can act on.
	if (!t.connector) return "n/a";
	const has = granted.has(t.connector);
	const gate = perCallGateOf(t);
	if ((t.scope ?? "read") === "write") {
		if (!has) return "required";
		return gate === "endpoint" ? "per_call" : "granted";
	}
	if (!gate) return "n/a";
	return has ? "granted" : "per_call";
}

/** Where the owner's per-instance off-switches live in `agent_instances.config`. */
export const DISABLED_TOOLS_KEY = "disabledTools";

/** A registry tool answers to both surfaces; a built-in one answers only to the chat loop. */
const REGISTRY_INVOCATION: readonly ToolInvocation[] = ["chat", "call_instance_tool"];

/**
 * EVERY tool an instance could run, registry and built-in alike — the input the listing is
 * resolved from (#525).
 *
 * The listing used to be handed `registryTools()` and described as reporting on the agent, so the
 * eleven BASE names with no registry entry — `write_memory`, `fetch_url`, `create_task` and the
 * rest — were invisible to an operator auditing what an agent may do, while the chat ran them.
 * Exported so a test can assert the containment that would have caught it:
 * `toolNamesFor(caps) ⊆ names(allToolPolicyInputs())`.
 */
export function allToolPolicyInputs(): PolicyInput[] {
	return [...registryTools(), ...builtinToolPolicyInputs()];
}

/**
 * Resolve the policy for every registry tool. Pure — the caller supplies the agent's
 * capabilities and the owner's disabled list, so this is exhaustively testable and the two
 * gates can't drift between the chat runtime, the REST invoker and MCP.
 *
 * Returns EVERY tool, not just the allowed ones: "what can this agent do" is only answerable
 * if the answer includes what it can't, and why. Callers that want the old shape filter on
 * `.allowed`.
 */
export function resolveToolPolicy(
	capabilities: AgentCapabilities,
	disabledTools: readonly string[] = [],
	tools: ReadonlyArray<PolicyInput> = allToolPolicyInputs(),
	consentedConnectors: readonly string[] = [],
): ToolPolicyEntry[] {
	const declared = toolNamesFor(capabilities);
	const off = new Set(disabledTools);
	const granted = new Set(consentedConnectors);
	return tools.map((t) => {
		const isDeclared = declared.has(t.name);
		const disabled = off.has(t.name);
		const reason: ToolPolicyReason = !isDeclared ? "not_declared" : disabled ? "disabled_by_owner" : "ok";
		return {
			name: t.name,
			connector: t.connector,
			scope: t.scope ?? "read",
			// Fails CLOSED, unlike `scope` directly above it — see PolicyInput.mutates for why the
			// two defaults point opposite ways.
			mutates: t.mutates ?? true,
			description: t.description,
			jsonSchema: t.jsonSchema,
			allowed: isDeclared && !disabled,
			disabled,
			reason,
			writeConsent: writeConsentOf(t, granted),
			// Defaults describe a REGISTRY tool, because `registryTools()` is this function's own
			// default argument and every registry entry carries `tier`. A built-in row states both
			// fields explicitly (`builtinToolPolicyInputs`), so neither default can describe it.
			tier: t.tier ?? "connector",
			invocableBy: t.invocableBy ?? REGISTRY_INVOCATION,
			// Derived from the tool's name and connector, not from either of the two fields above
			// it — see tool-reach.ts for why every one of them was measured and rejected as a proxy.
			reach: reachOf(t),
		};
	});
}

/** How much of the listing to send. Both default OFF, and only one of them is a policy choice. */
export interface ToolListingOptions {
	/** Narrow to the runnable set. NOT a default — see {@link projectToolListing}. */
	allowedOnly?: boolean;
	/** Include each allowed tool's input schema. Off by default: it is 41% of the payload. */
	schemas?: boolean;
}

/**
 * The listing as it goes over the wire (#569) — the one place the response's SIZE is decided.
 *
 * Measured on production instance bd43f4de-… (104 rows, 2026-08-15): 89,281 bytes, which exceeded
 * the calling host's response limit. So the tool's most useful mode — "return every tool, not just
 * the allowed ones" — was the one that did not fit.
 *
 * Two reductions, and they are not the same kind of thing:
 *
 *   1. **A schema is never sent for a row the instance cannot run.** That is not a budget
 *      decision, it is a correctness one: a schema describes inputs the caller can never send.
 *      The verdict, reason, scope, mutation answer, tier, connector and writeConsent all stay, so
 *      nothing auditable is lost.
 *   2. **Schemas are opt-in even for allowed rows** (`schemas: true`). This IS a budget decision,
 *      and it is here because (1) is not enough on its own. Re-measured against this tree: with
 *      only (1), an agent that declares nothing (39 of 104 allowed) serialises to 65,600 bytes —
 *      64 bytes over 64 KiB — and one that declares every tool to 82,535. Dropping schemas by
 *      default puts EVERY shape at ~54,000, which is a bound rather than a coincidence. A caller
 *      that wants to invoke something asks for the schema and gets it for the tools it may run.
 *
 * `allowedOnly` stays opt-in and must not become the default: `resolveToolPolicy`'s contract is
 * that "what can this agent do" is only answerable if the answer includes what it can't, and
 * defaulting it away would retire that quietly while looking like a size fix.
 */
export function projectToolListing(policy: readonly ToolPolicyEntry[], opts: ToolListingOptions = {}): ToolPolicyEntry[] {
	const rows = opts.allowedOnly ? policy.filter((t) => t.allowed) : policy;
	return rows.map((t) => {
		if (opts.schemas && t.allowed) return t;
		const { jsonSchema: _dropped, ...rest } = t;
		return rest;
	});
}

/**
 * What to tell a caller that is about to spend a call on this tool. Null when nothing is in the
 * way — so a consumer can append it unconditionally without inventing "consent: fine" noise.
 *
 * The connector is NAMED because the surface and the consent key are not always the same word:
 * an instance whose surface is `tmux` gets its tools from the `terminal` connector, and granting
 * `tmux` write there looks right and does nothing (#351).
 */
export function explainWriteConsent(entry: Pick<ToolPolicyEntry, "name" | "connector" | "writeConsent">): string | null {
	const conn = entry.connector ?? "this";
	if (entry.writeConsent === "required") {
		return `"${entry.name}" will be refused until write access for the ${conn} connector is granted for this agent (console → Settings → Connections).`;
	}
	if (entry.writeConsent === "per_call") {
		return conn === "mcp"
			? `"${entry.name}" is granted per server and per remote tool — a call to a server that has not been granted is refused (console → Settings → MCP connections).`
			: `"${entry.name}" may read, but a request that changes anything is refused until write access for the ${conn} connector is granted for this agent.`;
	}
	return null;
}

/** Parse the owner's off-switch list out of an instance's config blob. Never throws. */
export function readDisabledTools(config: string | null | undefined): string[] {
	if (!config) return [];
	try {
		const cfg = JSON.parse(config) as Record<string, unknown>;
		const raw = cfg[DISABLED_TOOLS_KEY];
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

/**
 * The policy for one owned instance, resolving its agent's capabilities from D1.
 *
 * Fail-closed on a capability lookup miss is WRONG here and deliberately avoided: a missing
 * agent row means we can't prove the agent declared anything, and `agentCapabilities({})`
 * already returns the permissive default that the chat runtime uses. Diverging would make
 * this gate stricter than the chat for the same instance, which is a confusing failure. The
 * gate that matters for damage — write consent — is separately fail-closed.
 */
export async function instanceToolPolicy(
	env: Env,
	instanceId: string,
	userId: string,
	instanceConfig?: string | null,
): Promise<ToolPolicyEntry[]> {
	const row = await env.DB.prepare(
		"SELECT a.slug AS slug, a.category AS category, a.config AS config, i.config AS instance_config FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<{ slug: string | null; category: string | null; config: string | null; instance_config: string | null }>();
	const capabilities = agentCapabilities(row ?? {});
	const disabled = readDisabledTools(instanceConfig !== undefined ? instanceConfig : row?.instance_config);
	// The consent rows are read here rather than per tool: one query for the whole listing, and
	// the failure mode matches the gate itself — `listConsents` returning nothing reports
	// `required`, which is what runRegistryTool would then do (#90 is fail-closed).
	const consented = (await listConsents(env, instanceId).catch(() => [])).filter((r) => r.scope === "write").map((r) => r.connector);
	return resolveToolPolicy(capabilities, disabled, allToolPolicyInputs(), consented);
}
