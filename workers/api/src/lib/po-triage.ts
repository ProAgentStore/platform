/**
 * Product-owner triage of a coder's open issues (#1027) — the PURE half: classify, order, word.
 *
 * Each open issue falls in exactly one category, checked in this order:
 *   1. waiting_on_human — labelled for a person (`needs-human`, `blocked-on-serge`, … — the fleet
 *      snapshot's own `isNeedsHumanLabel`, so the console and this loop agree), or carrying a question
 *      the coder asked the owner (#1025) that is still open — waiting, being decided, or escalated.
 *      Skipped, untouched.
 *   2. blocked — "depends on #n" / "blocked by #n" where #n is still open. Skipped and noted.
 *   3. needs_detail — missing a stated problem, acceptance criteria, scope, or the files/area
 *      involved. Fixed, testable checks; no model call. The wake posts ONE comment listing what is
 *      missing, and never edits the issue.
 *   4. ready — everything else, queued in priority order.
 *
 * Not covered by these checks, and stated rather than guessed: a question to the owner that someone
 * other than the coder asked in a comment, and epic siblings that must land first without a "depends
 * on" line.
 */
import { isNeedsHumanLabel } from "./fleet-snapshot.js";

export type PoCategory = "waiting_on_human" | "blocked" | "needs_detail" | "ready";

export interface PoIssue {
	number: number;
	title: string;
	body: string;
	labels: string[];
}

export interface PoClassification {
	category: PoCategory;
	/** One line, for the report. Never the issue text itself. */
	reason: string;
	missing?: string[];
	blockedBy?: number[];
}

const DEPENDENCY_RE = /\b(?:depends\s+on|blocked\s+by)\s+#(\d+)/gi;
const EPIC_RE = /\b(?:part\s+of|child\s+of|parent:?|epic:?)\s+#(\d+)/i;
const BUG_LABEL_RE = /^(?:bug|incident|regression|outage|hotfix|p0|sev[- ]?[01])\b/i;
const BUG_TITLE_RE = /^\s*(?:\[?(?:bug|incident|regression)\]?\b|fix\b)/i;

