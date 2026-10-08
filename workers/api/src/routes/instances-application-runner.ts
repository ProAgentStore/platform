/**
 * Application Runner (#957) — settings, and the fill runs it performs.
 *
 * A run normally starts from a connection: the Tailor's `job.application.materials_ready` (#956)
 * routed to this instance with the `start_application_fill` action. `POST …/application-runs` is
 * the same start path for an owner holding the event; replaying either returns the existing run.
 * Reading a run pulls it from the runner first (the runner cannot reach the API).
 *
 * Owner-scoped throughout. Responses carry classes, decisions and artifact handles — never a value
 * typed into a form.
 */
import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { patchInstanceConfig, readInstanceConfigPair } from "../lib/instance-config.js";
import { cancelApplyRun, resumeApplyRun, startApplicationFill, syncApplyRun } from "../lib/local-apply/apply.js";
import { RUNNER_DEFAULTS, RUNNER_SETTINGS_KEY, effectiveRunnerSettings, mergeRunnerSettings } from "../lib/local-apply/policy.js";
import { applicationAudit, getApplyRun, listApplyRuns } from "../lib/local-apply/store.js";
import { SUPERVISOR_SCHEMA_VERSION, isSupervisorDirective, issueSupervisorDirective, listSupervisorCheckpoints } from "../lib/local-apply/supervision.js";
import { getOwnedApplication } from "../lib/local-artifact/store.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}

async function storedSettings(c: C, instanceId: string, uid: string): Promise<unknown> {
	const pair = await readInstanceConfigPair(c.env, instanceId, uid);
	return (pair?.config as Record<string, unknown> | undefined)?.[RUNNER_SETTINGS_KEY];
}

async function ownedRun(c: C) {
	const { uid, instanceId } = await owned(c);
	const run = await getApplyRun(c.env, instanceId, uid, c.req.param("runId") ?? "");
	if (!run) throw new HttpError(404, "Application run not found");
	return { uid, instanceId, run };
}

export function registerApplicationRunnerRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/application-runner/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const effective = effectiveRunnerSettings(await storedSettings(c, instanceId, uid));
		return c.json("error" in effective ? { settings: RUNNER_DEFAULTS, error: effective.error } : { settings: effective.settings });
	});

	/** Patch semantics: only the fields sent change. Auto-submit stays off until `autoSubmit.enabled` is sent true. */
	router.put("/:instanceId/application-runner/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const current = effectiveRunnerSettings(await storedSettings(c, instanceId, uid));
		const merged = mergeRunnerSettings("error" in current ? RUNNER_DEFAULTS : current.settings, await c.req.json().catch(() => null));
		if ("error" in merged) return c.json({ error: merged.error }, 400);
		await patchInstanceConfig(c.env, instanceId, uid, RUNNER_SETTINGS_KEY, merged.settings);
		return c.json({ settings: merged.settings });
	});

	router.get("/:instanceId/application-runs", async (c) => {
		const { uid, instanceId } = await owned(c);
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
		const runs = await listApplyRuns(c.env, instanceId, uid, limit);
		return c.json({ runs, limit, ...(runs.length === limit ? { note: `Showing the newest ${limit}; pass ?limit= (max 200) to see more.` } : {}) });
	});

	/** Start filling from a materials_ready event — `{ event }`, or the event itself as the body. */
	router.post("/:instanceId/application-runs", async (c) => {
		const { uid, instanceId } = await owned(c);
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const event = body && typeof body.event === "object" ? body.event : body;
		const out = await startApplicationFill(c.env, instanceId, uid, event, "owner");
		return c.json({ outcome: out.kind, application: out.application, run: out.run }, out.kind === "existing" ? 200 : 201);
	});

	/** The run (pulled from the runner first), its application and the application's lifecycle audit. */
	router.get("/:instanceId/application-runs/:runId", async (c) => {
		const { uid, run: stored } = await ownedRun(c);
		const run = await syncApplyRun(c.env, uid, stored);
		const application = await getOwnedApplication(c.env, uid, run.applicationId);
		return c.json({ run, application, audit: application ? await applicationAudit(c.env, application.id, uid) : [] });
	});

	/** Release a pause — optionally with the owner's answers (`answers: [{question, answer}]`) or a newly allowed site. */
	router.post("/:instanceId/application-runs/:runId/resume", async (c) => {
		const { uid, run } = await ownedRun(c);
		return c.json({ run: await resumeApplyRun(c.env, uid, run, await c.req.json().catch(() => ({}))) });
	});

	router.post("/:instanceId/application-runs/:runId/cancel", async (c) => {
		const { uid, run } = await ownedRun(c);
		return c.json({ run: await cancelApplyRun(c.env, uid, run) });
	});

	/**
	 * Durable cloud-supervisor state. Reading first pulls the runner, so a just-emitted checkpoint
	 * is visible here without trusting a client to repeat it.
	 */
	router.get("/:instanceId/application-runs/:runId/supervision", async (c) => {
		const { uid, run: stored } = await ownedRun(c);
		const run = await syncApplyRun(c.env, uid, stored);
		return c.json({ schemaVersion: SUPERVISOR_SCHEMA_VERSION, run, checkpoints: await listSupervisorCheckpoints(c.env, run) });
	});

	/** Record one immutable directive for a runner-reported checkpoint, then ask the relay to deliver it. */
	router.post("/:instanceId/application-runs/:runId/supervision/checkpoints/:checkpointId/directives", async (c) => {
		const { uid, run: stored } = await ownedRun(c);
		const run = await syncApplyRun(c.env, uid, stored);
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const checkpointId = c.req.param("checkpointId") ?? "";
		if (!body || body.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || typeof body.idempotencyKey !== "string" || !isSupervisorDirective(body.directive)) {
			throw new HttpError(400, `body must be { schemaVersion: ${SUPERVISOR_SCHEMA_VERSION}, idempotencyKey, directive: "continue" | "request_review" | "stop" }`);
		}
		const outcome = await issueSupervisorDirective(c.env, run, uid, {
			checkpointId,
			schemaVersion: body.schemaVersion,
			idempotencyKey: body.idempotencyKey,
			directive: body.directive,
		}, Date.now());
		if (outcome.kind === "missing_checkpoint") throw new HttpError(404, "Supervisor checkpoint not found for this run");
		if (outcome.kind === "idempotency_conflict") throw new HttpError(409, "That idempotency key was already used for another supervisor directive");
		if (outcome.kind === "checkpoint_already_directed") throw new HttpError(409, "This supervisor checkpoint already has a directive");
		// Imported lazily to keep this route's durable-record decision visibly before the machine call.
		const { deliverSupervisorDirective } = await import("../lib/local-apply/apply.js");
		const directive = await deliverSupervisorDirective(c.env, uid, run, outcome.directive);
		return c.json({ schemaVersion: SUPERVISOR_SCHEMA_VERSION, outcome: outcome.kind, directive }, outcome.kind === "issued" ? 201 : 200);
	});
}
