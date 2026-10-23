/**
 * One product-owner triage wake of a coder instance (#1027) — the `run_po_triage` trigger action.
 *
 * Reads the open issues of every GitHub repo the coder is bound to, classifies each
 * (`po-triage.ts`), and then:
 *   • waiting on a person → untouched;
 *   • blocked → noted in the report;
 *   • needs detail → ONE comment listing what is missing, once per version of the issue;
 *   • ready → queued in priority order through the existing objective queue, never twice
 *     (`findDuplicateObjective` sees pending entries AND running runs), then the repo's queue is
 *     kicked through `tryDequeueAndStart`, the same door that keeps one coder per repo.
 *
 * Gates on queueing (the report still classifies everything): the brain and its PO layer on; the
 * instance active (not paused or cancelled); no question waiting on the owner; the Pro gate; the
 * account's daily budget; at most {@link MAX_QUEUE_PER_WAKE} new entries per wake. Dry run (the
 * default for a new trigger) writes nothing to GitHub and queues nothing.
 *
 * Guardrails (#1025 §6): it only reads issues, posts the one "needs detail" comment and queues
 * work. It never edits, closes or deletes an issue, and touches no permission, token, secret,
 * payment or delivery setting. Every wake writes a report; a digest is sent only when something
 * changed. Two windows firing in the same minute produce one wake (UNIQUE instance+slot).
 */
import type { Env } from "../types.js";
import { automaticProviderHold } from "./provider-account-hold.js";
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { codingRunRefusal } from "./billing.js";
import { clipMarked } from "./clip-marked.js";
import { readCoderBrain } from "./coder-brain.js";
import { listRepos } from "./coding-store.js";
import { deepLinkFor } from "./console-links.js";
import { DAILY_CEILING_MICROS, DAILY_TOKEN_CEILING, isBudgetEnforced, resolveAccountCeilings } from "./delegation-budget-store.js";
import { listIssueComments, listIssuesPage, postIssueComment, readIssue } from "./github-issues.js";
import { loopDriverFor } from "./loop-drivers.js";
import { findDuplicateObjective } from "./objective-dedupe.js";
import { enqueueObjective } from "./objective-queue.js";
import { tryDequeueAndStart } from "./objective-queue-start.js";
import { type PoClassification, type PoCounts, type PoIssue, classifyPoIssue, detailComment, digestLine, digestWorthSending, hasDetailComment, issueVersion, orderReady, poObjective } from "./po-triage.js";
import { accountUsageSince, paidTokensSince } from "./usage.js";
import { notifyUser } from "../routes/push.js";

export const MAX_QUEUE_PER_WAKE = 3;
/** Issues read per repo per wake: a bound on GitHub reads, stated in the report when hit. */
export const MAX_ISSUES_PER_REPO = 40;

export type PoAction = "none" | "queued" | "would_queue" | "already_queued" | "already_running" | "held" | "deferred" | "commented" | "would_comment" | "already_commented" | "comment_failed";

export interface PoReportItem {
	repo: string;
	number: number;
	title: string;
	category: PoClassification["category"];
	reason: string;
	action: PoAction;
}

export interface PoReport {
	dryRun: boolean;
	slot: string;
	gate: string | null;
	repos: Array<{ repo: string; read: number; unreadable: boolean; truncated: boolean }>;
	items: PoReportItem[];
	counts: PoCounts;
}

/** GitHub and notification seams, so the wake is tested end to end without the network. */
export interface PoTriageDeps {
	listOpenIssues?: (repo: string) => Promise<{ issues: PoIssue[]; complete: boolean; unreadable: boolean }>;
	listComments?: (repo: string, number: number) => Promise<{ body: string }[]>;
	postComment?: (repo: string, number: number, body: string) => Promise<boolean>;
	notify?: (title: string, body: string) => Promise<void>;
	/** Kick a repo's queue (default `tryDequeueAndStart`). */
	startQueued?: (repoId: string) => Promise<unknown>;
}

