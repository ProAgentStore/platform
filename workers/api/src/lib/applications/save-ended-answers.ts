/** Owner answers outlive a browser run; saving them never starts another run (#1540). */
import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import type { JobApplication } from "../local-artifact/store.js";
import type { ApplyRun } from "../local-apply/store.js";
import { MAX_DECISION_ANSWER_CHARS, type DecisionVia } from "../owner-decisions.js";

export function canSaveEndedAnswers(app: JobApplication, run: ApplyRun | null): run is ApplyRun {
	return app.status === "blocked" && app.blockQuestions.length > 0 && run?.status === "blocked" && run.id === app.fillRunId && run.applicationId === app.id;
}

export async function saveEndedAnswers(env: Pick<Env, "DB">, app: JobApplication, run: ApplyRun, input: { userId: string; expectedVersion?: number; answers?: Array<{ question: string; answer: string }>; allowDomains?: string[]; via: DecisionVia }, now = Date.now()): Promise<Record<string, unknown>> {
	if (!canSaveEndedAnswers(app, run)) throw new HttpError(409, "This application has no ended fill with questions to answer.");
	if (input.expectedVersion === undefined) throw new HttpError(400, "expected_version is required when saving answers for an ended run.");
	if (input.expectedVersion !== app.stateVersion) throw new HttpError(409, "stale: reload the application before saving answers.");
	if (input.allowDomains?.length) throw new HttpError(409, "An ended run cannot receive a website grant. Save answers without allow_domains.");
	const answers = input.answers ?? [];
	if (!answers.length || answers.length > 20) throw new HttpError(400, "Supply between 1 and 20 answers to this application's recorded questions.");
	const seen = new Set<string>();
	for (const a of answers) {
		if (!a || typeof a.question !== "string" || !app.blockQuestions.includes(a.question) || seen.has(a.question) || typeof a.answer !== "string" || !a.answer.trim() || a.answer.trim().length > MAX_DECISION_ANSWER_CHARS) throw new HttpError(400, "Each answer must name a distinct recorded question and contain 1–2000 characters.");
		seen.add(a.question);
	}
	// Every insert and the final version update share a D1 transaction and the same owner/run/version
	// fence. A concurrent retry, answer, or state change makes the entire batch a no-op.
	const fence = `EXISTS (SELECT 1 FROM job_applications a JOIN local_apply_runs r ON r.id = a.fill_run_id
	 WHERE a.id = ?1 AND a.user_id = ?2 AND a.state_version = ?3 AND a.status = 'blocked'
	 AND r.id = ?4 AND r.user_id = ?2 AND r.application_id = a.id AND r.instance_id = ?5 AND r.status = 'blocked')`;
	const binding = [app.id, input.userId, input.expectedVersion, run.id, run.instanceId];
	const statements = answers.flatMap((a) => {
		const id = crypto.randomUUID();
		return [env.DB.prepare(`UPDATE owner_decisions SET applied_at = ?6, applied_ref = ?7, history = json_insert(history, '$[#]', json(?8))
	 WHERE instance_id = ?5 AND user_id = ?2 AND subject_kind = 'apply_run' AND scope = ?1 AND question = ?9 AND applied_at IS NULL AND ${fence}`)
			.bind(...binding, now, `superseded:${id}`, JSON.stringify({ at: now, note: `superseded by owner answer ${id}; not delivered to a browser` }), a.question), env.DB.prepare(`INSERT INTO owner_decisions
	 (id, instance_id, user_id, subject_kind, subject_id, task_id, scope, question, answer, answered_via, asked_at, answered_at, history)
	 SELECT ?6, ?5, ?2, 'apply_run', ?1, ?4, ?1, ?7, ?8, ?9, ?10, ?10, json_array(json(?11)) WHERE ${fence}`)
			.bind(...binding, id, a.question, a.answer.trim(), input.via, now, JSON.stringify({ at: now, note: `answered (${input.via}); saved for a separately authorized next run` }))];
	});
	statements.push(env.DB.prepare(`INSERT INTO job_application_events
	 (id, application_id, instance_id, user_id, version, from_status, to_status, actor, actor_instance_id, run_id, reason, created_at)
	 SELECT ?6, ?1, ?7, ?2, ?3 + 1, 'blocked', 'blocked', 'owner', ?5, ?4, 'answers_saved_for_next_run', ?8 WHERE ${fence}`)
		.bind(...binding, crypto.randomUUID(), app.instanceId, now));
	statements.push(env.DB.prepare(`UPDATE job_applications SET state_version = state_version + 1, updated_at = ?6 WHERE id = ?1 AND ${fence} RETURNING state_version`).bind(...binding, now));
	const results = await env.DB.batch(statements);
	if (!results.at(-1)?.results.length) throw new HttpError(409, "stale: the application or its run changed before the answers could be saved. Reload and decide again.");
	return { outcome: "answers_saved", savedAnswers: answers.length, runId: run.id, runStatus: run.status, resumed: false, message: "Answers saved for the next separately authorized run. No browser was started or resumed, and no submission was requested." };
}
