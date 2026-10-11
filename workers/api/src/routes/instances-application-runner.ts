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
import { LOCAL_APPLY_HANDOFF_PATH, LOCAL_APPLY_HANDOFF_STATUS_PATH, LOCAL_APPLY_RECONCILIATION_HANDOFF_PATH, LOCAL_APPLY_RECONCILIATION_HANDOFF_STATUS_PATH, LOCAL_APPLY_RECONCILIATION_HANDOFF_FRAME_PATH, LOCAL_APPLY_RECONCILIATION_HANDOFF_INPUT_PATH, LOCAL_APPLY_RECONCILIATION_HANDOFF_RESUME_PATH, LOCAL_APPLY_RECONCILIATION_HANDOFF_END_PATH, LOCAL_APPLY_RECONCILIATION_RUN_PATH, type LocalApplyHandoffStatus, type LocalApplyReconciliationEnvelope, type LocalApplyReconciliationStatus } from "../lib/local-apply/contract.js";
import { RUNNER_DEFAULTS, RUNNER_SETTINGS_KEY, effectiveRunnerSettings, mergeRunnerSettings } from "../lib/local-apply/policy.js";
import {
	applicationAudit,
	createLocalApplyReconciliationHandoff,
	createLocalApplyHandoff,
	getApplyRun,
	getHandoffById,
	getLocalApplyHandoffForRun,
	getLocalApplyReconciliation,
	getLocalApplyReconciliationHandoff,
	getLocalApplyReconciliationHandoffById,
	markLocalApplyHandoff,
	markLocalApplyReconciliationHandoff,
	recordLocalApplyReconciliationProof,
	requestLocalApplyReconciliation,
	listApplyRuns,
	usableLocalApplyHandoff,
} from "../lib/local-apply/store.js";
import { SUPERVISOR_SCHEMA_VERSION, isSupervisorDirective, issueSupervisorDirective, listSupervisorCheckpoints } from "../lib/local-apply/supervision.js";
import { getOwnedApplication } from "../lib/local-artifact/store.js";
import { applicationHandoffLink, applicationReconciliationHandoffLink } from "../lib/console-links.js";
import type { Env } from "../types.js";
import { callRuntime, getLiveRuntime, requireOwnedInstance, runtimeJson } from "./instances-runtime.js";

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

const HANDOFF_TTL_MS = 10 * 60_000;
const runnerHandoffPath = (suffix: "frame" | "input" | "resume" | "end") => `/local-apply/handoff/${suffix}`;
const runnerReconciliationHandoffPath = (suffix: "frame" | "input" | "resume" | "end") => ({ frame: LOCAL_APPLY_RECONCILIATION_HANDOFF_FRAME_PATH, input: LOCAL_APPLY_RECONCILIATION_HANDOFF_INPUT_PATH, resume: LOCAL_APPLY_RECONCILIATION_HANDOFF_RESUME_PATH, end: LOCAL_APPLY_RECONCILIATION_HANDOFF_END_PATH })[suffix];

/** A Console/MCP-safe projection: opaque identity and lifecycle only, never site/browser state. */
function handoffView(handoff: {
	continuityId: string;
	runId: string;
	applicationId: string;
	state: "requested" | "ready" | "closed";
	expiresAt: number;
	terminalReason: string | null;
}, now = Date.now()) {
	return {
		id: handoff.continuityId,
		runId: handoff.runId,
		applicationId: handoff.applicationId,
		// `active` is intentionally a projection, not a durable success state.  A closed
		// view says nothing about whether an employer submission happened.
		state: (handoff.state === "requested" || handoff.state === "ready") && handoff.expiresAt > now ? "active" : "closed",
		expiresAt: new Date(handoff.expiresAt).toISOString(),
		reason: handoff.terminalReason,
	};
}

function handoffRequest(handoff: { continuityId: string; runId: string; applicationId: string; browserProfile: string }) {
	return { handoffId: handoff.continuityId, runId: handoff.runId, applicationId: handoff.applicationId, browserProfile: handoff.browserProfile };
}

function reconciliationHandoffRequest(handoff: { continuityId: string; reconciliationId: string; runId: string; applicationId: string; browserProfile: string }) {
	return { handoffId: handoff.continuityId, reconciliationId: handoff.reconciliationId, runId: handoff.runId, applicationId: handoff.applicationId, browserProfile: handoff.browserProfile };
}

