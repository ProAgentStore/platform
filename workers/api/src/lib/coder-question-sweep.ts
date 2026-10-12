/**
 * The coder brain's timers (#1025 §4) — one more sweep on the existing every-minute tick
 * (`scheduled()` in index.ts; the issue's comment: no new scheduler). Timers are not held in
 * memory: each tick reads `coder_questions` and acts on what is due, so they survive a restart.
 *
 *   waiting_human ─(human timeout, brain on)→ brain_deciding ─┬→ answered_brain  (delivered through the
 *                                                              │                   same answer path a person uses)
 *                                                              └→ escalated ─(escalation timeout)→ unresolved
 *   any open state ─(a person answers)→ answered_human      (wins at any point — markHumanAnswered)
 *   any open state ─(the run stopped waiting)→ expired
 *
 * Brain off: nothing here acts — the question stays with the person (and expires when the run
 * stops waiting). Turning the brain off mid-wait leaves an escalated or waiting question with the
 * person; a decision already in flight is discarded by its failed compare-and-swap only if a person
 * answered first, so the off switch is honoured at the NEXT tick.
 */
import { clipMarked } from "./clip-marked.js";
import type { Env } from "../types.js";
import { readCoderBrain, type CoderBrainSettings } from "./coder-brain.js";
import { type BrainModelCall, type DecisionContext, byokBrainCall, decideCoderQuestion } from "./coder-brain-decide.js";
import { type CoderQuestion, captureCoderQuestion, openCoderQuestions, transitionCoderQuestion } from "./coder-question-store.js";
import { resolveCodingPause } from "./coding-answer.js";
import { appendTimeline } from "./coding-timeline.js";
import { codingRunRefusal } from "./billing.js";
import { deepLinkFor } from "./console-links.js";
import { logEvent } from "./events.js";
import { listIssueComments, postIssueComment, readIssue, readRepoText } from "./github-issues.js";
import { notifyUser } from "../routes/push.js";

/** Past both timeouts the run also needs time for the sweep's minute and one model call. */
export const BRAIN_WAIT_MARGIN_MS = 10 * 60_000;
/** The brain-off wait: the handoff's own 15 minutes (coding-pause.ts `HANDOFF_GIVE_UP_MS`). */
export const HUMAN_ONLY_WAIT_MS = 15 * 60_000;

/** How long a run parked on a question should wait, given the instance's brain settings. */
export function questionWaitMs(brain: CoderBrainSettings | null): number {
	if (!brain?.enabled) return HUMAN_ONLY_WAIT_MS;
	return Math.max(HUMAN_ONLY_WAIT_MS, (brain.humanTimeoutMinutes + brain.escalationTimeoutMinutes) * 60_000 + BRAIN_WAIT_MARGIN_MS);
}

export interface CoderQuestionEffects {
	/** Post on the question's issue with its owner's token. False when it could not be posted. */
	postComment: (q: CoderQuestion, body: string) => Promise<boolean>;
	notify: (q: CoderQuestion, title: string, body: string, alert: boolean) => Promise<void>;
	/** Deliver a value to the parked run through the person's own answer path. */
	deliver: (q: CoderQuestion, value: string) => Promise<void>;
	/** Gather the brain's context (issue, comments, CLAUDE.md). */
	context: (q: CoderQuestion) => Promise<DecisionContext>;
	/** The model call for this instance's configured brain model. */
	model: (q: CoderQuestion, model: string) => BrainModelCall;
	/** The Pro gate (#870): a refusal sentence, or null. */
	proRefusal: (userId: string) => Promise<string | null>;
	/** Audit: coding_timeline + agent_events. */
	audit: (q: CoderQuestion, line: string) => Promise<void>;
}