export type PoTriageResult = { skipped: true; reason: string; slot: string } | { skipped: false; reportId: string; dryRun: boolean; counts: PoCounts; digest: string | null; gate: string | null };

const slotOf = (now: Date) => new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();

/** What woke a triage (#1232), recorded on its report. */
export type PoTriageSource = "cron" | "manual" | "queue_empty";

export async function runPoTriage(
	env: Env,
	target: { id?: string; instance_id: string; user_id: string },
	config: { dryRun?: boolean },
	now = new Date(),
	deps: PoTriageDeps = {},
	source: PoTriageSource = "cron",
): Promise<PoTriageResult> {
	const iid = target.instance_id;
	const uid = target.user_id;
	const slot = slotOf(now);
	const brain = await readCoderBrain(env, iid, uid);
	if (!brain?.poEnabled) return { skipped: true, reason: "The coder brain or its product-owner triage is off for this instance.", slot };
	// #1028: refuse a paused (or otherwise inactive) instance HERE, before any GitHub read or comment —
	// not only at the queue gate, and not by trusting the fleet classifier, which never read
	// instance status. A paused coder's wake does nothing at all.
	const inst = await env.DB.prepare("SELECT status FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(iid, uid).first<{ status: string }>();
	if (inst?.status !== "active") return { skipped: true, reason: `The instance is ${inst?.status ?? "missing"}, so product-owner triage does not run.`, slot };
	const dryRun = config.dryRun !== false;
	const reportId = crypto.randomUUID();
	const claim = await env.DB.prepare(
		"INSERT INTO po_triage_reports (id, instance_id, user_id, trigger_id, slot, dry_run, status, trigger_source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7) ON CONFLICT(instance_id, slot) DO NOTHING",
	)
		.bind(reportId, iid, uid, target.id ?? null, slot, dryRun ? 1 : 0, source)
		.run();
	if (!claim.meta?.changes) return { skipped: true, reason: "Another product-owner window already woke this instance this minute.", slot };

	try {
		const report = await triage(env, iid, uid, dryRun, slot, deps);
		const inst = await env.DB.prepare(
			"SELECT COALESCE(NULLIF(json_extract(i.config, '$.displayName'), ''), a.name, 'Coder') AS name FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1",
		)
			.bind(iid)
			.first<{ name: string }>();
		const previous = await env.DB.prepare("SELECT report FROM po_triage_reports WHERE instance_id = ?1 AND status = 'completed' ORDER BY created_at DESC, rowid DESC LIMIT 1")
			.bind(iid)
			.first<{ report: string }>();
		const prevCounts = previous?.report ? ((JSON.parse(previous.report) as PoReport).counts ?? null) : null;
		const digest = digestWorthSending(report.counts, prevCounts) ? digestLine(inst?.name ?? "Coder", report.counts, dryRun) : null;
		await env.DB.prepare("UPDATE po_triage_reports SET status = 'completed', report = ?2, digest = ?3 WHERE id = ?1").bind(reportId, JSON.stringify(report), digest).run();
		if (digest) await (deps.notify ?? defaultNotify(env, uid, iid, slot))("Product-owner triage", digest).catch(() => undefined);
		return { skipped: false, reportId, dryRun, counts: report.counts, digest, gate: report.gate };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		await env.DB.prepare("UPDATE po_triage_reports SET status = 'failed', error = ?2 WHERE id = ?1").bind(reportId, clipMarked(message, 500, { within: true })).run();
		throw e;
	}
}

/** Issues in this repo carrying a question the coder asked the owner (#1025) that is still open — they wait on him. */
async function openQuestionIssues(env: Env, iid: string, uid: string, repo: string): Promise<Set<number>> {
	const { results } = await env.DB.prepare(
		"SELECT DISTINCT issue_number AS n FROM coder_questions WHERE instance_id = ?1 AND user_id = ?2 AND repo = ?3 AND issue_number IS NOT NULL AND state IN ('waiting_human', 'brain_deciding', 'escalated')",
	)
		.bind(iid, uid, repo)
		.all<{ n: number }>();
	return new Set((results ?? []).map((r) => Number(r.n)));
}

async function triage(env: Env, iid: string, uid: string, dryRun: boolean, slot: string, deps: PoTriageDeps): Promise<PoReport> {
	const counts: PoCounts = { queued: 0, wouldQueue: 0, alreadyQueued: 0, ready: 0, waiting: 0, blocked: 0, needsDetail: 0, commented: 0 };
	const report: PoReport = { dryRun, slot, gate: await queueGate(env, iid, uid), repos: [], items: [], counts };
	const listOpen = deps.listOpenIssues ?? ((repo) => defaultListOpenIssues(env, uid, repo));
	const listComments = deps.listComments ?? ((repo, n) => listIssueComments(env, uid, repo, n));
	const postComment = deps.postComment ?? ((repo, n, body) => postIssueComment(env, uid, repo, n, body));
	const repos = (await listRepos(env, iid, uid)).filter((r) => r.githubRepo);

	for (const repo of repos) {
		const name = repo.githubRepo as string;
		const page = await listOpen(name);
		const issues = page.issues.slice(0, MAX_ISSUES_PER_REPO);
		report.repos.push({ repo: name, read: issues.length, unreadable: page.unreadable, truncated: !page.complete || page.issues.length > issues.length });
		const open = new Set(page.issues.map((i) => i.number));
		const openQuestions = await openQuestionIssues(env, iid, uid, name);
		const ready: Array<{ issue: PoIssue }> = [];
		for (const issue of issues) {
			const c = classifyPoIssue(issue, { openIssues: open, openListComplete: page.complete, openQuestions });
			const item: PoReportItem = { repo: name, number: issue.number, title: clipMarked(issue.title, 200, { within: true }), category: c.category, reason: c.reason, action: "none" };
			if (c.category === "waiting_on_human") counts.waiting++;
			else if (c.category === "blocked") counts.blocked++;
			else if (c.category === "needs_detail") {
				counts.needsDetail++;
				const version = issueVersion(issue);
				if (dryRun) item.action = "would_comment";
				else if (hasDetailComment(await listComments(name, issue.number), version)) item.action = "already_commented";
				else if (await postComment(name, issue.number, detailComment(c.missing ?? [], version))) {
					item.action = "commented";
					counts.commented++;
				} else item.action = "comment_failed";
			} else {
				counts.ready++;
				ready.push({ issue });
			}
			report.items.push(item);
		}
		// One coder per repo: a repo whose coder is running gets nothing new this wake.
		const busy = await repoHasRunningCoder(env, iid, uid, repo.id);
		let queuedHere = false;
		for (const { issue } of orderReady(ready, page.issues)) {
			const item = report.items.find((i) => i.repo === name && i.number === issue.number) as PoReportItem;
			const objective = poObjective(name, issue);
			const dup = await findDuplicateObjective(env, { userId: uid, instanceId: iid, repoId: repo.id, objective });
			if (dup) {
				item.action = dup.kind === "queued" ? "already_queued" : "already_running";
				counts.alreadyQueued++;
			} else if (report.gate) item.action = "held";
			else if (busy) {
				item.action = "held";
				item.reason = `${item.reason} Held: this repo's coder is already running.`;
			}
			else if (counts.queued + counts.wouldQueue >= MAX_QUEUE_PER_WAKE) item.action = "deferred";
			else if (dryRun) {
				item.action = "would_queue";
				counts.wouldQueue++;
			}
			else {
				await enqueueObjective(env, { instanceId: iid, repoId: repo.id, userId: uid, objective, maxIterations: null, metadata: JSON.stringify({ source: "po_triage", issue: issue.number, slot }) });
				item.action = "queued";
				counts.queued++;
				queuedHere = true;
			}
		}
		// Start the top entry if this repo's coder is idle; busy or paused leaves it queued.
		if (queuedHere) await (deps.startQueued ?? ((repoId) => tryDequeueAndStart(env, iid, repoId, uid)))(repo.id);
	}
	return report;
}

/** A coder run in progress on this repo (or on an unbound session of this instance). */
async function repoHasRunningCoder(env: Env, iid: string, uid: string, repoId: string): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT 1 AS hit FROM agent_loop_runs r LEFT JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.user_id = ?1 AND r.instance_id = ?2 AND r.status = 'running' AND r.checkout_released_at IS NULL AND (s.repo_id = ?3 OR s.repo_id IS NULL) LIMIT 1`,
	)
		.bind(uid, iid, repoId)
		.first<{ hit: number }>();
	return !!row;
}

/**
 * Why nothing may be queued right now, or null. Checked once per wake, before anything is queued.
 * An exceeded ceiling blocks only while budget enforcement is on; when it is off, `warn.note` says so.
 */
export async function queueGate(env: Env, iid: string, uid: string, warn?: { note?: string }): Promise<string | null> {
	const inst = await env.DB.prepare("SELECT status FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(iid, uid).first<{ status: string }>();
	if (inst?.status !== "active") return `The instance is ${inst?.status ?? "missing"}, so nothing is queued.`;
	const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_input_requests WHERE instance_id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at > datetime('now')")
		.bind(iid, uid)
		.first<{ n: number }>()
		.catch(() => null);
	if (pending?.n) return "The coder is waiting on your answer to a question, so nothing new is queued.";
	const caps = await capabilitiesForInstance(env, iid, uid).catch(() => null);
	if (loopDriverFor(caps).id === "coding") {
		const refusal = await codingRunRefusal(env, uid);
		if (refusal) return refusal;
	}
	const providerHold = await automaticProviderHold(env, iid, uid);
	if (providerHold) return providerHold.reason;
	const [usage, paidTokens, ceilings] = await Promise.all([
		accountUsageSince(env, uid, 24).catch(() => ({ chargedMicros: 0, tokens: 0 })),
		paidTokensSince(env, uid, 24),
		resolveAccountCeilings(env, uid).catch(() => ({ chargedMicrosCeiling: DAILY_CEILING_MICROS, tokenCeiling: DAILY_TOKEN_CEILING })),
	]);
	// Money charged, and tokens actually paid for: subscription work and cache reads are not what the ceilings guard (#1276).
	const over = usage.chargedMicros >= ceilings.chargedMicrosCeiling ? "the daily charged-spend ceiling" : paidTokens >= ceilings.tokenCeiling ? "the daily paid-token ceiling" : null;
	if (!over) return null;
	// Enforcement is off by default (#485): the delegation budget already only measures, and this gate said "spent" regardless.
	if (isBudgetEnforced(env)) return `The account's daily budget is spent (${over}), so nothing new is queued.`;
	if (warn) warn.note = `over ${over}, which is not enforced`;
	return null;
}

