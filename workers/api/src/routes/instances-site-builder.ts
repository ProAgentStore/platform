import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { assertFwsAuthoringTool } from "../lib/runtime-builder/fws-proxy.js";
import { captureObjectKey, verifiedCaptureRequest, verifyCaptureDelivery } from "../lib/runtime-builder/capture-artifacts.js";
import { approveRuntimeBuilderRun, cancelRuntimeBuilderRun, captureRuntimeBuilderPreview, createRuntimeBuilderRun, getRuntimeBuilderRun, refineRuntimeBuilderRun, submitRuntimeBuilderEvidence } from "../lib/runtime-builder/workflow.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/** Runtime Website Builder: PAGS owns state, consent and deployment; the local CLI authors only. */
export function registerRuntimeBuilderRoutes(router: Hono<{ Bindings: Env }>): void {
	router.post("/:instanceId/site-builder/run", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await createRuntimeBuilderRun(c.env, instanceId, session.uid, await c.req.json().catch(() => ({}))), 202);
	});
	router.get("/:instanceId/site-builder/:runId", async (c) => {
		const session = await requireUser(c); const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const run = await getRuntimeBuilderRun(c.env, instanceId, session.uid, c.req.param("runId"));
		return run ? c.json(run) : c.json({ error: "Website Builder run not found" }, 404);
	});
	router.post("/:instanceId/site-builder/:runId/cancel", async (c) => {
		const session = await requireUser(c); const instanceId = c.req.param("instanceId"); await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await cancelRuntimeBuilderRun(c.env, instanceId, session.uid, c.req.param("runId")));
	});
	router.post("/:instanceId/site-builder/:runId/approve", async (c) => {
		const session = await requireUser(c); const instanceId = c.req.param("instanceId"); await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await approveRuntimeBuilderRun(c.env, instanceId, session.uid, c.req.param("runId")));
	});
	router.post("/:instanceId/site-builder/:runId/refine", async (c) => {
		const session = await requireUser(c); const instanceId = c.req.param("instanceId"); await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = await c.req.json().catch(() => ({})) as { request?: unknown };
		return c.json(await refineRuntimeBuilderRun(c.env, instanceId, session.uid, c.req.param("runId"), typeof body.request === "string" ? body.request.slice(0, 4000) : "Refine the draft using the quality report."));
	});
	/**
	 * Capture through PAGS, not the local CLI: this preserves the existing per-endpoint OAuth
	 * and capture_preview grant. Only a signed, run-scoped artifact URL crosses the relay.
	 */
	router.post("/:instanceId/site-builder/:runId/capture", async (c) => {
		const session = await requireUser(c); const instanceId = c.req.param("instanceId"); await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const capture = await verifiedCaptureRequest({ device: body.device, viewport: body.viewport });
		const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
		return c.json(await captureRuntimeBuilderPreview(c.env, instanceId, session.uid, c.req.param("runId"), capture, args), 202);
	});
	// The runner reports structured evidence here. This endpoint intentionally accepts evidence,
	// never FWS credentials or screenshot bytes: only the capture route can create visual evidence.
	router.post("/:instanceId/site-builder/:runId/evidence", async (c) => {
		const session = await requireUser(c); const instanceId = c.req.param("instanceId"); await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		if ("screenshots" in body) return c.json({ error: "Use the FWS capture endpoint for screenshot evidence" }, 400);
		const calls = Array.isArray(body.fwsTranscript) ? body.fwsTranscript : [];
		for (const call of calls) if (call && typeof call === "object") assertFwsAuthoringTool((call as Record<string, unknown>).tool);
		return c.json(await submitRuntimeBuilderEvidence(c.env, instanceId, session.uid, c.req.param("runId"), body));
	});
	/** Signed, job-scoped image fetch for the connected runner. It deliberately has no session
	 * cookie: the short-lived HMAC is scoped to user + instance + run + exact content digest. */
	router.get("/:instanceId/site-builder/:runId/artifacts/:artifactId", async (c) => {
		const instanceId = c.req.param("instanceId"); const runId = c.req.param("runId"); const artifactId = c.req.param("artifactId");
		const uid = c.req.query("uid") || ""; const exp = c.req.query("exp") || ""; const token = c.req.query("token") || "";
		if (!(await verifyCaptureDelivery(c.env, { userId: uid, instanceId, runId, artifactId, exp, token }))) return c.json({ error: "unauthorized" }, 401);
		const run = await c.env.DB.prepare("SELECT id FROM site_builder_runtime_runs WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status != 'cancelled'").bind(runId, instanceId, uid).first<{ id: string }>();
		if (!run) return c.json({ error: "capture artifact not found" }, 404);
		const object = await c.env.STORAGE.get(captureObjectKey(uid, instanceId, runId, artifactId));
		if (!object) return c.json({ error: "capture artifact not found" }, 404);
		return new Response(object.body, { headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream", "Cache-Control": "private, max-age=900" } });
	});
}
