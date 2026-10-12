/**
 * The coder brain's decision step (#1025 §5–6; the grounded engine is #1026's).
 *
 * Given a question a coding run parked on, it either DECIDES — `{decision, confidence, reason,
 * optionsConsidered}` — or DECLINES with a reason, and a decline is escalated to the person. The
 * guardrails are enforced HERE, in code, before the model is called and again on its answer; the
 * prompt states them too, but a prompt is not a guardrail.
 *
 * Context is deliberately narrow (#1026 owns the full grounding): the question and its options, the
 * run's own reason, the issue and its comments, and the repo's CLAUDE.md. It runs on the owner's own
 * provider key (BYOK, `runUserWorkersAi`), like the Pilot and the loop orchestrator.
 */
import { clipMarked } from "./clip-marked.js";
import type { Env } from "../types.js";
import { isNeedsHumanLabel } from "./fleet-snapshot.js";
import { controllerAiCall } from "./controller-ai-recovery.js";
import { extractJsonObject } from "./loop-decide.js";
import { runUserWorkersAi } from "./user-ai.js";
import { readInstanceBrain } from "./instance-brain.js";

export interface BrainDecision {
	decision: string;
	confidence: number;
	reason: string;
	optionsConsidered: string[];
}
export type BrainOutcome = { decided: true; result: BrainDecision; promptHash: string } | { decided: false; reason: string; promptHash: string | null };

export interface DecisionContext {
	question: string;
	options: string[];
	why: string | null;
	repo: string | null;
	issue: { number: number; title: string; body: string; labels: string[] } | null;
	comments: string[];
	claudeMd: string | null;
}

/**
 * The hard rules (#1025 §6). Each is a category, matched on the QUESTION (and options) before the
 * model runs and on the DECISION after it. A match declines, whatever the model's confidence.
 */
export const GUARDRAILS: ReadonlyArray<{ id: string; why: string; re: RegExp }> = [
	{ id: "owner_only", why: "it is an owner-only choice (pricing, legal, licensing, branding or product direction)", re: /\b(pric(e|es|ing)|legal|licen[cs](e|ing)|trademark|brand(ing)?|logo|product direction|roadmap|terms of service|privacy policy)\b/i },
	{ id: "privileges", why: "it would grant or widen permissions, tokens, scopes or secrets", re: /\b(permissions?|scopes?|tokens?|secrets?|credentials?|api[- ]?keys?|passwords?|oauth|access (rights|control)|admin rights|grant access)\b/i },
	{ id: "money", why: "it touches payments, payouts, billing or production credentials", re: /\b(payments?|payouts?|billing|invoices?|stripe|refunds?|subscriptions?|charges?|pricing tiers?|production (credentials?|secrets?)|deploy(ment)? secrets?)\b/i },
	{ id: "destructive", why: "it would delete data, a repository or an instance", re: /\b(delete|deletion|drop (the )?(table|database|column)|destroy|wipe|truncate|purge|remove (the )?(repo(sitory)?|data(base)?|instance|table|users?)|force[- ]push|rm -rf)\b/i },
	{ id: "delivery_mode", why: "it would change delivery mode (this repo delivers straight to main: no branches, no pull requests)", re: /\b(branch(es|ing)?|pull requests?|merge requests?|\bPRs?\b|feature flag rollout process|release process)\b/i },
];

/** Why the question must not be decided by the brain, or null. Checked before any model call. */
export function declineBeforeModel(ctx: Pick<DecisionContext, "question" | "options" | "issue">, decisionsSoFar: number, maxDecisions: number): string | null {
	const label = ctx.issue?.labels.find(isNeedsHumanLabel);
	if (label) return `the issue is labelled "${label}" — it waits on a person`;
	if (decisionsSoFar >= maxDecisions) return `this run already had ${decisionsSoFar} brain decision${decisionsSoFar === 1 ? "" : "s"} (the limit is ${maxDecisions})`;
	const text = [ctx.question, ...ctx.options].join("\n");
	const hit = GUARDRAILS.find((g) => g.re.test(text));
	return hit ? hit.why : null;
}

/** The same rules on the model's answer, plus the threshold and the option set. */
export function declineAfterModel(d: BrainDecision, options: readonly string[], threshold: number): string | null {
	if (!d.decision.trim()) return "the model returned no decision";
	if (!(d.confidence >= threshold)) return `confidence ${d.confidence.toFixed(2)} is below the threshold ${threshold}`;
	if (options.length && !options.some((o) => o.trim().toLowerCase() === d.decision.trim().toLowerCase())) return "the decision is not one of the options the coder offered";
	const hit = GUARDRAILS.find((g) => g.re.test(`${d.decision}\n${d.reason}`));
	return hit ? `the decision ${hit.why}` : null;
}

