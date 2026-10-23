import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { type CoderBrainSettings, PO_TRIAGE_ACTION, coderBrainPatchProblem, readCoderBrain, setCoderBrain } from "../lib/coder-brain.js";
import { type CoderQuestionState, listCoderQuestions } from "../lib/coder-question-store.js";
import { brainModelRefusal, writeInstanceBrain } from "../lib/instance-brain.js";
import { DEFAULT_PILOT_MODEL, PILOT_MODEL_OPTIONS, pilotModelProblem, readPilotModel, setPilotModel } from "../lib/pilot-model.js";
import { autoPickupPatchProblem, readAutoPickup, setAutoPickup } from "../lib/auto-pickup.js";
import { BUILTIN_EXCLUDE_LABELS } from "../lib/label-vocabulary.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

const PATCH_KEYS = ["enabled", "poEnabled", "model", "humanTimeoutMinutes", "escalationTimeoutMinutes", "maxDecisionsPerRun", "confidenceThreshold"] as const;
const QUESTION_STATES: readonly CoderQuestionState[] = ["waiting_human", "brain_deciding", "answered_human", "answered_brain", "escalated", "unresolved", "expired"];

/** The coder brain switch (#1025 §1) and the product-owner triage reports it gates (#1027). */
export function registerCoderBrainRoutes(router: Hono<{ Bindings: Env }>): void {
	const owned = async (c: Context<{ Bindings: Env }>) => {
		const s = await requireUser(c);
		const instanceId = c.req.param("instanceId") ?? "";
		await requireOwnedInstance(c.env, instanceId, s.uid);
		return { instanceId, uid: s.uid };
	};
	const view = async (env: Env, instanceId: string, uid: string) => {
		const { results } = await env.DB.prepare("SELECT id, name, schedule, enabled, config, next_run_at, last_run_at FROM agent_triggers WHERE instance_id = ?1 AND user_id = ?2 AND action = ?3 ORDER BY created_at")
			.bind(instanceId, uid, PO_TRIAGE_ACTION)
			.all<{ id: string; name: string; schedule: string | null; enabled: number; config: string | null; next_run_at: string | null; last_run_at: string | null }>();
		return {
			settings: await readCoderBrain(env, instanceId, uid),
			pilot: { model: await readPilotModel(env, instanceId, uid), fallbackModel: DEFAULT_PILOT_MODEL, options: PILOT_MODEL_OPTIONS },
			triggers: (results ?? []).map((t) => ({ id: t.id, name: t.name, schedule: t.schedule, enabled: !!t.enabled, config: t.config ? JSON.parse(t.config) : {}, nextRunAt: t.next_run_at, lastRunAt: t.last_run_at })),
		};
	};

	router.get("/:instanceId/coder-brain", async (c) => {
		const { instanceId, uid } = await owned(c);
		return c.json(await view(c.env, instanceId, uid));
	});

	/**
	 * The one writer (`set_coder_brain`). The brain and the PO layer act on coding runs, so turning
	 * either on needs a coding instance. #1025's knobs ride the same patch, validated by the writer.
	 */
	router.put("/:instanceId/coder-brain", async (c) => {
		const { instanceId, uid } = await owned(c);
		const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const patch = Object.fromEntries(PATCH_KEYS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) as Partial<CoderBrainSettings>;
		const problem = coderBrainPatchProblem(patch);
		if (problem) throw new HttpError(400, problem);
		if (b.pilotModel !== undefined) {
			const pilotProblem = pilotModelProblem(b.pilotModel);
			if (pilotProblem) throw new HttpError(400, pilotProblem);
		}
		// #1061: a triage trigger this call creates is live unless the caller asks for a dry run.
		if (b.poDryRun !== undefined && typeof b.poDryRun !== "boolean") throw new HttpError(400, "poDryRun must be true or false");
		// `model` is this coder's Brain (#1043): the same check and the same store as the Brain card's
		// `PUT /state`. It touches no engine preset, sign-in or API-coding confirmation.
		if (patch.model !== undefined) {
			const refusal = await brainModelRefusal(c.env, uid, patch.model);
			if (refusal) throw new HttpError(refusal.status, refusal.error);
		}
		if (patch.enabled === true || patch.poEnabled === true || b.pilotModel !== undefined) {
			const caps = await capabilitiesForInstance(c.env, instanceId, uid).catch(() => null);
			if (caps?.workflow !== "CODING_SESSION") throw new HttpError(409, "The coder brain and Pilot act on coding runs, so they need a coding instance (a Repo Coder).");
		}
		if (patch.model !== undefined) await writeInstanceBrain(c.env, instanceId, patch.model);
		if (b.pilotModel !== undefined) await setPilotModel(c.env, instanceId, uid, b.pilotModel);
		// A Pilot-only update must not normalise brain flags or resynchronise its triage triggers.
		const { triggers } = Object.keys(patch).length || b.pilotModel === undefined
			? await setCoderBrain(c.env, instanceId, uid, patch, { poDryRun: b.poDryRun === true })
			: { triggers: { created: null, enabled: 0, disabled: 0 } };
		return c.json({ ...(await view(c.env, instanceId, uid)), changed: triggers });
	});

	/**
	 * Brain-free auto-pickup (#1233): read the switch and what it last decided; change it (`set_auto_pickup`).
	 * Independent of the brain — with the brain's triage on, triage picks and this stays idle.
	 */
	const pickupView = async (env: Env, instanceId: string, uid: string) => {
		const { results } = await env.DB.prepare("SELECT repo, issue_number, outcome, detail, created_at FROM auto_pickup_log WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 10")
			.bind(instanceId, uid)
			.all<{ repo: string | null; issue_number: number | null; outcome: string; detail: string | null; created_at: number }>();
		const brain = await readCoderBrain(env, instanceId, uid);
		return {
			settings: await readAutoPickup(env, instanceId, uid),
			builtinExcludeLabels: BUILTIN_EXCLUDE_LABELS,
			activeWhenQueueEmpties: brain?.poEnabled ? "triage" : "auto_pickup",
			recent: (results ?? []).map((r) => ({ repo: r.repo, issue: r.issue_number, outcome: r.outcome, detail: r.detail, at: r.created_at })),
		};
	};
	router.get("/:instanceId/auto-pickup", async (c) => {
		const { instanceId, uid } = await owned(c);
		return c.json(await pickupView(c.env, instanceId, uid));
	});
	router.put("/:instanceId/auto-pickup", async (c) => {
		const { instanceId, uid } = await owned(c);
		const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const problem = autoPickupPatchProblem(patch);
		if (problem) throw new HttpError(400, problem);
		if (patch.enabled === true) {
			const caps = await capabilitiesForInstance(c.env, instanceId, uid).catch(() => null);
			if (caps?.workflow !== "CODING_SESSION") throw new HttpError(409, "Auto-pickup starts coding runs, so it needs a coding instance (a Repo Coder).");
		}
		await setAutoPickup(c.env, instanceId, uid, patch);
		return c.json(await pickupView(c.env, instanceId, uid));
	});

	/** #1025: the questions this coder parked on, each with its full state history (the audit trail). */
	router.get("/:instanceId/coder-questions", async (c) => {
		const { instanceId, uid } = await owned(c);
		const q = new URL(c.req.url).searchParams;
		const state = q.get("state");
		if (state && !(QUESTION_STATES as readonly string[]).includes(state)) throw new HttpError(400, `state must be one of ${QUESTION_STATES.join(", ")}.`);
		return c.json({ settings: await readCoderBrain(c.env, instanceId, uid), questions: await listCoderQuestions(c.env, instanceId, uid, { state: (state as CoderQuestionState) || undefined, limit: Number(q.get("limit")) || 20 }) });
	});

	router.get("/:instanceId/po-triage/reports", async (c) => {
		const { instanceId, uid } = await owned(c);
		const limit = Math.min(Math.max(Number(new URL(c.req.url).searchParams.get("limit")) || 10, 1), 50);
		const { results } = await c.env.DB.prepare(
			"SELECT id, trigger_id, trigger_source, slot, dry_run, status, report, digest, error, created_at FROM po_triage_reports WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT ?3",
		)
			.bind(instanceId, uid, limit)
			.all<{ id: string; trigger_id: string | null; trigger_source: string; slot: string; dry_run: number; status: string; report: string | null; digest: string | null; error: string | null; created_at: string }>();
		return c.json({
			...(await view(c.env, instanceId, uid)),
			reports: (results ?? []).map((r) => ({ id: r.id, triggerId: r.trigger_id, source: r.trigger_source, slot: r.slot, dryRun: !!r.dry_run, status: r.status, digest: r.digest, error: r.error, createdAt: r.created_at, report: r.report ? JSON.parse(r.report) : null })),
		});
	});
}