/** What a ready issue must state. Labels are what the "needs detail" comment says is missing. */
export const DETAIL_CHECKS: ReadonlyArray<{ id: string; label: string; present: (body: string) => boolean }> = [
	{ id: "problem", label: "a clear problem statement (what is wrong or needed, and why)", present: (b) => b.replace(/^#+.*$/gm, "").replace(/\s+/g, " ").trim().length >= 60 },
	{ id: "acceptance", label: "acceptance criteria (how we know it is done)", present: (b) => /acceptance criteria|definition of done|\bdone when\b|^\s*[-*]\s+\[[ xX]\]/im.test(b) },
	{ id: "scope", label: "the scope (what is in, and what is out)", present: (b) => /\bscope\b|\bnon-goals?\b|\bthis issue only\b/i.test(b) },
	{
		id: "area",
		label: "the files or area of the code involved",
		present: (b) => /`[^`\n]+`|\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|go|rs|rb|java|kt|swift|md|sql|json|ya?ml|toml|css|html)\b/i.test(b),
	},
];

/** Issue numbers this text says it waits on. */
export function dependenciesOf(body: string): number[] {
	return [...new Set([...body.matchAll(DEPENDENCY_RE)].map((m) => Number(m[1])))];
}

/**
 * Classify one issue. `openIssues` is the repo's open set as read; when that read was incomplete
 * (`openListComplete: false`) a dependency not in it is treated as open — unknown is not "landed".
 */
export function classifyPoIssue(issue: PoIssue, ctx: { openIssues: ReadonlySet<number>; openListComplete: boolean; openQuestions?: ReadonlySet<number> }): PoClassification {
	const human = issue.labels.find(isNeedsHumanLabel);
	if (human) return { category: "waiting_on_human", reason: `Labelled "${human}" — waiting on a person.` };
	if (ctx.openQuestions?.has(issue.number)) return { category: "waiting_on_human", reason: "The coder asked you a question on this issue that is still open (#1025)." };
	const waitsOn = dependenciesOf(issue.body).filter((n) => n !== issue.number && (ctx.openIssues.has(n) || !ctx.openListComplete));
	if (waitsOn.length) return { category: "blocked", reason: `Waits on ${waitsOn.map((n) => `#${n}`).join(", ")}, still open.`, blockedBy: waitsOn };
	const missing = DETAIL_CHECKS.filter((c) => !c.present(issue.body ?? "")).map((c) => c.label);
	if (missing.length) return { category: "needs_detail", reason: `Missing ${missing.length} of ${DETAIL_CHECKS.length}: ${missing.join("; ")}.`, missing };
	return { category: "ready", reason: "States the problem, acceptance criteria, scope and area." };
}

/**
 * Priority order for ready issues: bugs and incidents, then issues other open issues depend on,
 * then epic children (by epic, then number), then the rest — oldest (lowest number) first in each.
 */
export function orderReady<T extends { issue: PoIssue }>(ready: readonly T[], allOpen: readonly PoIssue[]): T[] {
	const dependedOn = new Set(allOpen.flatMap((i) => dependenciesOf(i.body).filter((n) => n !== i.number)));
	const rank = (i: PoIssue): [number, number, number] => {
		if (i.labels.some((l) => BUG_LABEL_RE.test(l)) || BUG_TITLE_RE.test(i.title)) return [0, 0, i.number];
		if (dependedOn.has(i.number)) return [1, 0, i.number];
		const epic = i.body.match(EPIC_RE);
		if (epic) return [2, Number(epic[1]), i.number];
		return [3, 0, i.number];
	};
	return [...ready].sort((a, b) => {
		const [x, y] = [rank(a.issue), rank(b.issue)];
		return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
	});
}

/** Changes when the issue's title or body changes, so a "needs detail" comment repeats only then. */
export function issueVersion(issue: Pick<PoIssue, "title" | "body">): string {
	let h = 2166136261;
	const text = `${issue.title}\n${issue.body}`;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return (h >>> 0).toString(16).padStart(8, "0");
}

export const DETAIL_MARKER = "pags-po-triage:needs-detail";
const markerFor = (version: string) => `<!-- ${DETAIL_MARKER}:${version} -->`;

/** True when this version of the issue already has its "needs detail" comment. */
export function hasDetailComment(comments: readonly { body: string }[], version: string): boolean {
	return comments.some((c) => c.body.includes(markerFor(version)));
}

/** The one comment a vague issue gets. Lists what is missing; never restates or rewrites the issue. */
export function detailComment(missing: readonly string[], version: string): string {
	return [
		"**Product-owner triage:** this issue is not ready for the coder yet. To pick it up, it needs:",
		"",
		...missing.map((m) => `- ${m}`),
		"",
		"Add these to the issue and the next triage will queue it. (Automated; posted once per version of this issue.)",
		markerFor(version),
	].join("\n");
}

/** The objective a ready issue is queued with. The issue number comes first, which is what dedupe keys on. */
export function poObjective(repo: string, issue: Pick<PoIssue, "number" | "title">): string {
	return `Work issue #${issue.number} in ${repo}: ${issue.title}. Read the issue and all its comments, meet its acceptance criteria, run the checks, commit straight to main (no branches, no pull requests), and comment on the issue with what changed. Queued by product-owner triage (#1027).`;
}

export interface PoCounts {
	queued: number;
	/** Dry run: what a live wake would have queued. */
	wouldQueue: number;
	alreadyQueued: number;
	ready: number;
	waiting: number;
	blocked: number;
	needsDetail: number;
	commented: number;
}

/** "Tennis Clubs: queued 2, 1 waiting on you, 1 needs detail". */
export function digestLine(instanceName: string, c: PoCounts, dryRun: boolean): string {
	const parts = [
		dryRun ? `would queue ${c.wouldQueue}` : `queued ${c.queued}`,
		c.waiting ? `${c.waiting} waiting on you` : "",
		c.blocked ? `${c.blocked} blocked` : "",
		c.needsDetail ? `${c.needsDetail} need${c.needsDetail === 1 ? "s" : ""} detail` : "",
	].filter(Boolean);
	return `${instanceName}: ${parts.join(", ")}${dryRun ? " (dry run)" : ""}`;
}

/** Notify only when something happened or the picture moved since the last wake. */
export function digestWorthSending(c: PoCounts, previous: PoCounts | null): boolean {
	if (c.queued > 0 || c.commented > 0) return true;
	if (previous && c.wouldQueue !== (previous.wouldQueue ?? 0)) return true;
	if (!previous) return c.waiting + c.blocked + c.needsDetail + c.ready > 0;
	return c.waiting !== previous.waiting || c.blocked !== previous.blocked || c.needsDetail !== previous.needsDetail || c.ready !== previous.ready;
}
