import { HttpError } from "../auth.js";
import { BROKER_BASE_URL, mintBrokerToken } from "./broker-token.js";
import { deriveClientType } from "../coding-command.js";
import { readEngines } from "../coding-engines.js";
import { startPipelineRun } from "../pipeline-run-start.js";
import { callRuntime, getLiveRuntime, mirrorRuntimeTask, runtimeJson } from "../../routes/instances-runtime.js";
import type { Env } from "../../types.js";
import { emptyEvidence, type RuntimeBuilderEngine, type RuntimeBuilderEvidence, type RuntimeBuilderRun, type RuntimeBuilderStatus } from "./types.js";
import { appendFwsEvidence, fwsProxyInput, hasVisualQa } from "./fws-proxy.js";
import { unfenceUntrusted } from "../untrusted-fence.js";
import { signedCaptureDelivery, storeCaptureArtifact, type CaptureRequest } from "./capture-artifacts.js";

interface RunRow { id: string; instance_id: string; user_id: string; engine: RuntimeBuilderEngine; status: RuntimeBuilderStatus; evidence: string; refinement_count: number; created_at: string; updated_at: string }
const safeJson = (value: unknown) => JSON.stringify(value);
const parseEvidence = (value: string, engine: RuntimeBuilderEngine): RuntimeBuilderEvidence => { try { return { ...emptyEvidence(engine), ...(JSON.parse(value) as RuntimeBuilderEvidence) }; } catch { return emptyEvidence(engine); } };
const present = (row: RunRow): RuntimeBuilderRun => ({ id: row.id, instanceId: row.instance_id, userId: row.user_id, engine: row.engine, status: row.status, evidence: parseEvidence(row.evidence, row.engine), refinementCount: row.refinement_count, createdAt: row.created_at, updatedAt: row.updated_at });