export function defaultEffects(env: Env): CoderQuestionEffects {
	return {
		postComment: (q, body) => (q.repo && q.issueNumber ? postIssueComment(env, q.userId, q.repo, q.issueNumber, body) : Promise.resolve(false)),
		notify: async (q, title, body, alert) => {
			const url = q.taskId ? deepLinkFor({ kind: "task", instanceId: q.instanceId, taskId: q.taskId }) : deepLinkFor({ kind: "coding-session", instanceId: q.instanceId, sessionId: q.sessionId });
			await notifyUser(env, q.userId, "coder_question", title, body, url, { kind: alert ? "alert" : "update", instanceId: q.instanceId, key: `coder-question:${q.id}:${title}` }).catch(() => undefined);
		},
		deliver: (q, value) => resolveCodingPause(env, q.instanceId, q.userId, q.sessionId, value),
		context: async (q) => {
			const issue = q.repo && q.issueNumber ? await readIssue(env, q.userId, q.repo, q.issueNumber).catch(() => null) : null;
			const comments = q.repo && q.issueNumber ? await listIssueComments(env, q.userId, q.repo, q.issueNumber).catch(() => []) : [];
			const claudeMd = q.repo ? await readRepoText(env, q.userId, q.repo, "CLAUDE.md").catch(() => null) : null;
			return {
				question: q.question,
				options: q.options,
				why: q.why,
				repo: q.repo,
				issue: issue ? { number: issue.number, title: issue.title, body: issue.body ?? "", labels: issue.labels } : null,
				comments: comments.map((c) => `${c.author}: ${c.body}`),
				claudeMd,
			};
		},
		model: (q, model) => byokBrainCall(env, q.userId, q.instanceId, model),
		proRefusal: (userId) => codingRunRefusal(env, userId),
		audit: async (q, line) => {
			await appendTimeline(env, { sessionId: q.sessionId, instanceId: q.instanceId, userId: q.userId, type: "brain", content: line }).catch(() => undefined);
			await logEvent(env, { source: "coder-brain", event: "coder_question", message: line, level: "info", userId: q.userId, instanceId: q.instanceId, traceId: q.runId ?? q.sessionId, context: { questionId: q.id } }).catch(() => undefined);
		},
	};
}

const optionsLine = (q: CoderQuestion) => (q.options.length ? `\n\nOptions: ${q.options.map((o) => `\`${o}\``).join(" · ")}` : "");
const repoIssue = (q: CoderQuestion) => (q.repo && q.issueNumber ? `${q.repo}#${q.issueNumber}` : q.repo ?? "the session");

/**
 * Called from the run's ask (workflow-run.ts): record the question, post it on the issue, and say how
 * long the run should wait. The push itself is the run's own (coding-pause.ts), sent in the same step.
 */
export async function captureAndAnnounceQuestion(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string; runId?: string | null; taskId?: string | null; question: string; options: string[]; why?: string | null },
	effects: Pick<CoderQuestionEffects, "postComment" | "audit"> = defaultEffects(env),
): Promise<{ question: CoderQuestion; waitMs: number; humanMs: number }> {
	const brain = await readCoderBrain(env, input.instanceId, input.userId);
	const waitMs = questionWaitMs(brain);
	const isNew = !(await env.DB.prepare("SELECT 1 AS hit FROM coder_questions WHERE session_id = ?1 AND COALESCE(task_id,'') = ?2 AND question = ?3 AND state IN ('waiting_human','brain_deciding','escalated')").bind(input.sessionId, input.taskId ?? "", input.question).first());
	const q = await captureCoderQuestion(env, { ...input, waitMs });
	const humanMs = brain?.enabled ? brain.humanTimeoutMinutes * 60_000 : waitMs;
	if (isNew) {
		const by = brain?.enabled
			? `If nobody answers within ${brain.humanTimeoutMinutes} minutes, the coder brain may decide — only if this issue, its comments and CLAUDE.md settle it — and will say so here.`
			: `The run waits ${Math.round(waitMs / 60_000)} minutes for an answer.`;
		if (q.repo && q.issueNumber) {
			const ok = await effects.postComment(q, `**❓ The coder stopped on a question:** ${q.question}${optionsLine(q)}${q.why ? `\n\nWhy it asks: ${q.why}` : ""}\n\nAnswer it on the run's card or with \`answer_instance_input\`. ${by}`).catch(() => false);
			await effects.audit(q, ok ? `Question posted on ${repoIssue(q)}: ${q.question}` : `Question recorded; it could not be posted on ${repoIssue(q)}.`);
		} else await effects.audit(q, `Question recorded (no issue linked): ${q.question}`);
	}
	return { question: q, waitMs, humanMs };
}

