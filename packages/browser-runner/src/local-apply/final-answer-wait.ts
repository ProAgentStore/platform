/** Final-review answers retain one exact live browser; they never authorize a fresh fill or submit. */
import { RunnerInputError } from "../errors.js";
import { LOCAL_APPLY_CAPS, type LocalApplyPause, type LocalApplyResultEnvelope } from "./contract.js";

export interface FinalAnswerPauseOptions { finalReviewAnswers: { key: string; questions: readonly string[]; expiresAt: number; budgetMs: number } }
export interface FinalAnswerPage { isClosed(): boolean }
export interface FinalAnswerLease { key: string; expiresAt: number; budgetMs: number; page: FinalAnswerPage | null }
interface AnswerSource { label?: string; text: string; answerQuestion?: string; answerText?: string }

/** The engine's per-tool budget is configured from maxMinutes. Reserve 10% to return/transport the result. */
export function finalAnswerLease(previous: FinalAnswerLease | undefined, options: FinalAnswerPauseOptions, page: FinalAnswerPage | null): FinalAnswerLease {
	const next = options.finalReviewAnswers;
	return previous?.key === next.key ? previous : { key: next.key, expiresAt: next.expiresAt, budgetMs: next.budgetMs, page };
}

export function finalAnswerTimeout(lease: FinalAnswerLease | undefined, now: number, questions: readonly string[]): Pick<LocalApplyResultEnvelope, "outcome" | "blockReason" | "questions" | "summary"> | null {
	return lease && now >= lease.expiresAt ? { outcome: "blocked", blockReason: "incomplete", questions: [...questions], summary: `The final-review owner-answer wait expired after ${lease.budgetMs / 1000} seconds (90% of this engine's configured MCP tool budget). The live browser was closed; external effects remain unverified and no fresh fill is authorized.` } : null;
}

const activeFinalWaits = new WeakSet<object>();

/** Match newly supplied trusted owner-answer objects, never a growing string or unrelated source. */
export async function waitForFinalAnswers(input: {
	owner?: object;
	questions(): readonly string[];
	sources(): readonly AnswerSource[];
	wait(question: string, options: FinalAnswerPauseOptions): Promise<boolean>;
	answered(question: string): void;
	stopped(): boolean;
	now(): number;
	maxMinutes: number;
	started(options: FinalAnswerPauseOptions): void;
	finished(key: string, expired: boolean): void;
}): Promise<"answered" | "unanswered" | "stopped" | "busy"> {
	const owner = input.owner ?? input;
	if (activeFinalWaits.has(owner)) return "busy";
	activeFinalWaits.add(owner);
	const key = crypto.randomUUID();
	const budgetMs = Math.floor(input.maxMinutes * 60_000 * 0.9);
	const expiresAt = input.now() + budgetMs;
	try {
		input.started({ finalReviewAnswers: { key, questions: [...input.questions()], expiresAt, budgetMs } });
		while (input.questions().length) {
			if (input.stopped() || input.now() >= expiresAt) return "stopped";
			const questions = [...input.questions()];
			const before = new Set(input.sources());
			if (!(await input.wait(questions[0]!, { finalReviewAnswers: { key, questions, expiresAt, budgetMs } })) || input.stopped() || input.now() >= expiresAt) return "stopped";
			const supplied = new Set(input.sources().filter((source) => !before.has(source) && source.answerText?.trim()).map((source) => source.answerQuestion));
			const answered = questions.filter((question) => supplied.has(question));
			if (!answered.length) return "unanswered";
			for (const question of answered) input.answered(question);
		}
		return "answered";
	} finally { activeFinalWaits.delete(owner); input.finished(key, input.now() >= expiresAt); }
}

/** Validate the whole resumed answer batch before any source, website policy, or pause can change. */
export function resumeAnswerSources(raw: unknown, pause: LocalApplyPause | undefined, expectedAnswerPauseKey: unknown, now: number): Array<AnswerSource & { label: string }> {
	if (expectedAnswerPauseKey !== undefined && !pause?.answerWait) throw new RunnerInputError("That final-answer pause is no longer current; no answers were applied.", 409);
	const inputs = Array.isArray(raw) ? raw : [];
	if (pause?.answerWait) {
		if (!pause.handoffRequestId || expectedAnswerPauseKey !== pause.handoffRequestId) throw new RunnerInputError("The final-answer pause changed; reload its exact pause key before answering.", 409);
		if (now >= pause.answerWait.expiresAt) throw new RunnerInputError("The bounded final-answer wait expired; this live run cannot be resumed.", 409);
		if (!inputs.length || inputs.length > LOCAL_APPLY_CAPS.answers) throw new RunnerInputError("Supply at least one answer to this exact final-review pause; no answers were applied.", 400);
	}
	const answers: Array<AnswerSource & { label: string }> = [];
	const seen = new Set<string>();
	for (const input of inputs.slice(0, LOCAL_APPLY_CAPS.answers)) {
		const r = input && typeof input === "object" ? input as Record<string, unknown> : {};
		if (pause?.answerWait && (typeof r.question !== "string" || typeof r.answer !== "string" || !r.answer.trim() || !pause.answerWait.questions.includes(r.question) || seen.has(r.question))) throw new RunnerInputError("Every answer must name a distinct current final-review question and be nonempty; no answers were applied.", 400);
		if (typeof r.question !== "string" || typeof r.answer !== "string") continue;
		const answer = r.answer.trim();
		if (answer.length > LOCAL_APPLY_CAPS.answerChars) throw new RunnerInputError(`Each answer must be at most ${LOCAL_APPLY_CAPS.answerChars} characters; no answers were applied.`, 400);
		if (r.question.length > LOCAL_APPLY_CAPS.questionChars) throw new RunnerInputError(`Each question must be at most ${LOCAL_APPLY_CAPS.questionChars} characters; no answers were applied.`, 400);
		if (answer) answers.push({ label: "owner answers", text: `Q: ${r.question}\nA: ${answer}`, answerText: answer, answerQuestion: r.question });
		seen.add(r.question);
	}
	return answers;
}

/** No fallback to a global or newly selected page: continuation belongs to this run's owned page. */
export function readFinalAnswerPage(read: () => FinalAnswerPage | null | undefined): FinalAnswerPage | null {
	try { return read() ?? null; } catch { return null; }
}

export function finalAnswerUnavailable(lease: FinalAnswerLease | undefined, page: FinalAnswerPage | null, questions: readonly string[]): ReturnType<typeof finalAnswerTimeout> {
	return finalAnswerPageAvailable(lease, page) ? null : { outcome: "blocked", blockReason: "incomplete", questions: [...questions], summary: "This browser adapter cannot retain this run's exact live page for owner answers. The run ended incomplete; external effects remain unverified and no fresh fill is authorized." };
}

export function finalAnswerPageAvailable(lease: FinalAnswerLease | undefined, page: FinalAnswerPage | null): boolean {
	try { return !!lease?.page && page === lease.page && !page.isClosed(); } catch { return false; }
}
