/**
 * First-party MCP presets (#287) — the one-click "connect ProAgentStore to itself" entry, and the
 * dogfood smoke test that proves the whole outbound path works end to end.
 *
 * WHY A PRESET IS ONLY A PREFILLED URL. It is tempting to make a first-party server special: skip
 * the consent grant, mint a credential silently, cache a "connected" flag. Each of those would
 * undo something deliberate — #262's per-(instance, endpoint, tool) grants, #286's endpoint-scoped
 * credentials, #266's rule that connection health is a fact about now and is never stored. A
 * preset therefore carries no credential and grants nothing; it fills in a URL that is otherwise
 * easy to mistype, and every gate downstream is unchanged. "We wrote this server" is not a
 * permission.
 *
 * WHY THE URL COMES FROM ENV. `lib/connectors/mcp.ts` deliberately contains no server host at all:
 * PAGS is self-contained at runtime and a configured MCP server is user DATA, so a hardcoded host
 * in the connector would quietly make one deployment's server part of the product. Resolving from
 * deployment config keeps local, staging and production each pointing at their own MCP server —
 * and a deployment that sets nothing offers no preset at all, which is the behaviour that keeps
 * production out of a developer's local build.
 *
 * Pure: env in, presets out. No fetch, no D1.
 */
import { normalizeMcpEndpoint } from "./mcp-consent.js";
import type { Env } from "../types.js";

export interface McpPreset {
	id: string;
	label: string;
	/** Normalized endpoint — the same form consent, the trace and the credential store key on. */
	url: string;
	/** Requested at authorization. Least privilege: the smoke test only reads. */
	scope: string | null;
	/**
	 * A read-only tool worth trying first, once the owner has granted it. Advisory — the console
	 * offers a button; the call still goes through `mcp_call_tool` and its consent gate like any
	 * other, which is why this is a tool NAME and not a bypass.
	 */
	smokeTool: string | null;
	description: string;
}

/**
 * The presets this deployment knows about.
 *
 * Returns [] when `MCP_SELF_URL` is unset or is not an https MCP endpoint. An unset var is the
 * normal state of a local build, not an error: the panel simply shows no preset, and the user can
 * still type any URL.
 */
export function firstPartyMcpPresets(env: Pick<Env, "MCP_SELF_URL">): McpPreset[] {
	const url = normalizeMcpEndpoint(String(env.MCP_SELF_URL ?? ""));
	if (!url) return [];
	return [
		{
			id: "proagentstore",
			label: "ProAgentStore",
			url,
			// `read` and nothing else. The platform's own MCP server also publishes `write`,
			// `runtime` and `destructive` scopes; asking for them here would hand an agent the
			// ability to mutate the account that authorized it, in a flow whose stated purpose is
			// to check that listing works.
			scope: "read",
			smokeTool: "list_agents",
			description: "This ProAgentStore deployment's own MCP server — agents, instances and knowledge as remote tools.",
		},
	];
}
