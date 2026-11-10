/**
 * Server-side calls to the owner's ProAppStore apps over their MCP endpoints: the Jobs app
 * (jobs.proappstore.online, #1586, #1587) and the CV app (cv.proappstore.online, #1624).
 *
 * This is the same outbound path a model's `mcp_call_tool` takes, run by the platform instead of by a
 * prompt: `runRegistryTool("mcp_call_tool")` applies the per-(instance, endpoint, tool) grant, the
 * connector write consent, and the owner's MCP account for the endpoint (resolved per user, pinned per
 * instance). No auth scheme of its own, and no credential is read here.
 *
 * Nothing here throws: a Jobs problem is a returned verdict, so no caller's scan, tailoring or
 * submission can fail because of it.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { hasMcpConsent, normalizeMcpEndpoint } from "./mcp-consent.js";
import { resolveMcpAccount } from "./mcp-credentials.js";
import { runRegistryTool } from "./tool-registry.js";
import { unfenceUntrusted } from "./untrusted-fence.js";

export const JOBS_MCP_URL = "https://mcp.proappstore.online/mcp/apps/jobs";
export const CV_MCP_URL = "https://mcp.proappstore.online/mcp/apps/cv";

type Who = { userId: string; instanceId: string };
/** `data` is the tool's payload when it returned JSON (a query tool's rows), else undefined. */
export type JobsCallResult = { ok: true; data?: unknown } | { ok: false; reason: "no_grant" | "not_connected" | "ambiguous" | "pinned_account_gone" | "failed"; detail: string };

const connectHint = (url: string) => `Connect ${url.split("/").pop()}.proappstore.online in Permissions & Connections → MCP connections.`;

/** With a grant for `tool`, does the owner's MCP account for the app's endpoint resolve? Null when it does, or there is no grant (#1605). */
export async function appAccountProblem(env: Env, who: Who, url: string, tool: string): Promise<Extract<JobsCallResult, { ok: false }> | null> {
	const endpoint = normalizeMcpEndpoint(url);
	if (!endpoint || !(await hasMcpConsent(env, who.instanceId, endpoint, tool))) return null;
	const account = await resolveMcpAccount(env, who.userId, endpoint, who.instanceId);
	return account.ok ? null : { ok: false, reason: account.reason, detail: `${account.message} ${connectHint(url)}` };
}

export const jobsAccountProblem = (env: Env, who: Who, tool: string) => appAccountProblem(env, who, JOBS_MCP_URL, tool);

/** The `data` of `mcp_call_tool`'s `{tool, ok, data}` envelope (fenced as untrusted by the registry), or undefined. */
function payloadOf(content: string): unknown {
	try {
		return (JSON.parse(unfenceUntrusted(content)) as { data?: unknown }).data;
	} catch {
		return undefined;
	}
}

/** Call one tool of the app at `url` as `instanceId`'s owner. Needs a grant for `tool` on that endpoint on that instance. */
export async function callAppTool(env: Env, who: Who, url: string, tool: string, args: Record<string, unknown>): Promise<JobsCallResult> {
	try {
		// Checked first so an instance with no grant is a quiet, named state rather than an audited denial per call.
		if (!(await hasMcpConsent(env, who.instanceId, normalizeMcpEndpoint(url), tool))) {
			return { ok: false, reason: "no_grant", detail: `This instance has no MCP grant for ${tool} on ${url}.` };
		}
		const unresolved = await appAccountProblem(env, who, url, tool);
		if (unresolved) return unresolved;
		const r = await runRegistryTool("mcp_call_tool", { env, userId: who.userId, agentId: who.instanceId, instanceId: who.instanceId }, { url, tool, args });
		if (r.success) return { ok: true, data: payloadOf(r.content) };
		return { ok: false, reason: "failed", detail: clipMarked(r.content, 300) };
	} catch (e) {
		return { ok: false, reason: "failed", detail: clipMarked(e instanceof Error ? e.message : String(e), 300) };
	}
}

/** Call one Jobs tool as `instanceId`'s owner. Needs a grant for `tool` on {@link JOBS_MCP_URL} on that instance. */
export const callJobsTool = (env: Env, who: Who, tool: string, args: Record<string, unknown>) => callAppTool(env, who, JOBS_MCP_URL, tool, args);