async function defaultListOpenIssues(env: Env, uid: string, repo: string): Promise<{ issues: PoIssue[]; complete: boolean; unreadable: boolean }> {
	const page = await listIssuesPage(env, uid, repo, { limit: 100 });
	if (page.unreadable) return { issues: [], complete: false, unreadable: true };
	const issues: PoIssue[] = [];
	for (const s of page.issues.slice(0, MAX_ISSUES_PER_REPO)) {
		const detail = await readIssue(env, uid, repo, s.number);
		issues.push({ number: s.number, title: s.title, labels: s.labels, body: detail?.body ?? "" });
	}
	// Issues beyond the read cap still count as OPEN for dependency checks via `complete: false`.
	return { issues, complete: !page.hasMore && page.issues.length <= MAX_ISSUES_PER_REPO, unreadable: false };
}


function defaultNotify(env: Env, uid: string, iid: string, slot: string) {
	return async (title: string, body: string) => {
		await notifyUser(env, uid, "po_triage_digest", title, body, deepLinkFor({ kind: "triggers", instanceId: iid }), { kind: "update", instanceId: iid, key: `po-triage:${iid}:${slot}` });
	};
}

/**
 * Has this coder nothing to do (#1232)? No objective pending in its queue, and no open run that holds a
 * repo or is about to resume one — a run parked on an unanswered question with its checkout released
 * holds nothing (#1228), while one whose answer is in is about to take its repo back.
 */