/** One sweep tick. Returns what it did, for the scheduled() log and the tests. */
export async function runDueCoderQuestions(env: Env, now = Date.now(), effects?: Partial<CoderQuestionEffects>): Promise<{ checked: number; decided: number; escalated: number; unresolved: number; expired: number }> {
	const out = { checked: 0, decided: 0, escalated: 0, unresolved: 0, expired: 0 };
	const base = defaultEffects(env);
	for (const q of await openCoderQuestions(env)) {
		out.checked++;
		const fx: CoderQuestionEffects = { ...base, ...effects };
		try {
			if (now >= q.expiresAt) {
				if (await transitionCoderQuestion(env, q.id, ["waiting_human", "brain_deciding", "escalated"], "expired", "the run stopped waiting with no answer", { resolvedAt: now }, now)) {
					out.expired++;
					await fx.audit(q, "Question expired: the run stopped waiting without an answer.");
				}
				continue;
			}
			// The instance's own state, read every tick: off, paused or cancelled means hands off.
			const inst = await env.DB.prepare("SELECT status FROM agent_instances WHERE id = ?1").bind(q.instanceId).first<{ status: string }>();
			if (inst?.status !== "active") continue;
			const brain = await readCoderBrain(env, q.instanceId, q.userId);
			if (!brain?.enabled) continue;
			if (q.state === "waiting_human" && now >= q.askedAt + brain.humanTimeoutMinutes * 60_000) {
				const r = await decide(env, q, brain, fx, now);
				if (r === "decided") out.decided++;
				else if (r === "escalated") out.escalated++;
			} else if (q.state === "escalated" && q.escalatedAt && now >= q.escalatedAt + brain.escalationTimeoutMinutes * 60_000) {
				if (await unresolve(q, fx, now, env)) out.unresolved++;
			}
		} catch (e) {
			await fx.audit(q, `Coder brain sweep error: ${e instanceof Error ? clipMarked(e.message, 200, { within: true }) : String(e)}`).catch(() => undefined);
		}
	}
	return out;
}