function reconciliationEnvelope(reconciliation: { id: string; runId: string; applicationId: string; instanceId: string; jobIdentity: string; materialFingerprint: LocalApplyReconciliationEnvelope["materialFingerprint"] }, run: { policy: { browserProfile: string; allowDomains: string[] } }, app: { lead: unknown }): LocalApplyReconciliationEnvelope | null {
	const lead = (app.lead ?? {}) as { leadUrl?: unknown };
	const applicationUrl = typeof lead.leadUrl === "string" ? lead.leadUrl : "";
	if (!/^https?:\/\/[^\s/]+/i.test(applicationUrl) || (run.policy.browserProfile !== "default" && run.policy.browserProfile !== "isolated")) return null;
	return {
		type: "local_browser.apply.reconciliation",
		reconciliationId: reconciliation.id,
		runId: reconciliation.runId,
		instanceId: reconciliation.instanceId,
		applicationId: reconciliation.applicationId,
		browserProfile: run.policy.browserProfile,
		applicationUrl,
		allowDomains: run.policy.allowDomains,
		jobIdentity: reconciliation.jobIdentity,
		materialFingerprint: reconciliation.materialFingerprint,
	};
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

	/**
	 * Create (or read back) the one short-lived remote-control handoff for this still-live apply
	 * run.  The id returned is opaque; the page, browser profile and any login material never leave
	 * the runner. Only a live login/CAPTCHA pause can open one — a terminal uncertain attempt must instead use
	 * the separate, read-only reconciliation record below.
	 */
	router.post("/:instanceId/application-runs/:runId/handoff", async (c) => {
		const { uid, instanceId, run: stored } = await ownedRun(c);
		const run = await syncApplyRun(c.env, uid, stored);
		const app = await getOwnedApplication(c.env, uid, run.applicationId);
		if (!app || app.fillRunId !== run.id) throw new HttpError(409, "This application is no longer bound to that exact Runner run.");
		if (run.status !== "paused" || !(["login_required", "captcha"] as const).includes(run.pause?.reason as "login_required" | "captcha")) {
			throw new HttpError(409, "A live browser handoff is available only while this exact run is paused for site login or a CAPTCHA.");
		}
		const now = Date.now();
		let handoff = await createLocalApplyHandoff(c.env, { run, app, userId: uid, browserProfile: run.policy.browserProfile, expiresAt: now + HANDOFF_TTL_MS }, now);
		if (!handoff) throw new HttpError(409, "The handoff could not be bound to this application run.");
		if (!usableLocalApplyHandoff(handoff, now)) return c.json({ handoff: handoffView(handoff, now) }, 409);
		const runtime = await getLiveRuntime(c.env, instanceId, uid).catch(() => null);
		if (!runtime) {
			await markLocalApplyHandoff(c.env, { continuityId: handoff.continuityId, instanceId, userId: uid, state: "closed", terminalReason: "runner_restarted" }, now);
			throw new HttpError(409, "The Runner is disconnected; this handoff is closed rather than treated as complete.");
		}
		const path = handoff.state === "requested" ? LOCAL_APPLY_HANDOFF_PATH : LOCAL_APPLY_HANDOFF_STATUS_PATH;
		const res = await callRuntime(c.env, runtime, path, { method: "POST", body: JSON.stringify(handoffRequest(handoff)) }).catch(() => null);
		if (!res) {
			await markLocalApplyHandoff(c.env, { continuityId: handoff.continuityId, instanceId, userId: uid, state: "closed", terminalReason: "runner_restarted" }, now);
			throw new HttpError(409, "The Runner did not answer; this handoff is closed rather than treated as complete.");
		}
		const body = (await runtimeJson(res)) as LocalApplyHandoffStatus & { error?: string };
		if (!res.ok || body.state !== "ready") {
			const terminal = body.terminalReason ?? "unavailable";
			handoff = (await markLocalApplyHandoff(c.env, { continuityId: handoff.continuityId, instanceId, userId: uid, state: "closed", terminalReason: terminal }, now)) ?? handoff;
			return c.json({ handoff: handoffView(handoff, now) }, 409);
		}
		handoff = (await markLocalApplyHandoff(c.env, { continuityId: handoff.continuityId, instanceId, userId: uid, state: "ready" }, now)) ?? handoff;
		return c.json({ handoff: handoffView(handoff, now), consoleLink: applicationHandoffLink(instanceId, handoff.continuityId) }, 201);
	});

	/** Resolve only the opaque canonical Console link, still scoped to its owner and Runner. */
	router.get("/:instanceId/application-handoffs/:handoffId", async (c) => {
		const { uid, instanceId } = await owned(c);
		const handoff = await getHandoffById(c.env, instanceId, uid, c.req.param("handoffId") ?? "");
		if (!handoff) throw new HttpError(404, "Application handoff not found");
		const now = Date.now();
		if ((handoff.state === "requested" || handoff.state === "ready") && handoff.expiresAt <= now) {
			const closed = await markLocalApplyHandoff(c.env, { continuityId: handoff.continuityId, instanceId, userId: uid, state: "closed", terminalReason: "expired" }, now);
			return c.json(closed ? handoffView(closed, now) : handoffView(handoff, now));
		}
		return c.json(handoffView(handoff, now));
	});

	/** Read-only state for the exact current run; no browser frame or URL is returned here. */
	router.get("/:instanceId/application-runs/:runId/handoff", async (c) => {
		const { uid, instanceId, run } = await ownedRun(c);
		const handoff = await getLocalApplyHandoffForRun(c.env, run.id, instanceId, uid);
		if (!handoff) throw new HttpError(404, "Application handoff not found");
		if (c.req.query("handoff_id") !== handoff.continuityId) throw new HttpError(404, "Application handoff not found");
		return c.json({ handoff: handoffView(handoff) });
	});

	/** Relay a scoped live-view operation after re-checking owner, run and opaque continuity id. */
	const relayHandoff = (suffix: "frame" | "input" | "resume" | "end") => async (c: C) => {
		const { uid, instanceId, run } = await ownedRun(c);
		const continuityId = c.req.query("handoff_id") ?? "";
		const handoff = await getLocalApplyHandoffForRun(c.env, run.id, instanceId, uid);
		if (!handoff || handoff.continuityId !== continuityId) throw new HttpError(404, "Application handoff not found");
		const now = Date.now();
		if (!usableLocalApplyHandoff(handoff, now)) throw new HttpError(409, `This application handoff is closed (${handoff.terminalReason ?? handoff.state}).`);
		const runtime = await getLiveRuntime(c.env, instanceId, uid).catch(() => null);
		if (!runtime) {
			await markLocalApplyHandoff(c.env, { continuityId, instanceId, userId: uid, state: "closed", terminalReason: "runner_restarted" }, now);
			throw new HttpError(409, "The Runner is disconnected; this handoff is closed rather than complete.");
		}
		const request = suffix === "input" ? await c.req.json().catch(() => null) : {};
		if (suffix === "input" && (!request || typeof request !== "object" || Array.isArray(request))) throw new HttpError(400, "A browser input event is required.");
		const res = await callRuntime(c.env, runtime, runnerHandoffPath(suffix), {
			method: "POST",
			body: JSON.stringify({ ...handoffRequest(handoff), ...(suffix === "input" ? { input: request } : {}) }),
		}).catch(() => null);
		if (!res) {
			await markLocalApplyHandoff(c.env, { continuityId, instanceId, userId: uid, state: "closed", terminalReason: "runner_restarted" }, now);
			throw new HttpError(409, "The Runner did not answer; this handoff is closed rather than complete.");
		}
		const payload = await runtimeJson(res);
		if (!res.ok) {
			await markLocalApplyHandoff(c.env, { continuityId, instanceId, userId: uid, state: "closed", terminalReason: "page_lost" }, now);
			throw new HttpError(409, "The live handoff page is no longer available.");
		}
		if (suffix === "end") await markLocalApplyHandoff(c.env, { continuityId, instanceId, userId: uid, state: "closed", terminalReason: "unavailable" }, now);
		if (suffix === "resume") {
			await markLocalApplyHandoff(c.env, { continuityId, instanceId, userId: uid, state: "closed", terminalReason: "unavailable" }, now);
			return c.json({ run: await resumeApplyRun(c.env, uid, run, {}) });
		}
		return c.json(payload);
	};
	router.get("/:instanceId/application-runs/:runId/handoff/frame", relayHandoff("frame"));
	router.post("/:instanceId/application-runs/:runId/handoff/input", relayHandoff("input"));
	router.post("/:instanceId/application-runs/:runId/handoff/resume", relayHandoff("resume"));
	router.post("/:instanceId/application-runs/:runId/handoff/end", relayHandoff("end"));

	/** A request only: results can be recorded solely by a runner-authoritative reconciliation path. */
	router.get("/:instanceId/application-runs/:runId/reconciliation", async (c) => {
		const { uid, instanceId, run } = await ownedRun(c);
		return c.json({ reconciliation: await getLocalApplyReconciliation(c.env, run.id, instanceId, uid) });
	});
	router.post("/:instanceId/application-runs/:runId/reconciliation", async (c) => {
		const { uid, instanceId, run } = await ownedRun(c);
		const app = await getOwnedApplication(c.env, uid, run.applicationId);
		if (!app) throw new HttpError(404, "Application not found");
		const reconciliation = await requestLocalApplyReconciliation(c.env, { app, run, userId: uid }, Date.now());
		if (!reconciliation) throw new HttpError(409, "Read-only reconciliation is available only for this exact ended submit_unconfirmed attempt.");
		const envelope = reconciliationEnvelope(reconciliation, run, app);
		if (!envelope) throw new HttpError(409, "The exact application URL/profile binding is unavailable for read-only reconciliation.");
		const runtime = await getLiveRuntime(c.env, instanceId, uid).catch(() => null);
		// The durable request is intentional when the owner's machine is disconnected. It is not a
		// result, and a later explicit request remains idempotent with the same exact binding.
		if (!runtime) return c.json({ reconciliation, runner: { state: "waiting_for_runtime" } }, 202);
		const res = await callRuntime(c.env, runtime, LOCAL_APPLY_RECONCILIATION_RUN_PATH, { method: "POST", body: JSON.stringify(envelope) }).catch(() => null);
		if (!res) return c.json({ reconciliation, runner: { state: "waiting_for_runtime" } }, 202);
		const status = (await runtimeJson(res)) as LocalApplyReconciliationStatus & { error?: string };
		if (!res.ok || status.reconciliationId !== reconciliation.id || status.runId !== run.id || status.applicationId !== app.id) {
			throw new HttpError(409, "The Runner rejected this exact read-only reconciliation binding.");
		}
		if (status.state !== "ended" || !status.result) return c.json({ reconciliation, runner: { state: status.state, pauseReason: status.pauseReason } }, 202);
		const recorded = await recordLocalApplyReconciliationProof(c.env, {
			reconciliation,
			app,
			run,
			userId: uid,
			state: status.result.state,
			proofKind: status.result.proofKind,
			actor: "runner",
		}, Date.now());
		return c.json({ reconciliation: recorded ?? reconciliation, runner: { state: status.state } }, recorded ? 201 : 200);
	});

	/** Open only the separately-authorized, read-only browser when reconciliation paused for login/CAPTCHA. */
	router.post("/:instanceId/application-runs/:runId/reconciliation/handoff", async (c) => {
		const { uid, instanceId, run } = await ownedRun(c);
		const app = await getOwnedApplication(c.env, uid, run.applicationId);
		const reconciliation = await getLocalApplyReconciliation(c.env, run.id, instanceId, uid);
		if (!app || !reconciliation || reconciliation.state !== "requested") throw new HttpError(409, "No pending exact-attempt reconciliation can open a browser handoff.");
		const now = Date.now();
		let handoff = await createLocalApplyReconciliationHandoff(c.env, { reconciliation, run, app, userId: uid, browserProfile: run.policy.browserProfile, expiresAt: now + HANDOFF_TTL_MS }, now);
		if (!handoff) throw new HttpError(409, "The reconciliation handoff could not be bound to this exact attempt.");
		const runtime = await getLiveRuntime(c.env, instanceId, uid).catch(() => null);
		if (!runtime) throw new HttpError(409, "The Runner is disconnected; the pending reconciliation remains unresolved.");
		const path = handoff.state === "requested" ? LOCAL_APPLY_RECONCILIATION_HANDOFF_PATH : LOCAL_APPLY_RECONCILIATION_HANDOFF_STATUS_PATH;
		const res = await callRuntime(c.env, runtime, path, { method: "POST", body: JSON.stringify(reconciliationHandoffRequest(handoff)) }).catch(() => null);
		const status = res ? (await runtimeJson(res)) as LocalApplyReconciliationStatus : null;
		if (!res?.ok || status?.state !== "paused") {
			handoff = (await markLocalApplyReconciliationHandoff(c.env, { continuityId: handoff.continuityId, reconciliationId: reconciliation.id, instanceId, userId: uid, state: "closed", terminalReason: "page_lost" }, now)) ?? handoff;
			return c.json({ handoff: handoffView(handoff, now) }, 409);
		}
		handoff = (await markLocalApplyReconciliationHandoff(c.env, { continuityId: handoff.continuityId, reconciliationId: reconciliation.id, instanceId, userId: uid, state: "ready" }, now)) ?? handoff;
		return c.json({ handoff: handoffView(handoff, now), consoleLink: applicationReconciliationHandoffLink(instanceId, handoff.continuityId) }, 201);
	});

	router.get("/:instanceId/application-runs/:runId/reconciliation/handoff", async (c) => {
		const { uid, instanceId, run } = await ownedRun(c);
		const reconciliation = await getLocalApplyReconciliation(c.env, run.id, instanceId, uid);
		const handoff = reconciliation ? await getLocalApplyReconciliationHandoff(c.env, reconciliation.id, instanceId, uid) : null;
		if (!handoff || c.req.query("handoff_id") !== handoff.continuityId) throw new HttpError(404, "Reconciliation handoff not found");
		return c.json({ handoff: handoffView(handoff) });
	});

	/** Canonical opaque Console resolver for a reconciliation-only browser handoff. */
	router.get("/:instanceId/application-reconciliation-handoffs/:handoffId", async (c) => {
		const { uid, instanceId } = await owned(c);
		const handoff = await getLocalApplyReconciliationHandoffById(c.env, instanceId, uid, c.req.param("handoffId") ?? "");
		if (!handoff) throw new HttpError(404, "Reconciliation handoff not found");
		return c.json(handoffView(handoff));
	});

	const relayReconciliationHandoff = (suffix: "frame" | "input" | "resume" | "end") => async (c: C) => {
		const { uid, instanceId, run } = await ownedRun(c);
		const reconciliation = await getLocalApplyReconciliation(c.env, run.id, instanceId, uid);
		const handoff = reconciliation ? await getLocalApplyReconciliationHandoff(c.env, reconciliation.id, instanceId, uid) : null;
		if (!reconciliation || !handoff || handoff.continuityId !== (c.req.query("handoff_id") ?? "") || handoff.state !== "ready" || handoff.expiresAt <= Date.now()) throw new HttpError(409, "This reconciliation handoff is closed.");
		const runtime = await getLiveRuntime(c.env, instanceId, uid).catch(() => null);
		if (!runtime) throw new HttpError(409, "The Runner is disconnected; the reconciliation remains unresolved.");
		const input = suffix === "input" ? await c.req.json().catch(() => null) : undefined;
		if (suffix === "input" && (!input || typeof input !== "object" || Array.isArray(input))) throw new HttpError(400, "A browser input event is required.");
		const res = await callRuntime(c.env, runtime, runnerReconciliationHandoffPath(suffix), { method: "POST", body: JSON.stringify({ ...reconciliationHandoffRequest(handoff), ...(input ? { input } : {}) }) }).catch(() => null);
		if (!res?.ok) {
			await markLocalApplyReconciliationHandoff(c.env, { continuityId: handoff.continuityId, reconciliationId: reconciliation.id, instanceId, userId: uid, state: "closed", terminalReason: "page_lost" }, Date.now());
			throw new HttpError(409, "The read-only reconciliation browser is no longer available.");
		}
		const payload = await runtimeJson(res) as LocalApplyReconciliationStatus;
		if (suffix === "end") await markLocalApplyReconciliationHandoff(c.env, { continuityId: handoff.continuityId, reconciliationId: reconciliation.id, instanceId, userId: uid, state: "closed", terminalReason: "unavailable" }, Date.now());
		if (suffix === "resume" && payload.state === "ended" && payload.result) {
			const app = await getOwnedApplication(c.env, uid, run.applicationId);
			if (!app) throw new HttpError(404, "Application not found");
			await recordLocalApplyReconciliationProof(c.env, { reconciliation, app, run, userId: uid, state: payload.result.state, proofKind: payload.result.proofKind, actor: "runner" }, Date.now());
			await markLocalApplyReconciliationHandoff(c.env, { continuityId: handoff.continuityId, reconciliationId: reconciliation.id, instanceId, userId: uid, state: "closed", terminalReason: "unavailable" }, Date.now());
		}
		return c.json(payload);
	};
	router.get("/:instanceId/application-runs/:runId/reconciliation/handoff/frame", relayReconciliationHandoff("frame"));
	router.post("/:instanceId/application-runs/:runId/reconciliation/handoff/input", relayReconciliationHandoff("input"));
	router.post("/:instanceId/application-runs/:runId/reconciliation/handoff/resume", relayReconciliationHandoff("resume"));
	router.post("/:instanceId/application-runs/:runId/reconciliation/handoff/end", relayReconciliationHandoff("end"));

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