/** Parse the model's reply. Anything else than the two documented shapes is a decline. */
export function parseBrainReply(text: string): { decision: BrainDecision } | { declined: string } {
	const raw = extractJsonObject(text);
	if (!raw) return { declined: "the model's reply was not the structured answer asked for" };
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return { declined: "the model's reply was not valid JSON" };
	}
	if (o.declined === true) return { declined: typeof o.reason === "string" && o.reason.trim() ? `the model declined: ${clipMarked(o.reason.trim(), 300, { within: true })}` : "the model declined" };
	const confidence = typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
	if (typeof o.decision !== "string" || !Number.isFinite(confidence)) return { declined: "the model's reply had no decision and confidence" };
	return {
		decision: {
			decision: clipMarked(o.decision.trim(), 500, { within: true }),
			confidence: Math.max(0, Math.min(1, confidence)),
			reason: typeof o.reason === "string" ? clipMarked(o.reason.trim(), 1000, { within: true }) : "",
			optionsConsidered: Array.isArray(o.options_considered) ? o.options_considered.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
		},
	};
}

const SYSTEM = [
	"You are the coder brain: a careful supervisor above a coding agent that has stopped to ask a question.",
	"Decide ONLY if the issue, its comments and the repository's CLAUDE.md already settle the answer. Never guess, never coin-flip.",
	"Decline (do not decide) when the question is an owner-only choice (pricing, legal, licensing, branding, product direction), touches permissions, tokens, secrets, payments, payouts or billing, would delete data/repos/instances, or would change delivery mode (this repo commits straight to main: no branches, no pull requests).",
	"If the coder offered options, your decision must be exactly one of them.",
	'Reply with ONE JSON object and nothing else: {"decision": "...", "confidence": 0.0-1.0, "reason": "why, citing the issue/comment/CLAUDE.md line that settles it", "options_considered": ["..."]} or {"declined": true, "reason": "..."}.',
].join("\n");

export function brainPrompt(ctx: DecisionContext): { system: string; user: string } {
	const parts = [
		`Repository: ${ctx.repo ?? "(unknown)"}`,
		`Question: ${ctx.question}`,
		ctx.options.length ? `Options: ${ctx.options.join(" | ")}` : "Options: (free answer)",
		ctx.why ? `Why the coder asks: ${ctx.why}` : "",
		ctx.issue ? `Issue #${ctx.issue.number}: ${ctx.issue.title}\n${clipMarked(ctx.issue.body, 6000)}` : "Issue: (none linked)",
		ctx.comments.length ? `Issue comments (oldest first):\n${clipMarked(ctx.comments.map((c) => `- ${clipMarked(c, 1500)}`).join("\n"), 6000)}` : "",
		ctx.claudeMd ? `Repository CLAUDE.md:\n${clipMarked(ctx.claudeMd, 6000)}` : "",
	].filter(Boolean);
	return { system: SYSTEM, user: parts.join("\n\n") };
}

export function promptHash(p: { system: string; user: string }): string {
	let h = 2166136261;
	const t = `${p.system}\n${p.user}`;
	for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** The model call, injected so the whole decision tests without a provider. */
export type BrainModelCall = (prompt: { system: string; user: string }) => Promise<string>;

/** Decide or decline. Guardrails first, then the model, then the guardrails again. */
export async function decideCoderQuestion(
	ctx: DecisionContext,
	limits: { decisionsSoFar: number; maxDecisions: number; threshold: number },
	call: BrainModelCall,
): Promise<BrainOutcome> {
	const before = declineBeforeModel(ctx, limits.decisionsSoFar, limits.maxDecisions);
	if (before) return { decided: false, reason: before, promptHash: null };
	const prompt = brainPrompt(ctx);
	const hash = promptHash(prompt);
	let reply: string;
	try {
		reply = await call(prompt);
	} catch (e) {
		return { decided: false, reason: `the brain model could not be reached (${e instanceof Error ? clipMarked(e.message, 200, { within: true }) : String(e)})`, promptHash: hash };
	}
	const parsed = parseBrainReply(reply);
	if ("declined" in parsed) return { decided: false, reason: parsed.declined, promptHash: hash };
	const after = declineAfterModel(parsed.decision, ctx.options, limits.threshold);
	if (after) return { decided: false, reason: after, promptHash: hash };
	return { decided: true, result: parsed.decision, promptHash: hash };
}

/** The production model call: the owner's own key, the configured brain model. */
export function byokBrainCall(env: Env, userId: string, instanceId: string, model: string): BrainModelCall {
	return async (prompt) => {
		// A model the owner picked as this coder's Brain runs on the provider it names (#1043, #852).
		const brain = await readInstanceBrain(env, instanceId);
		const honorModel = brain?.modelChosen === true && brain.model === model;
		const res = (await controllerAiCall(env, { userId, instanceId, surface: "loop" }, (streamDeadlines) =>
			runUserWorkersAi(
				env,
				userId,
				model,
				{ messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], maxTokens: 500, streamDeadlines },
				{ kind: "chat", instanceId, promptSource: "coder-brain", promptPhase: "decide", promptSections: [{ label: "coder-brain.system", value: prompt.system }, { label: "coder-brain.context", value: prompt.user }] },
				{ honorModel },
			),
		)) as { response?: string };
		return res.response ?? "";
	};
}