async function decide(env: Env, q: CoderQuestion, brain: CoderBrainSettings, fx: CoderQuestionEffects, now: number): Promise<"decided" | "escalated" | "none"> {
	// Claim: one decision per question, and a person's answer (any state → answered_human) beats it.
	if (!(await transitionCoderQuestion(env, q.id, ["waiting_human"], "brain_deciding", `no answer in ${brain.humanTimeoutMinutes} minutes; the brain is deciding`, {}, now))) return "none";
	await fx.audit(q, `No answer in ${brain.humanTimeoutMinutes} minutes — the coder brain is deciding.`);
	const refusal = await fx.proRefusal(q.userId);
	const decisionsSoFar = Number(
		(await env.DB.prepare("SELECT COUNT(*) AS n FROM coder_questions WHERE session_id = ?1 AND COALESCE(run_id,'') = ?2 AND answered_by = 'brain'").bind(q.sessionId, q.runId ?? "").first<{ n: number }>())?.n ?? 0,
	);
	const outcome = refusal
		? { decided: false as const, reason: `the coder brain needs Pro (${clipMarked(refusal, 120, { within: true })})`, promptHash: null }
		: await decideCoderQuestion(await fx.context(q), { decisionsSoFar, maxDecisions: brain.maxDecisionsPerRun, threshold: brain.confidenceThreshold }, fx.model(q, brain.model));

	if (outcome.decided) {
		const d = outcome.result;
		// The compare-and-swap is the human-precedence check: if a person answered while the model ran,
		// this fails and the decision is discarded — never delivered, never posted.
		const won = await transitionCoderQuestion(env, q.id, ["brain_deciding"], "answered_brain", `decided: ${d.decision}`, { answeredBy: "brain", resolvedAt: now, decision: d.decision, confidence: d.confidence, reason: d.reason, model: brain.model, promptHash: outcome.promptHash }, now);
		if (!won) {
			await fx.audit(q, "A person answered while the brain was deciding — the brain's decision was discarded.");
			return "none";
		}
		await fx.deliver(q, `Decided by the coder brain (no answer from the owner in ${brain.humanTimeoutMinutes} minutes): ${d.decision}. Reason: ${d.reason}`);
		const comment = `**🧠 Decided by coder brain:** ${d.decision}\n\n**Reason:** ${d.reason}\n\n**Options considered:** ${(d.optionsConsidered.length ? d.optionsConsidered : q.options).join(", ") || "(free answer)"}\n\nConfidence ${d.confidence.toFixed(2)} (threshold ${brain.confidenceThreshold}), model \`${brain.model}\`. Nobody answered within ${brain.humanTimeoutMinutes} minutes; reply on this issue if this is wrong.`;
		await fx.postComment(q, comment).catch(() => false);
		await fx.notify(q, "🧠 Coder brain decided", `${repoIssue(q)}: "${q.question}" → ${d.decision}. ${clipMarked(d.reason, 200, { within: true })}`, false);
		await fx.audit(q, `Answered by the coder brain (${brain.model}, confidence ${d.confidence.toFixed(2)}): ${d.decision} — ${d.reason}`);
		return "decided";
	}
	const escalated = await transitionCoderQuestion(env, q.id, ["brain_deciding"], "escalated", `declined: ${outcome.reason}`, { escalatedAt: now, reason: outcome.reason, model: brain.model, ...(outcome.promptHash ? { promptHash: outcome.promptHash } : {}) }, now);
	if (!escalated) return "none";
	await fx.postComment(q, `**⚠️ The coder brain could not decide** because ${outcome.reason}.\n\nThe question is still waiting: ${q.question}${optionsLine(q)}\n\nPlease answer it within ${brain.escalationTimeoutMinutes} minutes; after that the coder finishes what does not depend on it and closes this issue with what is left.`).catch(() => false);
	await fx.notify(q, "⚠️ Coder still needs your answer", `${repoIssue(q)}: ${q.question} — the brain could not decide because ${outcome.reason}. ${brain.escalationTimeoutMinutes} minutes left.`, true);
	await fx.audit(q, `The coder brain declined (${outcome.reason}); escalated to the owner.`);
	return "escalated";
}

async function unresolve(q: CoderQuestion, fx: CoderQuestionEffects, now: number, env: Env): Promise<boolean> {
	if (!(await transitionCoderQuestion(env, q.id, ["escalated"], "unresolved", "no answer after escalation; the coder finishes what it can", { resolvedAt: now }, now))) return false;
	const issueRef = q.issueNumber ? `issue #${q.issueNumber}` : "the issue";
	const instruction = [
		`UNRESOLVED DECISION — nobody answered "${q.question}" and the coder brain declined (${q.reason ?? "no reason recorded"}).`,
		"Do NOT decide it yourself. Finish everything that does not depend on this decision, run the checks, and commit straight to main (no branches, no pull requests).",
		`Then close ${issueRef} with a comment containing: the question; the options${q.options.length ? ` (${q.options.join(", ")})` : ""}; why the brain declined; what was done (the commit SHAs); what is left; and the exact decision needed to finish.`,
	].join(" ");
	await fx.deliver(q, instruction);
	await fx.postComment(q, `**⏹ Decision unresolved:** ${q.question}${optionsLine(q)}\n\nThe coder brain declined because ${q.reason ?? "no reason recorded"}, and nobody answered after escalation. The coder is finishing everything that does not depend on it, will commit to main, and will close this issue listing what was done, what is left and the decision needed.`).catch(() => false);
	await fx.notify(q, "⏹ Coder question unresolved", `${repoIssue(q)}: "${q.question}" went unanswered. The coder is finishing what it can and will close the issue with what is left.`, true);
	await fx.audit(q, "Unresolved: the coder was told to finish what it can, commit to main and close the issue with the full details.");
	return true;
}
