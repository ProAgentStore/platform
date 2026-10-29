/**
 * `questions: "ask" | "decide"` — what a coding run does with a question it would park on (#1385).
 *
 * Owners wrote "don't park on questions: decide, record on the issue, continue" into objectives and the runs parked anyway: prose in an objective
 * is advisory. This is the platform's setting, enforced where the park is raised (`coding-pause.ts` `waitForHuman`), not in anything the model reads.
 *
 *   ask     (the default) behaviour is unchanged: the run parks and a person (or the coder brain, if it is on) answers.
 *   decide  a REVERSIBLE decision question does not park the run. The platform takes the most reversible option itself, records the decision and
 *           its alternatives (`run_question_decisions`, shown by `coding_loop_status`), posts them on the linked issue, and resumes the run with
 *           a note — attributed to the platform, never to the owner. Anything that genuinely needs the owner still parks:
 *
 *             • a credential, token, secret or permission      (guardrail `privileges`)
 *             • a delete, drop, wipe, force-push or other destructive / irreversible act      (`destructive`)
 *             • spend: more iterations, or a billing / payment / production-credential step  (`spend`, `money`)
 *             • a step that needs the owner's computer or their hands — a sign-in, a menu, a captcha. Those never reach this module at all:
 *               they are `stuck` / `needs_reauth` handoffs, not `needs_input` questions, and `decide` is only offered the latter.
 *             • a question whose every option asks the owner for something ("give me the id", "your call").
 *
 * The guardrails are the coder brain's own (`GUARDRAILS` in `coder-brain-decide.ts`), the four of its six that map to the issue's list. Its
 * `owner_only` and `delivery_mode` rules are NOT used here: they match words like "brand" and "branch" anywhere in a question, which would park
 * an ordinary engineering question about brand tokens or a git branch — the exact parks this setting exists to remove — and the issue names
 * only the four. A match is conservative on purpose: when in doubt it parks, and parking is what `ask` does anyway.
 *
 * "Most reversible" is a plain, documented ranking over the options that survive the guardrails — not a model call, so the choice is
 * deterministic, testable and costs nothing. Options that record, defer, skip, leave things as they are or stay local rank high; options that
 * redeploy, migrate, rename, rewrite, publish or reach into another repository rank low; ties go to the first option offered. The run is told what
 * was chosen and may take the next most reversible option if it knows the choice cannot work, saying why on the issue.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { closesSomething, closingGate, mentionsClosing } from "./question-objective-constraints.js";
import { GUARDRAILS } from "./coder-brain-decide.js";

export const QUESTIONS_POLICIES = ["ask", "decide"] as const;
export type QuestionsPolicy = (typeof QUESTIONS_POLICIES)[number];
export const DEFAULT_QUESTIONS_POLICY: QuestionsPolicy = "ask";

/** A request's `questions`: absent is `undefined` (inherit), a recognised word is itself, anything else is an error that names the two words. */
export function parseQuestionsPolicy(raw: unknown): { ok: true; value: QuestionsPolicy | undefined } | { ok: false; error: string } {
	if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
	const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return v === "ask" || v === "decide" ? { ok: true, value: v } : { ok: false, error: 'questions must be "ask" or "decide"' };
}

/** The `questions` a queued entry carried through its wait (its caller-owned metadata JSON), or undefined to inherit the instance default (#1385). */
export function questionsFromMetadata(metadata: string | null | undefined): QuestionsPolicy | undefined {
	if (!metadata) return undefined;
	try {
		const v = (JSON.parse(metadata) as { questions?: unknown } | null)?.questions;
		return v === "ask" || v === "decide" ? v : undefined;
	} catch {
		return undefined;
	}
}

/** The setting in force: the start's own, else the instance default, else `ask`. */
export function effectiveQuestionsPolicy(requested: QuestionsPolicy | null | undefined, instanceDefault: QuestionsPolicy | null | undefined): QuestionsPolicy {
	return requested ?? instanceDefault ?? DEFAULT_QUESTIONS_POLICY;
}

/** The guardrail ids `decide` never overrides. A subset of the coder brain's `GUARDRAILS` — see the header for the two it leaves out. */
export const DECIDE_NEVER_OVERRIDES = ["privileges", "spend", "money", "destructive"] as const;
// The brain's `privileges` pattern also matches a bare "scope", which turns "out of scope" (a reversible way to defer) into a credential question.
// Here only a permission/token/secret sense of the word counts.
const BARE_SCOPE = /\b(oauth|token|api|permission|access)\s+scopes?\b|\bscopes?\s+(of|for)\s+(the\s+)?(token|key|permission)s?\b/i;
const PARKING_GUARDRAILS = GUARDRAILS.filter((g) => (DECIDE_NEVER_OVERRIDES as readonly string[]).includes(g.id)).map((g) =>
	g.id === "privileges" ? { ...g, re: new RegExp(`${g.re.source.replace("|scopes?|", "|")}|${BARE_SCOPE.source}`, "i") } : g,
);