export async function coderIsIdle(env: Pick<Env, "DB">, instanceId: string): Promise<boolean> {
	const busy = await env.DB.prepare(
		`SELECT (SELECT COUNT(*) FROM instance_objective_queue WHERE instance_id = ?1 AND status = 'pending')
		      + (SELECT COUNT(*) FROM agent_loop_runs r WHERE r.instance_id = ?1 AND r.status = 'running'
		           AND (r.checkout_released_at IS NULL OR EXISTS (SELECT 1 FROM coder_questions q WHERE q.run_id = r.run_id AND q.applied_at IS NULL AND (q.answered_at IS NOT NULL OR q.state = 'unresolved')))) AS n`,
	)
		.bind(instanceId)
		.first<{ n: number }>();
	return !busy?.n;
}

/** The reason a queue-empty wake gives when triage is off — the cue for auto-pickup (#1233) to act instead. */
export const PO_TRIAGE_OFF = "product-owner triage is not on for this instance";

/** At most one queue-empty wake per coder in this window, so a run that fails at once cannot loop (#1232). */
export const QUEUE_EMPTY_DEBOUNCE_MS = 15 * 60_000;

export type QueueEmptyWake = { woke: false; reason: string } | { woke: true; result: PoTriageResult };

/**
 * #1232: a coding run has just ended. If the coder now has nothing to do, triage it NOW instead of
 * leaving it idle until its next hourly window (which stays, as the safety net for issues filed
 * while it was busy).
 *
 * "Nothing to do" is: no objective pending in its queue, and no open run that holds a repo or is
 * about to resume one (a run parked on an unanswered question with its checkout released holds
 * nothing, #1228). The wake runs the instance's own `run_po_triage` trigger — its dry-run setting,
 * its id on the report — and so every guard the hourly wake has: triage on, instance active, the
 * Pro gate, the daily budget, a question waiting on the owner, `needs-human` and blocked issues
 * left alone, and a digest only when something changed. Never throws: it runs on a finished run's
 * terminal path.
 */