export async function getRuntimeBuilderRun(env: Env, instanceId: string, userId: string, runId: string): Promise<RuntimeBuilderRun | null> {
	const row = await env.DB.prepare("SELECT * FROM site_builder_runtime_runs WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(runId, instanceId, userId).first<RunRow>();
	return row ? present(row) : null;
}

export async function createRuntimeBuilderRun(env: Env, instanceId: string, userId: string, input: { engine?: unknown; mcpUrl?: unknown; params?: unknown }): Promise<RuntimeBuilderRun> {
	const engine = input.engine === "claude" || input.engine === "codex" ? input.engine : null;
	if (!engine) throw new HttpError(400, "engine must be claude or codex");
	const mcpUrl = typeof input.mcpUrl === "string" ? input.mcpUrl.trim() : "";
	if (!mcpUrl) throw new HttpError(400, "mcpUrl required");
	const engines = await readEngines(env, instanceId, userId);
	if (!engines.engines.some((candidate) => deriveClientType(candidate.command) === engine)) throw new HttpError(409, `No configured ${engine} runtime engine`);
	const runId = crypto.randomUUID();
	const evidence = { ...emptyEvidence(engine), fwsEndpoint: mcpUrl };
	await env.DB.prepare(`INSERT INTO site_builder_runtime_runs (id, instance_id, user_id, engine, status, evidence, refinement_count, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, 'drafting', ?5, 0, datetime('now'), datetime('now'))`).bind(runId, instanceId, userId, engine, safeJson(evidence)).run();
	const runtime = await getLiveRuntime(env, instanceId, userId);
	if (!runtime) return pauseRuntimeBuilderRun(env, instanceId, userId, runId, "Local pags up runner is unavailable");
	try {
		// The author reaches PAGS only through the broker, with a credential naming THIS run (#841, PR842).
		const broker = { url: `${BROKER_BASE_URL}${encodeURIComponent(runId)}`, token: await mintBrokerToken(env, { userId, instanceId, runId }) };
		const res = await callRuntime(env, runtime, "/tasks", { method: "POST", body: JSON.stringify({ type: "site_builder_runtime", title: "Website Builder draft", subtitle: `${engine} authoring draft`, input: { ...fwsProxyInput(runId, mcpUrl), engine, broker, params: input.params && typeof input.params === "object" ? input.params : {} } }) });
		const payload = await runtimeJson(res);
		if (!res.ok) throw new Error("runner rejected Website Builder task");
		const taskId = typeof (payload as Record<string, unknown>).id === "string" ? String((payload as Record<string, unknown>).id) : null;
		const nextEvidence = { ...evidence, taskId };
		await mirrorRuntimeTask(env, instanceId, userId, { ...(payload as Record<string, unknown>), type: "site_builder_runtime", status: "running" });
		await updateRuntimeBuilderRun(env, instanceId, userId, runId, "drafting", nextEvidence, 0);
	} catch (error) { return pauseRuntimeBuilderRun(env, instanceId, userId, runId, error instanceof Error ? error.message : "Runner unavailable"); }
	return (await getRuntimeBuilderRun(env, instanceId, userId, runId))!;
}

export async function updateRuntimeBuilderRun(env: Env, instanceId: string, userId: string, runId: string, status: RuntimeBuilderStatus, evidence: RuntimeBuilderEvidence, refinementCount = evidence.refinementCount): Promise<void> {
	await env.DB.prepare("UPDATE site_builder_runtime_runs SET status = ?1, evidence = ?2, refinement_count = ?3, updated_at = datetime('now') WHERE id = ?4 AND instance_id = ?5 AND user_id = ?6").bind(status, safeJson({ ...evidence, refinementCount }), refinementCount, runId, instanceId, userId).run();
}

export async function pauseRuntimeBuilderRun(env: Env, instanceId: string, userId: string, runId: string, reason: string): Promise<RuntimeBuilderRun> {
	const run = await getRuntimeBuilderRun(env, instanceId, userId, runId);
	if (!run) throw new HttpError(404, "Website Builder run not found");
	await updateRuntimeBuilderRun(env, instanceId, userId, runId, "paused", { ...run.evidence, offline: { ...run.evidence.offline, pausedAt: new Date().toISOString(), reason } }, run.refinementCount);
	return (await getRuntimeBuilderRun(env, instanceId, userId, runId))!;
}

export async function submitRuntimeBuilderEvidence(env: Env, instanceId: string, userId: string, runId: string, patch: Partial<RuntimeBuilderEvidence>): Promise<RuntimeBuilderRun> {
	const run = await getRuntimeBuilderRun(env, instanceId, userId, runId);
	if (!run) throw new HttpError(404, "Website Builder run not found");
	if (run.status === "cancelled" || run.status === "approved") throw new HttpError(409, "Website Builder run is closed");
	const evidence = { ...run.evidence, ...patch, fwsTranscript: Array.isArray(patch.fwsTranscript) ? patch.fwsTranscript.slice(-200) : run.evidence.fwsTranscript, screenshots: Array.isArray(patch.screenshots) ? patch.screenshots.slice(-8) : run.evidence.screenshots };
	const status: RuntimeBuilderStatus = hasVisualQa(evidence) ? "awaiting_review" : "drafting";
	await updateRuntimeBuilderRun(env, instanceId, userId, runId, status, { ...evidence, approvalState: status === "awaiting_review" ? "awaiting_review" : evidence.approvalState }, run.refinementCount);
	return (await getRuntimeBuilderRun(env, instanceId, userId, runId))!;
}

/**
 * PAGS performs the FWS call through the ordinary registry, retaining its endpoint-specific
 * OAuth and tool-grant gates. The local model receives only a short-lived reference to the
 * resulting image; the base64 block never lands in a model transcript or D1 evidence record.
 */
export async function captureRuntimeBuilderPreview(
	env: Env,
	instanceId: string,
	userId: string,
	runId: string,
	request: CaptureRequest,
	args: Record<string, unknown>,
): Promise<RuntimeBuilderRun> {
	const run = await getRuntimeBuilderRun(env, instanceId, userId, runId);
	if (!run) throw new HttpError(404, "Website Builder run not found");
	if (run.status === "cancelled" || run.status === "approved") throw new HttpError(409, "Website Builder run is closed");
	const url = run.evidence.fwsEndpoint?.trim();
	if (!url) throw new HttpError(409, "Website Builder run has no FWS endpoint");
	// This is intentionally NOT a raw fetch. `mcp_call_tool` resolves the user's OAuth token
	// and verifies connector write consent plus the exact endpoint/tool grant before touching FWS.
	// Deferred to keep the runtime-builder workflow out of the connector/trigger import cycle.
	// The call still goes through the one registry dispatch path, so no grant or OAuth check is
	// skipped merely because this is a durable Website Builder action.
	const { runRegistryTool } = await import("../tool-registry.js");
	const capture = await runRegistryTool("mcp_call_tool", { env, userId, instanceId }, { url, tool: "capture_preview", args });
	if (!capture.success) throw new HttpError(502, `FWS capture_preview failed: ${capture.content.slice(0, 500)}`);
	const artifact = await storeCaptureArtifact(env, run, request, capture.artifacts ?? []);
	const runtime = await getLiveRuntime(env, instanceId, userId);
	if (!runtime || !run.evidence.taskId) {
		await pauseRuntimeBuilderRun(env, instanceId, userId, runId, "Local pags up runner is unavailable while forwarding FWS capture");
		throw new HttpError(503, "Local runner is unavailable; retry the capture when it reconnects");
	}
	try {
		const delivery = await signedCaptureDelivery(env, run, artifact);
		const response = await callRuntime(env, runtime, `/tasks/${encodeURIComponent(run.evidence.taskId)}/artifacts`, {
			method: "POST",
			body: JSON.stringify({ runId, captureArtifacts: [delivery] }),
		});
		if (!response.ok) throw new Error("runner rejected FWS capture artifact");
	} catch {
		// R2 is already content-addressed. A retry reuses the same object/id and sends a fresh
		// short-lived URL, while the prior durable evidence remains untouched.
		await pauseRuntimeBuilderRun(env, instanceId, userId, runId, "Couldn't forward FWS capture to the local runner; retry the capture");
		throw new HttpError(503, "Couldn't forward FWS capture to the local runner; retry the capture");
	}
	const screenshots = [...run.evidence.screenshots.filter((shot) => shot.device !== artifact.device), artifact].slice(-8);
	const transcriptCall: RuntimeBuilderEvidence["fwsTranscript"][number] = { tool: "capture_preview", args: { device: request.device }, at: artifact.capturedAt, result: "ok" };
	return submitRuntimeBuilderEvidence(env, instanceId, userId, runId, {
		screenshots,
		fwsTranscript: [...run.evidence.fwsTranscript, transcriptCall].slice(-200),
	});
}

export async function refineRuntimeBuilderRun(env: Env, instanceId: string, userId: string, runId: string, request: string): Promise<RuntimeBuilderRun> {
	const run = await getRuntimeBuilderRun(env, instanceId, userId, runId);
	if (!run) throw new HttpError(404, "Website Builder run not found");
	if (run.status === "cancelled" || run.status === "approved") throw new HttpError(409, "Website Builder run is closed");
	if (run.refinementCount >= 1) throw new HttpError(409, "Website Builder allows one refinement only");
	if (!run.evidence.taskId) throw new HttpError(409, "This run has no runner task to refine");
	const runtime = await getLiveRuntime(env, instanceId, userId);
	if (!runtime) return pauseRuntimeBuilderRun(env, instanceId, userId, runId, "Local pags up runner is unavailable");
	// The refinement is one more turn for the local author (PR842). It used to POST the task's `/approve`,
	// which the runner refuses for a running task — and the answer was never read, so the run recorded a
	// refinement nobody received and the one allowed refinement was spent on nothing.
	let delivered: Response;
	try {
		delivered = await callRuntime(env, runtime, `/tasks/${encodeURIComponent(run.evidence.taskId)}/site-builder/refine`, { method: "POST", body: JSON.stringify({ refinement: request }) });
	} catch (error) {
		throw new HttpError(502, `The runner did not take the refinement: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!delivered.ok) {
		const why = (await runtimeJson(delivered).catch(() => ({}))) as { error?: unknown };
		throw new HttpError(delivered.status === 409 ? 409 : 502, `The runner did not take the refinement: ${typeof why.error === "string" ? why.error : `HTTP ${delivered.status}`}`);
	}
	const evidence = { ...run.evidence, refinementCount: 1, offline: { ...run.evidence.offline, resumedAt: new Date().toISOString() } };
	await updateRuntimeBuilderRun(env, instanceId, userId, runId, "drafting", evidence, 1);
	return (await getRuntimeBuilderRun(env, instanceId, userId, runId))!;
}

export async function approveRuntimeBuilderRun(env: Env, instanceId: string, userId: string, runId: string): Promise<RuntimeBuilderRun> {
	const run = await getRuntimeBuilderRun(env, instanceId, userId, runId);
	if (!run) throw new HttpError(404, "Website Builder run not found");
	if (run.status !== "awaiting_review" || !hasVisualQa(run.evidence)) throw new HttpError(409, "PAGS approval requires a quality report plus desktop and mobile previews");
	if (!run.evidence.sessionId || !run.evidence.deployParams) throw new HttpError(409, "Draft evidence is missing deploy handoff data");
	const params = { ...run.evidence.deployParams, session_id: run.evidence.sessionId };
	const deploy = await startPipelineRun(env, instanceId, userId, "site-deploy", params, "api");
	if (!deploy.ok) throw new HttpError(409, deploy.error);
	await updateRuntimeBuilderRun(env, instanceId, userId, runId, "approved", { ...run.evidence, approvalState: "approved" }, run.refinementCount);
	return (await getRuntimeBuilderRun(env, instanceId, userId, runId))!;
}

export async function cancelRuntimeBuilderRun(env: Env, instanceId: string, userId: string, runId: string): Promise<RuntimeBuilderRun> {
	const run = await getRuntimeBuilderRun(env, instanceId, userId, runId);
	if (!run) throw new HttpError(404, "Website Builder run not found");
	const runtime = await getLiveRuntime(env, instanceId, userId);
	if (runtime && run.evidence.taskId) await callRuntime(env, runtime, `/tasks/${encodeURIComponent(run.evidence.taskId)}/cancel`, { method: "POST" }).catch(() => undefined);
	await updateRuntimeBuilderRun(env, instanceId, userId, runId, "cancelled", { ...run.evidence, approvalState: "denied" }, run.refinementCount);
	return (await getRuntimeBuilderRun(env, instanceId, userId, runId))!;
}

/** Arguments worth keeping on the transcript: identifiers, never page content. */
const TRANSCRIPT_ARGS = ["session_id", "template_slug", "section_id", "device"];

function fwsAnswer(content: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(unfenceUntrusted(content)) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * One FreeWebStore authoring call for the local author, made by PAGS (#841, PR842) — the broker route
 * (`routes/site-builder-broker.ts`) has already authenticated the run and refused non-authoring tools.
 * `mcp_call_tool` applies the owner's own FWS OAuth token, write consent and endpoint/tool grant. The
 * call is recorded on the run, and the quality report and draft session are taken from FreeWebStore's
 * own answers — the author cannot claim them.
 */
export async function brokerFwsTool(env: Env, run: RuntimeBuilderRun, tool: string, args: Record<string, unknown>): Promise<{ success: boolean; content: string }> {
	const url = run.evidence.fwsEndpoint?.trim();
	if (!url) throw new HttpError(409, "This Website Builder run has no FreeWebStore endpoint.");
	// Deferred for the same import-cycle reason `captureRuntimeBuilderPreview` gives.
	const { runRegistryTool } = await import("../tool-registry.js");
	const result = await runRegistryTool("mcp_call_tool", { env, userId: run.userId, instanceId: run.instanceId }, { url, tool, args });
	const kept = Object.fromEntries(TRANSCRIPT_ARGS.filter((k) => typeof args[k] === "string").map((k) => [k, args[k]]));
	let evidence = appendFwsEvidence(run.evidence, { tool, ...(Object.keys(kept).length ? { args: kept } : {}), at: new Date().toISOString(), result: result.success ? "ok" : "error" });
	const answer = result.success ? fwsAnswer(result.content) : null;
	if (answer && tool === "get_quality_report") evidence = { ...evidence, qualityReport: answer };
	if (answer && tool === "create_site" && typeof answer.session_id === "string") evidence = { ...evidence, sessionId: answer.session_id };
	const status = hasVisualQa(evidence) ? "awaiting_review" : "drafting";
	await updateRuntimeBuilderRun(env, run.instanceId, run.userId, run.id, status, { ...evidence, approvalState: status === "awaiting_review" ? "awaiting_review" : evidence.approvalState }, run.refinementCount);
	return { success: result.success, content: result.content };
}
