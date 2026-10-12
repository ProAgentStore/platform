/** Console view of the coder brain switch and product-owner triage reports (#1025, #1027). */
export type PoCategory = "waiting_on_human" | "blocked" | "needs_detail" | "ready";

export interface PoCounts {
	queued: number;
	wouldQueue: number;
	alreadyQueued: number;
	ready: number;
	waiting: number;
	blocked: number;
	needsDetail: number;
	commented: number;
}

export interface PoReportItem {
	repo: string;
	number: number;
	title: string;
	category: PoCategory;
	reason: string;
	action: string;
}

export interface PoTriageReport {
	id: string;
	slot: string;
	dryRun: boolean;
	status: "running" | "completed" | "failed";
	digest: string | null;
	error: string | null;
	createdAt: string;
	report: { gate: string | null; counts: PoCounts; items: PoReportItem[] } | null;
}

export interface CoderBrainSettings {
	enabled: boolean;
	poEnabled: boolean;
	model: string;
	/** #1043: the model is this coder's Brain (the Brain model card), not a separate setting. */
	modelChosen?: boolean;
	humanTimeoutMinutes: number;
	escalationTimeoutMinutes: number;
	maxDecisionsPerRun: number;
	confidenceThreshold: number;
}

export interface CoderBrainView {
	settings: CoderBrainSettings | null;
	triggers: Array<{ id: string; name: string; schedule: string | null; enabled: boolean; config: { timezone?: string; dryRun?: boolean }; nextRunAt: string | null; lastRunAt: string | null }>;
	reports?: PoTriageReport[];
}

/** "queued 1 · 1 waiting on you · 1 blocked · 1 needs detail" — one line per wake, from its counts. */
export function reportSummary(r: PoTriageReport): string {
	if (r.status === "failed") return `failed: ${r.error ?? "unknown error"}`;
	if (!r.report) return r.status;
	const c = r.report.counts;
	const parts = [
		r.dryRun ? `would queue ${c.wouldQueue}` : `queued ${c.queued}`,
		c.alreadyQueued ? `${c.alreadyQueued} already queued` : "",
		c.waiting ? `${c.waiting} waiting on you` : "",
		c.blocked ? `${c.blocked} blocked` : "",
		c.needsDetail ? `${c.needsDetail} need${c.needsDetail === 1 ? "s" : ""} detail` : "",
	].filter(Boolean);
	return `${parts.join(" · ")}${r.report.gate ? ` — held: ${r.report.gate}` : ""}${r.dryRun ? " (dry run)" : ""}`;
}

/** A question a coder's run stopped on (#1025), as `GET /coder-questions` returns it. */
export interface CoderQuestionView {
	id: string;
	question: string;
	options: string[];
	state: "waiting_human" | "brain_deciding" | "answered_human" | "answered_brain" | "escalated" | "unresolved" | "expired";
	repo: string | null;
	issueNumber: number | null;
	askedAt: number;
	answeredBy: "human" | "brain" | null;
	decision: string | null;
	confidence: number | null;
	reason: string | null;
}

const STATE_WORDS: Record<CoderQuestionView["state"], string> = {
	waiting_human: "waiting on you",
	brain_deciding: "the brain is deciding",
	answered_human: "answered by you",
	answered_brain: "decided by the brain",
	escalated: "escalated — waiting on you",
	unresolved: "unresolved — the coder finished what it could",
	expired: "the run stopped waiting",
};

/** "Which layout? — decided by the brain: compact (0.92)". */
export function questionSummary(q: CoderQuestionView): string {
	const where = q.repo && q.issueNumber ? ` (${q.repo}#${q.issueNumber})` : "";
	const decided = q.state === "answered_brain" && q.decision ? `: ${q.decision}${q.confidence !== null ? ` (${q.confidence.toFixed(2)})` : ""}` : q.state === "escalated" && q.reason ? ` (${q.reason})` : "";
	return `${q.question}${where} — ${STATE_WORDS[q.state]}${decided}`;
}

/** `GET /v1/instances/:id/coder-questions` (#1025). */
export interface CoderQuestionsResponse {
	settings: CoderBrainSettings | null;
	questions: CoderQuestionView[];
}
