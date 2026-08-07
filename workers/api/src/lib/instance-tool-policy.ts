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
import { registryTools } from "./tool-registry.js";
import { listConsents } from "./connector-consent.js";
import type { Env } from "../types.js";

/** Why a tool is or isn't runnable — surfaced to the UI/MCP so "blocked" is never a mystery. */
export type ToolPolicyReason = "ok" | "not_declared" | "disabled_by_owner";

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
	scope: "read" | "write";
	description: string;
	jsonSchema: unknown;
	/** The final answer: may this instance run this tool right now? */
	allowed: boolean;
	/** True when the agent declares it but the owner switched it off. */
	disabled: boolean;
	reason: ToolPolicyReason;
	/** The SEPARATE write-consent verdict (#351). Never folded into `allowed`. */
	writeConsent: ToolWriteConsent;
}

/** A tool as this module reads it — the fields of `ToolDef` the two verdicts are computed from. */
type PolicyInput = { name: string; connector?: string; scope?: "read" | "write"; description: string; jsonSchema: unknown };

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
	const props = (t.jsonSchema as { properties?: Record<string, unknown> } | null | undefined)?.properties;
	if (scope === "read" && props && props.method !== undefined) return "method";
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
	tools: ReadonlyArray<PolicyInput> = registryTools(),
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
			description: t.description,
			jsonSchema: t.jsonSchema,
			allowed: isDeclared && !disabled,
			disabled,
			reason,
			writeConsent: writeConsentOf(t, granted),
		};
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

/** Human-readable refusal, so an API 403 and an agent's own error say the same thing. */
export function explainRefusal(name: string, reason: ToolPolicyReason): string {
	return reason === "disabled_by_owner"
		? `"${name}" is switched off for this agent. Turn it back on in the console (Settings → Tools) to use it.`
		: `"${name}" is not one of this agent's tools. It can only run the tools its agent declares.`;
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
	return resolveToolPolicy(capabilities, disabled, registryTools(), consented);
}
