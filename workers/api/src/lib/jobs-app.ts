/**
 * Server-side calls to the Jobs app (jobs.proappstore.online) over its MCP endpoint (#1586, #1587).
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
import { runRegistryTool } from "./tool-registry.js";

export const JOBS_MCP_URL = "https://mcp.proappstore.online/mcp/apps/jobs";

export type JobsCallResult = { ok: true } | { ok: false; reason: "no_grant" | "failed"; detail: string };

/** Call one Jobs tool as `instanceId`'s owner. Needs a grant for `tool` on {@link JOBS_MCP_URL} on that instance. */
export async function callJobsTool(env: Env, who: { userId: string; instanceId: string }, tool: string, args: Record<string, unknown>): Promise<JobsCallResult> {
	try {
		// Checked first so an instance with no grant is a quiet, named state rather than an audited denial per call.
		if (!(await hasMcpConsent(env, who.instanceId, normalizeMcpEndpoint(JOBS_MCP_URL), tool))) {
			return { ok: false, reason: "no_grant", detail: `This instance has no MCP grant for ${tool} on ${JOBS_MCP_URL}.` };
		}
		const r = await runRegistryTool("mcp_call_tool", { env, userId: who.userId, agentId: who.instanceId, instanceId: who.instanceId }, { url: JOBS_MCP_URL, tool, args });
		return r.success ? { ok: true } : { ok: false, reason: "failed", detail: clipMarked(r.content, 300) };
	} catch (e) {
		return { ok: false, reason: "failed", detail: clipMarked(e instanceof Error ? e.message : String(e), 300) };
	}
}
