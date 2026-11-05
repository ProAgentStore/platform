import { HttpError } from "../auth.js";
import type { Env } from "../../types.js";
import { getOwnedApplication, type JobApplication } from "../local-artifact/store.js";
import { getApplyRun, moveApplication, type ApplyRun } from "./store.js";

export interface FinalAnswerWait { kind: "final_review"; expiresAt: number; budgetMs: number; questions: string[] }
export const finalAnswerAuditReason = (key: string): string => `final_answer_pause:${key}`;

export async function finalAnswerPauseWasMirrored(env: Pick<Env, "DB">, uid: string, app: Pick<JobApplication, "id" | "stateVersion"> | null, runId: string, key: string | undefined): Promise<boolean> {
	return !!app && !!key && !!await env.DB.prepare("SELECT 1 AS ok FROM job_application_events WHERE application_id = ?1 AND user_id = ?2 AND version = ?3 AND run_id = ?4 AND reason = ?5").bind(app.id, uid, app.stateVersion, runId, finalAnswerAuditReason(key)).first();
}

export async function finalAnswerMirrorState(env: Pick<Env, "DB">, uid: string, run: ApplyRun, key: string | undefined) {
	const app = await getOwnedApplication(env, uid, run.applicationId);
	return { app, mirrored: await finalAnswerPauseWasMirrored(env, uid, app, run.id, key) };
}

export async function mirrorFinalAnswerPause(env: Pick<Env, "DB">, uid: string, app: JobApplication | null, run: ApplyRun, questions: string[], now: number): Promise<void> {
	if (app && ["filling", "blocked"].includes(app.status)) await moveApplication(env, app, uid, { actor: "runner", actorInstanceId: run.instanceId, runId: run.id, expectRun: run.id, to: "blocked", reason: run.pause!.reason, auditReason: finalAnswerAuditReason(run.pause!.handoffRequestId!), questions }, now);
}

/** Preserve exact question identities; a malformed receipt must never become a legacy answer pause. */
export function parseFinalAnswerWait(raw: unknown): FinalAnswerWait | null {
	const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	if (o.kind !== "final_review" || !Number.isSafeInteger(o.expiresAt) || (o.expiresAt as number) <= 0 || !Number.isSafeInteger(o.budgetMs) || (o.budgetMs as number) <= 0 || !Array.isArray(o.questions) || !o.questions.length || o.questions.length > 20 || o.questions.some(q => typeof q !== "string" || !q.trim() || q.length > 300) || new Set(o.questions).size !== o.questions.length) return null;
	return { kind: "final_review", expiresAt: o.expiresAt as number, budgetMs: o.budgetMs as number, questions: [...o.questions] as string[] };
}

/** A pause key identifies immutable questions and one absolute lease, including across retries. */
export function readFinalAnswerWait(rawPause: Record<string, unknown> | null, previous: ApplyRun["pause"]): FinalAnswerWait | null {
	const raw = rawPause?.answerWait;
	const wait = parseFinalAnswerWait(raw);
	const prior = parseFinalAnswerWait(previous?.answerWait);
	const sameEpoch = !!previous?.answerWait && rawPause?.handoffRequestId === previous.handoffRequestId;
	if (raw !== undefined && (!wait || rawPause?.reason !== "missing_answer" || typeof rawPause.handoffRequestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(rawPause.handoffRequestId))) throw new HttpError(409, "The Runner sent an invalid final-answer pause. Its previous verified pause was retained; no answers were applied.");
	if (sameEpoch && (!wait || !prior || prior.expiresAt !== wait.expiresAt || prior.budgetMs !== wait.budgetMs || prior.questions.length !== wait.questions.length || prior.questions.some((question, i) => question !== wait.questions[i]))) throw new HttpError(409, "The Runner changed a final-answer pause without a new key. Its previous verified pause was retained.");
	return wait;
}

/** New retained final-review pauses need a current application version AND the exact runner epoch. */
export async function assertFinalAnswerResume(env: Pick<Env, "DB">, uid: string, run: ApplyRun, body: Record<string, unknown>, answers: Array<{ question: string; answer: string }>, now: number): Promise<void> {
	const raw = run.pause?.answerWait;
	if (raw === undefined) return;
	const wait = parseFinalAnswerWait(raw);
	if (!wait || run.status !== "paused" || run.pause?.reason !== "missing_answer" || !run.pause.handoffRequestId) throw new HttpError(409, "This final-answer pause could not be verified. Reload the application.");
	const expectedVersion = body.expected_version ?? body.expectedVersion;
	if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) throw new HttpError(400, "expected_version is required for a retained final-answer pause.");
	if (body.expectedAnswerPauseKey !== run.pause.handoffRequestId) throw new HttpError(409, "stale: the final-answer pause changed; reload its exact questions.");
	if (wait.expiresAt <= now) throw new HttpError(409, "This final-answer wait expired. Answers cannot resume its browser.");
	if (!answers.length || new Set(answers.map(a => a.question)).size !== answers.length || answers.some(a => !wait.questions.includes(a.question) || !a.answer.trim())) throw new HttpError(400, "Supply distinct, non-empty answers matching this exact final-answer pause's questions.");
	const app = await getOwnedApplication(env, uid, run.applicationId);
	const current = await getApplyRun(env, run.instanceId, uid, run.id);
	const currentWait = parseFinalAnswerWait(current?.pause?.answerWait);
	if (!app || app.fillRunId !== run.id || app.status !== "blocked" || app.blockReason !== "missing_answer" || app.stateVersion !== expectedVersion || current?.status !== "paused" || current.pause?.handoffRequestId !== run.pause.handoffRequestId || !currentWait || currentWait.expiresAt !== wait.expiresAt || answers.some(a => !currentWait.questions.includes(a.question)) || !await finalAnswerPauseWasMirrored(env, uid, app, run.id, run.pause.handoffRequestId)) throw new HttpError(409, "stale: this application or its final-answer pause changed. Reload and decide again.");
}
