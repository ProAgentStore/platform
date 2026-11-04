/** Missing facts are input requests, never submission approvals. Delivery is recoverable from durable state. */
import type { Env } from "../../types.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { getApplyRun, type ApplyRun } from "./store.js";
import { recordPauseDecision } from "../owner-decisions.js";
import { attentionDeps as defaultDeps } from "../applications/attention-deps.js";
import { attentionNotificationKey, attentionPushAllowed, requestOwnerAttention, type AttentionDeps, type OwnerAttentionRequest } from "../owner-attention.js";
import { readInstanceNotificationPolicy } from "../../routes/push.js";
import { resolveNotificationDelivery } from "../notification-policy.js";
import { clipMarked } from "../clip-marked.js";
import { redactText } from "../redact.js";

const REASONS = new Set(["missing_answer", "screening_ambiguity"]);
const LEASE_MS = 120_000;
interface Marker { kind: "input_attention"; key?: string; state: "leased" | "recorded" | "inapp_disabled" | "answered"; token?: string; until?: number; checkedAt: number }
const markerOf = (raw: string | null): Marker | null => { try { const value = JSON.parse(raw ?? "null"); return value?.kind === "input_attention" ? value : null; } catch { return null; } };
const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function notifyApplyInputRequired(env: Env, uid: string, input: ApplyRun, now = Date.now(), deps: AttentionDeps<Env> = defaultDeps): Promise<void> {
	const run = await getApplyRun(env, input.instanceId, uid, input.id);
	if (!run || (run.status !== "paused" && run.status !== "blocked")) return;
	const app = await getOwnedApplication(env, uid, run.applicationId);
	const reason = run.status === "paused" ? run.pause?.reason : (run.result as { blockReason?: string } | null)?.blockReason;
	if (!app || app.fillRunId !== run.id || app.status !== "blocked" || !reason || !REASONS.has(reason) || app.blockReason !== reason) return;
	const row = await env.DB.prepare("SELECT input_attention FROM local_apply_runs WHERE id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(run.id, uid, run.instanceId).first<{ input_attention: string | null }>();
	if (!row) return;
	const previous = row.input_attention;
	const mark = async (expected: string | null, next: Marker | null) => (await env.DB.prepare("UPDATE local_apply_runs SET input_attention = ?1 WHERE id = ?2 AND user_id = ?3 AND instance_id = ?4 AND input_attention IS ?5").bind(next ? JSON.stringify(next) : null, run.id, uid, run.instanceId, expected).run()).meta?.changes ?? 0;
	const decisions = await env.DB.prepare("SELECT question, answered_at FROM owner_decisions WHERE instance_id = ?1 AND user_id = ?2 AND subject_kind = 'apply_run' AND subject_id = ?3 AND task_id = ?4 ORDER BY asked_at DESC, rowid DESC").bind(run.instanceId, uid, app.id, run.id).all<{ question: string; answered_at: number | null }>();
	const latest = new Map<string, number | null>();
	for (const decision of decisions.results ?? []) if (!latest.has(decision.question)) latest.set(decision.question, decision.answered_at);
	const questions = [...new Set(app.blockQuestions.filter((q) => typeof q === "string" && q.trim() && (!latest.has(q) || latest.get(q) === null)))].sort();
	if (!questions.length) { await mark(previous, { kind: "input_attention", state: "answered", checkedAt: now }); return; }
	const key = await digest(JSON.stringify([app.id, run.id, questions]));
	const old = markerOf(previous);
	if (old?.state === "leased" && (old.until ?? 0) > now) return;
	const lease: Marker = { kind: "input_attention", key, state: "leased", token: crypto.randomUUID(), until: now + LEASE_MS, checkedAt: now };
	if (!(await mark(previous, lease))) return;
	const claimed = JSON.stringify(lease);
	try {
		// Claim before creating decisions so overlapping sweeps cannot duplicate the same unanswered question.
		for (const question of questions) if (!latest.has(question)) await recordPauseDecision(env, { instanceId: run.instanceId, userId: uid, kind: "apply_run", subjectId: app.id, taskId: run.id, scope: app.id, question, now });
		const stillCurrent = async () => {
			const currentRun = await getApplyRun(env, run.instanceId, uid, run.id);
			const currentReason = currentRun?.status === "paused" ? currentRun.pause?.reason : currentRun?.status === "blocked" ? (currentRun.result as { blockReason?: string } | null)?.blockReason : null;
			const current = await getOwnedApplication(env, uid, app.id);
			const answered = await env.DB.prepare("SELECT question FROM owner_decisions WHERE instance_id = ?1 AND user_id = ?2 AND subject_kind = 'apply_run' AND subject_id = ?3 AND task_id = ?4 AND answered_at IS NOT NULL").bind(run.instanceId, uid, app.id, run.id).all<{ question: string }>();
			const held = await env.DB.prepare("SELECT 1 FROM local_apply_runs WHERE id=?1 AND user_id=?2 AND instance_id=?3 AND input_attention=?4").bind(run.id, uid, run.instanceId, claimed).first();
			return Boolean(held && currentReason === reason && current?.fillRunId === run.id && current.status === "blocked" && current.blockReason === reason && JSON.stringify([...new Set(current.blockQuestions)].sort()) === JSON.stringify([...new Set(app.blockQuestions)].sort()) && !(answered.results ?? []).some((decision) => questions.includes(decision.question)));
		};
		if (!(await stillCurrent())) { await mark(claimed, null); return; }
		const lead = (app.lead ?? {}) as { lead?: { title?: string; company?: string } };
		const request: OwnerAttentionRequest = {
			event: "input_required", userId: uid, instanceId: run.instanceId,
			subject: { kind: "application", instanceId: run.instanceId, applicationId: app.id },
			about: { kind: "application-input", id: `${app.id}:${run.id}`, state: key }, notificationType: "apply",
			title: clipMarked(redactText(`Answers needed: ${lead.lead?.title ?? "your application"}${lead.lead?.company ? ` at ${lead.lead.company}` : ""}`), 120, { within: true }),
			body: clipMarked(redactText(`${questions.join("\n")}\nOpen this application to answer. This does not approve or submit it.`), 500, { within: true }),
		};
		const dedupeKey = attentionNotificationKey(request);
		const recorded = () => env.DB.prepare("SELECT 1 FROM notifications WHERE user_id = ?1 AND dedupe_key = ?2 LIMIT 1").bind(uid, dedupeKey).first();
		if (old?.key === key && (old.state === "recorded" || old.state === "inapp_disabled")) { await mark(claimed, { ...old, checkedAt: now }); return; }
		if (await recorded()) { await mark(claimed, { kind: "input_attention", key, state: "recorded", checkedAt: now }); return; }
		const prefs = await deps.preferences?.(env, uid);
		const policy = resolveNotificationDelivery({ type: "apply", severity: attentionPushAllowed(prefs?.attention, "input_required") ? "alert" : "update", event: "input_required", instanceId: run.instanceId }, { account: prefs?.notifications, instance: await readInstanceNotificationPolicy(env, run.instanceId, uid) });
		let stale = false;
		const outcome = await requestOwnerAttention(env, request, { ...deps, notify: async (...args) => {
			// Attention preferences can await while the owner answers or another run replaces this one.
			if (!(await stillCurrent())) { stale = true; return; }
			await deps.notify(...args);
		} });
		if (stale) { await mark(claimed, null); return; }
		// The shared sender intentionally swallows storage errors. A resolved call alone is not a receipt.
		if (policy.inapp.allowed && !(await recorded())) throw new Error("Input notification was not durably recorded");
		if (!outcome.recorded) throw new Error("Input attention delivery failed");
		await mark(claimed, { kind: "input_attention", key, state: policy.inapp.allowed ? "recorded" : "inapp_disabled", checkedAt: now });
	} catch (error) { await mark(claimed, null); throw error; }
}

/** Includes already-parked runs. This sweep reads durable state only; it never contacts or resumes a browser. */
export async function reconcileApplyInputAttention(env: Env, limit = 25, now = Date.now(), deps: AttentionDeps<Env> = defaultDeps): Promise<void> {
	const rows = await env.DB.prepare(`SELECT r.id, r.instance_id, r.user_id FROM local_apply_runs r JOIN job_applications a ON a.id = r.application_id AND a.user_id = r.user_id AND a.fill_run_id = r.id WHERE r.status IN ('paused','blocked') AND a.status = 'blocked' AND a.block_reason IN ('missing_answer','screening_ambiguity') ORDER BY CASE WHEN json_valid(r.input_attention) THEN COALESCE(json_extract(r.input_attention, '$.checkedAt'), 0) ELSE 0 END, r.id LIMIT ?1`).bind(Math.max(1, Math.min(100, limit))).all<{ id: string; instance_id: string; user_id: string }>();
	for (const row of rows.results ?? []) {
		const run = await getApplyRun(env, row.instance_id, row.user_id, row.id);
		if (run) await notifyApplyInputRequired(env, row.user_id, run, now, deps).catch(() => undefined);
	}
}
