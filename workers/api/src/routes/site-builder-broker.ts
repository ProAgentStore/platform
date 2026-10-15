import { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { verifyBrokerToken } from "../lib/runtime-builder/broker-token.js";
import { verifiedCaptureRequest } from "../lib/runtime-builder/capture-artifacts.js";
import { assertFwsAuthoringTool } from "../lib/runtime-builder/fws-proxy.js";
import type { RuntimeBuilderRun } from "../lib/runtime-builder/types.js";
import { brokerFwsTool, captureRuntimeBuilderPreview, getRuntimeBuilderRun, submitRuntimeBuilderEvidence } from "../lib/runtime-builder/workflow.js";
import type { Env } from "../types.js";

/**
 * The Website Builder broker (#841, PR842): the ONE way the owner's local author reaches FreeWebStore.
 *
 * The author runs the owner's signed-in Claude Code or Codex on their own machine. It holds no FWS
 * OAuth token and no PAGS session — only a credential naming one run (`broker-token.ts`), which its
 * runner sends here. For each call PAGS:
 *
 *  1. authenticates the run: the token must be this run's, unexpired, and the run still open
 *     (401 for any token problem, without saying which; 409 once the run is approved, cancelled or failed);
 *  2. refuses anything but the FreeWebStore AUTHORING tools (`assertFwsAuthoringTool`: deploy and
 *     push_update are 403 — they happen only through the owner's `/approve`);
 *  3. runs the tool through `mcp_call_tool`, which applies the owner's own FWS OAuth token, the
 *     connector write consent and the exact endpoint/tool grant — the same registry path every other
 *     caller uses; `capture_preview` goes through the existing capture path, so screenshots become
 *     the run's R2 artifacts, never bytes in a model transcript;
 *  4. binds every session-scoped call to THIS run's own draft (`bindRunSession`): the credential
 *     authorizes one draft, not every draft the owner's FreeWebStore account can reach;
 *  5. records the call on the run's transcript, and takes the quality report and the draft's
 *     session id from FreeWebStore's OWN answers — the author's evidence cannot claim them.
 *
 * Outside the owner-session routes on purpose: the caller is a runner, which has no session.
 */
export const siteBuilderBrokerRoutes = new Hono<{ Bindings: Env }>();

const CLOSED = new Set(["approved", "cancelled", "failed"]);
async function authorizedRun(c: { env: Env; req: { param(name: string): string; header(name: string): string | undefined } }): Promise<RuntimeBuilderRun> {
	const runId = c.req.param("runId");
	const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
	const row = token
		? await c.env.DB.prepare("SELECT instance_id, user_id FROM site_builder_runtime_runs WHERE id = ?1").bind(runId).first<{ instance_id: string; user_id: string }>()
		: null;
	if (!row || !(await verifyBrokerToken(c.env, { userId: row.user_id, instanceId: row.instance_id, runId }, token))) throw new HttpError(401, "Unauthorized");
	const run = await getRuntimeBuilderRun(c.env, row.instance_id, row.user_id, runId);
	if (!run) throw new HttpError(401, "Unauthorized");
	if (CLOSED.has(run.status)) throw new HttpError(409, `This Website Builder run is ${run.status}; nothing more can be done on it.`);
	return run;
}

siteBuilderBrokerRoutes.post("/:runId/tool", async (c) => {
	const run = await authorizedRun(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const tool = assertFwsAuthoringTool(body.tool);
	const args = { ...((body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {}) as Record<string, unknown>) };
	// A draft stays out of search until the owner approves a deploy.
	if (tool === "set_meta") args.noindex = true;

	if (tool === "capture_preview") {
		const request = await verifiedCaptureRequest({ device: args.device, viewport: args.viewport });
		const captured = await captureRuntimeBuilderPreview(c.env, run.instanceId, run.userId, run.id, request, args);
		return c.json({ success: true, content: `PAGS captured the ${request.device} preview and keeps it for the owner's review.`, status: captured.status });
	}

	const result = await brokerFwsTool(c.env, run, tool, args);
	return c.json({ success: result.success, content: result.content });
});

siteBuilderBrokerRoutes.post("/:runId/evidence", async (c) => {
	const run = await authorizedRun(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	// What PAGS observed itself is not the author's to claim.
	for (const k of ["screenshots", "qualityReport", "fwsTranscript", "approvalState"]) {
		if (k in body) return c.json({ error: `${k} is recorded by PAGS from the author's tool calls, not reported by the author.` }, 400);
	}
	const patch: Record<string, unknown> = {};
	if (typeof body.sessionId === "string" && body.sessionId.trim()) patch.sessionId = body.sessionId.trim();
	if (body.deployParams && typeof body.deployParams === "object" && !Array.isArray(body.deployParams)) patch.deployParams = body.deployParams;
	if (typeof body.model === "string" && body.model.trim()) patch.model = body.model.trim();
	if (!Object.keys(patch).length) return c.json({ error: "sessionId, deployParams or model is required" }, 400);
	// The draft's session is ONLY FreeWebStore's own answer to this run's create_site (PR842 review): before
	// one there is no session to adopt, and any other one — another draft of the same owner — is refused.
	if (patch.sessionId && patch.sessionId !== run.evidence.sessionId) {
		return c.json({ error: run.evidence.sessionId ? "That is not the draft session this run created." : "This run has no draft yet: its session is recorded from create_site, never reported." }, 409);
	}
	const updated = await submitRuntimeBuilderEvidence(c.env, run.instanceId, run.userId, run.id, patch);
	return c.json({ status: updated.status });
});