export async function wakePoTriageIfIdle(env: Env, instanceId: string, userId: string, now = new Date(), deps: PoTriageDeps = {}): Promise<QueueEmptyWake> {
	try {
		const trigger = await env.DB.prepare("SELECT id, config FROM agent_triggers WHERE instance_id = ?1 AND user_id = ?2 AND action = 'run_po_triage' AND enabled = 1 ORDER BY created_at ASC LIMIT 1")
			.bind(instanceId, userId)
			.first<{ id: string; config: string | null }>();
		if (!trigger) return { woke: false, reason: PO_TRIAGE_OFF };
		if (!(await coderIsIdle(env, instanceId))) return { woke: false, reason: "the coder still has queued or running work" };
		const recent = await env.DB.prepare("SELECT 1 AS x FROM po_triage_reports WHERE instance_id = ?1 AND trigger_source = 'queue_empty' AND created_at > datetime(?2 / 1000, 'unixepoch') LIMIT 1")
			.bind(instanceId, now.getTime() - QUEUE_EMPTY_DEBOUNCE_MS)
			.first<{ x: number }>();
		if (recent) return { woke: false, reason: `a queue-empty triage already ran in the last ${QUEUE_EMPTY_DEBOUNCE_MS / 60_000} minutes` };
		let config: { dryRun?: boolean } = {};
		try {
			config = trigger.config ? (JSON.parse(trigger.config) as { dryRun?: boolean }) : {};
		} catch {
			// A malformed config reads as the wake's own default: a dry run.
		}
		return { woke: true, result: await runPoTriage(env, { id: trigger.id, instance_id: instanceId, user_id: userId }, { dryRun: config.dryRun }, now, deps, "queue_empty") };
	} catch (e) {
		return { woke: false, reason: `the wake failed: ${e instanceof Error ? e.message : String(e)}` };
	}
}