/** An option that hands the question back to the owner: it asks them for a value, a decision or more information. */
const ASKS_THE_OWNER =
	/\b(give me|send me|tell me|show me|let me know|provide (me|us|the (id|key|token|value|details?|answer))|your call|your choice|you decide|up to you|ask (the )?owner|need(s)? (your|the owner'?s?) (input|answer|approval|decision|confirmation))\b/i;

const guard = (text: string) => PARKING_GUARDRAILS.find((g) => g.re.test(text)) ?? null;

export interface ExcludedOption {
	option: string;
	why: string;
}

export type Judgement =
	| { park: true; guardrail: string; why: string }
	| { park: false; decision: string | null; alternatives: string[]; excluded: ExcludedOption[]; reason: string };

// ── "most reversible" — a plain ranking, documented in the header ────────────────────────────────────────────────────────────────────────
const REVERSIBLE = /\b(record|document|note|defer|postpone|later|follow[- ]?up|out of scope|skip|leave (it|them|this)?\s*(as is|alone)?|keep|no change|do nothing|wait|stub|feature[- ]?flag|revert|dry[- ]?run|draft|minimal|smallest|incremental|locally|workaround)\b/gi;
const COMMITTING = /\b(redeploy|deploy|migrate|migration|rename|rewrite|replace|restructure|overhaul|rebuild|publish|push|release|ship it|force)\b/gi;
const CROSS_REPO = /\b(its own repo|separate repo|another repo|other repo|upstream|different repo)\b/i;

/** Higher is more reversible. Counts are capped so one long option cannot win by repetition. */
export function reversibilityScore(option: string): number {
	const good = Math.min(3, option.match(REVERSIBLE)?.length ?? 0);
	const bad = Math.min(3, option.match(COMMITTING)?.length ?? 0);
	return good * 2 - bad - (CROSS_REPO.test(option) ? 3 : 0);
}

/**
 * Decide, or say why not. Pure.
 *
 * The QUESTION is checked first: if it is itself about a guarded act ("rotate the API key?", "delete the orphan worker?") the answer is not a
 * reversible engineering call, however mild the options read, and it parks. Then each option is checked alone, so a question that offers one
 * guarded option among safe ones ("…or delete it, your call") is decided among the safe ones instead of parking — which is the case in the issue.
 */
export function judgeQuestion(input: { question: string; options: string[]; constraints?: ReadonlyArray<string | null | undefined> }): Judgement {
	const asked = guard(input.question);
	if (asked) return { park: true, guardrail: asked.id, why: `the question is about something that ${asked.why}` };
	// The run's own words (#1390): when its objective or a hint makes closing conditional or forbids it, no option that closes is chosen for the run —
	// whether the condition holds is the run's to check, and "close" is not "the most reversible" of anything the objective has already gated.
	const gate = closingGate(input.constraints ?? []);
	const options = input.options.map((o) => o.trim()).filter(Boolean);
	if (!options.length) {
		// A question about closing, with a gate and nothing to choose between, is not decided: the run is not to be told to "take the most reversible approach" on it.
		if (gate && mentionsClosing(input.question)) return { park: true, guardrail: "objective_constraint", why: `the run's objective gates closing ("${gate}"), and this question asks whether to close` };
		return { park: false, decision: null, alternatives: [], excluded: [], reason: "it offered no options, so the run is told to take the most reversible approach itself" };
	}
	const excluded: ExcludedOption[] = [];
	const safe: string[] = [];
	for (const o of options) {
		const g = guard(o);
		if (g) excluded.push({ option: o, why: `it ${g.why}` });
		else if (ASKS_THE_OWNER.test(o)) excluded.push({ option: o, why: "it hands the question back to the owner" });
		else if (gate && closesSomething(o, input.question)) excluded.push({ option: o, why: `it closes, and the run's objective gates closing ("${gate}") on a condition only the run can check` });
		else safe.push(o);
	}
	if (!safe.length) {
		const first = guard(options[0]);
		if (!first && gate && excluded.some((e) => e.why.startsWith("it closes"))) {
			return { park: true, guardrail: "objective_constraint", why: `every option closes or needs the owner, and the run's objective gates closing ("${gate}")` };
		}
		return { park: true, guardrail: first?.id ?? "owner_input", why: "every option either needs the owner or is a guarded act" };
	}
	let best = 0;
	for (let i = 1; i < safe.length; i++) if (reversibilityScore(safe[i]) > reversibilityScore(safe[best])) best = i;
	const decision = safe[best];
	return {
		park: false,
		decision,
		alternatives: options.filter((o) => o !== decision),
		excluded,
		reason: safe.length === 1 ? "it was the only option that needs nothing from the owner" : `it was the most reversible of the ${safe.length} options that need nothing from the owner`,
	};
}

/** The audit row stores at most this many options per list; the question's full options still reach the run and the issue comment. A list cut, not a text cut. */
const capList = <T>(items: T[]): T[] => items.slice(0, 20);

const bullet = (items: string[]) => items.map((i) => `- ${clipMarked(i, 300, { within: true })}`).join("\n");

/** The note the run resumes with: the platform's decision, never the owner's voice (it rides `goal.resumeNote`, not `userHint`). */
export function decisionNote(question: string, j: Extract<Judgement, { park: false }>, issueRef: string | null): string {
	const where = issueRef ? `on ${issueRef}` : "in your commit messages (no issue is linked to this run)";
	if (j.decision === null) {
		return `Your question "${clipMarked(question, 300, { within: true })}" was not sent to the owner: this run's \`questions\` setting is \`decide\`, so you decide and carry on. It offered no options — take the most reversible approach, and record what you chose and what you rejected ${where}. If it would need a credential, destroy data, spend beyond the limit or need the owner's computer, stop and ask instead.`;
	}
	return `Your question "${clipMarked(question, 300, { within: true })}" was not sent to the owner: this run's \`questions\` setting is \`decide\`. Decision: ${clipMarked(j.decision, 300, { within: true })} (${j.reason}). Proceed with it unless you know a concrete reason it cannot work; then take the next most reversible option and say why ${where}. Alternatives not taken: ${j.alternatives.length ? j.alternatives.map((a) => clipMarked(a, 160, { within: true })).join(" | ") : "none"}.`;
}

/** The comment the platform posts on the linked issue, so the decision can be reviewed afterwards. */
export function decisionComment(runId: string, question: string, options: string[], j: Extract<Judgement, { park: false }>): string {
	const lines = [`**🤖 Decided under \`questions: decide\`** — run \`${runId}\` asked: ${clipMarked(question, 500, { within: true })}`];
	if (options.length) lines.push("", "Options:", bullet(options));
	lines.push("", j.decision === null ? "**Decision:** left to the run, which was told to take the most reversible approach and record it here." : `**Decided:** ${clipMarked(j.decision, 500, { within: true })} — ${j.reason}.`);
	if (j.alternatives.length) lines.push("", "Alternatives not taken:", bullet(j.alternatives));
	if (j.excluded.length) lines.push("", "Not considered:", bullet(j.excluded.map((e) => `${e.option} — ${e.why}`)));
	lines.push("", "_This run is set to decide reversible questions itself. A credential, a destructive act, spend over a limit and anything that needs your computer still wait for you. Comment here if you want it changed._");
	return lines.join("\n");
}

// ── storage ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The setting a run was started with. Null for a run that predates the column, which reads as `ask`. */
export async function runQuestionsPolicy(env: Pick<Env, "DB">, runId: string): Promise<QuestionsPolicy> {
	const row = await env.DB.prepare("SELECT questions_policy FROM agent_loop_runs WHERE run_id = ?1").bind(runId).first<{ questions_policy: string | null }>().catch(() => null);
	return row?.questions_policy === "decide" ? "decide" : "ask";
}

export interface QuestionDecisionRow {
	id: string;
	runId: string;
	round: number;
	question: string;
	options: string[];
	outcome: "decided" | "parked";
	decision: string | null;
	alternatives: string[];
	excluded: ExcludedOption[];
	reason: string;
	guardrail: string | null;
	issue: { repo: string; number: number } | null;
	posted: boolean;
	at: number;
}

interface DbRow {
	id: string;
	run_id: string;
	round: number;
	question: string;
	options: string;
	outcome: "decided" | "parked";
	decision: string | null;
	alternatives: string;
	excluded: string;
	reason: string;
	guardrail: string | null;
	issue_repo: string | null;
	issue_number: number | null;
	posted: number;
	created_at: number;
}

const list = <T,>(raw: string, fallback: T[] = []): T[] => {
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? (v as T[]) : fallback;
	} catch {
		return fallback;
	}
};

/** Bounded: a run decides a handful of questions, and the status route must not carry an unbounded list. */
export const RUN_DECISIONS_MAX = 50;

/** What a run's `decide` policy did, oldest first. Owner-scoped. */
export async function listQuestionDecisions(env: Pick<Env, "DB">, userId: string, runId: string): Promise<QuestionDecisionRow[]> {
	const { results } = await env.DB.prepare("SELECT * FROM run_question_decisions WHERE run_id = ?1 AND user_id = ?2 ORDER BY created_at ASC, rowid ASC LIMIT ?3").bind(runId, userId, RUN_DECISIONS_MAX).all<DbRow>();
	return (results ?? []).map((r) => ({
		id: r.id,
		runId: r.run_id,
		round: r.round,
		question: r.question,
		options: list<string>(r.options),
		outcome: r.outcome,
		decision: r.decision,
		alternatives: list<string>(r.alternatives),
		excluded: list<ExcludedOption>(r.excluded),
		reason: r.reason,
		guardrail: r.guardrail,
		issue: r.issue_repo && r.issue_number ? { repo: r.issue_repo, number: r.issue_number } : null,
		posted: r.posted === 1,
		at: r.created_at,
	}));
}

export interface DecideContext {
	runId: string;
	instanceId: string;
	userId: string;
	round: number;
	issue: { repo: string; number: number } | null;
	postComment: (repo: string, number: number, body: string) => Promise<boolean>;
	/** The run's own words that can rule options out (#1390): its goal's objective, hints and standing rules. The stored objective is always read too. */
	constraintTexts?: ReadonlyArray<string | null | undefined>;
	now?: number;
}

/**
 * Apply a run's `questions` setting to a question it is about to park on. Returns `{ decided: false }` — touching nothing — for an `ask` run,
 * and for a `decide` run whose question the guardrails keep (recording WHY, so the park is explained). Returns `{ decided: true, note }` after
 * recording the decision and posting it. Idempotent per (run, round): a retried step records and posts once.
 */
export async function applyQuestionsPolicy(env: Env, ctx: DecideContext, q: { question: string; options: string[] }): Promise<{ decided: true; note: string } | { decided: false }> {
	if ((await runQuestionsPolicy(env, ctx.runId)) !== "decide") return { decided: false };
	// The objective as the run was started with it, from its row — so a caller that passes nothing is still held to it.
	const stored = await env.DB.prepare("SELECT objective FROM agent_loop_runs WHERE run_id = ?1").bind(ctx.runId).first<{ objective: string | null }>().catch(() => null);
	const j = judgeQuestion({ ...q, constraints: [stored?.objective, ...(ctx.constraintTexts ?? [])] });
	const id = `qd-${ctx.runId}-${ctx.round}`;
	const now = ctx.now ?? Date.now();
	const repo = ctx.issue?.repo ?? null;
	const num = ctx.issue?.number ?? null;
	const base = [id, ctx.runId, ctx.instanceId, ctx.userId, ctx.round, clipMarked(q.question, 1000, { within: true }), JSON.stringify(capList(q.options)), repo, num, now] as const;
	if (j.park) {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO run_question_decisions (id, run_id, instance_id, user_id, round, question, options, outcome, reason, guardrail, issue_repo, issue_number, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'parked', ?11, ?12, ?8, ?9, ?10)`,
		)
			.bind(...base, clipMarked(j.why, 300, { within: true }), j.guardrail)
			.run();
		return { decided: false };
	}
	const inserted = await env.DB.prepare(
		`INSERT OR IGNORE INTO run_question_decisions (id, run_id, instance_id, user_id, round, question, options, outcome, decision, alternatives, excluded, reason, issue_repo, issue_number, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'decided', ?11, ?12, ?13, ?14, ?8, ?9, ?10)`,
	)
		.bind(...base, j.decision === null ? null : clipMarked(j.decision, 500, { within: true }), JSON.stringify(capList(j.alternatives)), JSON.stringify(capList(j.excluded)), clipMarked(j.reason, 300, { within: true }))
		.run();
	// Post only for the attempt that recorded it: a retried step must not comment twice.
	if (ctx.issue && (inserted.meta?.changes ?? 0) > 0) {
		const posted = await ctx.postComment(ctx.issue.repo, ctx.issue.number, decisionComment(ctx.runId, q.question, q.options, j)).catch(() => false);
		if (posted) await env.DB.prepare("UPDATE run_question_decisions SET posted = 1 WHERE id = ?1").bind(id).run();
	}
	return { decided: true, note: decisionNote(q.question, j, ctx.issue ? `${ctx.issue.repo}#${ctx.issue.number}` : null) };
}
