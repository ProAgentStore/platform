/**
 * Brain-free auto-pickup (#1233): when a coder's queue empties, start its next open GitHub issue —
 * deterministically, by labels and order, with zero model calls.
 *
 * The coder brain's product-owner triage (#1027) also picks up issues, but it needs a model on the
 * owner's key and reads every issue's body. This is the token-free alternative, and the two never
 * both act: with triage on, an empty queue wakes triage (#1232); with it off, this. Same trigger —
 * a coding run's terminal step finding nothing queued — and the same idle test (`coderIsIdle`).
 *
 * Selection ({@link pickNextIssue}, pure): open issues of the repos bound to the coder, minus
 *   • any exclude label — `needs-human`, `blocked-on-serge`, `blocked`, `question`, `wontfix`, plus the
 *     owner's own list;
 *   • pull requests (GitHub lists them as issues; the listing already drops them);
 *   • an issue assigned to a person (a `[bot]` assignee does not count);
 *   • an issue already queued or being worked on this instance;
 *   • an issue two auto-picked runs ended `failed` or `needs_human` on — passed over, with ONE comment on
 *     the issue. A `provider_credit` stop is not counted there: it is the account's fault, held below.
 * Then ordered by priority label (`P0` > `P1` > `P2` > `P3` by default; `P1: blocks users` counts as
 * P1), then `bug` before unlabelled before `enhancement`, then board order where the owner has placed
 * the issue's card (#1097), then oldest (lowest number). Never random.
 *
 * Gates: no provider-account hold (#1314: the owner's key failed for credit/credentials and has not
 * succeeded since — replacement runs would only fail the same way, so none start until it recovers,
 * and the owner is told once), the instance active, no question waiting on the owner, the Pro gate and the daily budget
 * (`queueGate`, shared with triage), and a per-instance daily cap on auto-picked starts. When nothing
 * qualifies, the owner is told once — not on every empty queue.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { listRepos } from "./coding-store.js";
import { deepLinkFor } from "./console-links.js";
import { listIssuesPage, postIssueComment, type IssueSummary } from "./github-issues.js";
import { patchInstanceConfig, parseConfigBlob } from "./instance-config.js";
import { issueJobKey } from "./issue-tickets.js";
import { BUILTIN_EXCLUDE_LABELS, DEFAULT_PRIORITY_LABELS } from "./label-vocabulary.js"; // the label vocabulary's single source (#1245)
import { referencedIssue } from "./objective-dedupe.js";
import { readProviderAccountHealth } from "./provider-account-health.js";
import { enqueueObjective } from "./objective-queue.js";
import { tryDequeueAndStart } from "./objective-queue-start.js";
import { coderIsIdle, PO_TRIAGE_OFF, queueGate, wakePoTriageIfIdle } from "./po-triage-wake.js";
import { notifyUser } from "../routes/push.js";

export interface AutoPickupSettings {
	enabled: boolean;
	/** Priority labels, highest first. A label matches one exactly, or as a prefix followed by `:`, ` ` or `-`. */
	priorityLabels: string[];
	/** Labels that keep an issue out, ON TOP of {@link BUILTIN_EXCLUDE_LABELS}. */
	excludeLabels: string[];
	/** Auto-picked starts per instance per 24 hours. */
	maxPerDay: number;
	/** The iteration ceiling an auto-picked run starts with. */
	maxIterations: number;
}

export const AUTO_PICKUP_DEFAULTS: AutoPickupSettings = { enabled: false, priorityLabels: [...DEFAULT_PRIORITY_LABELS], excludeLabels: [], maxPerDay: 10, maxIterations: 30 };
/** Two auto-picked runs ended failed (or needing a human, #1314) on an issue → it is passed over (#1233's loop guard). */
export const MAX_AUTO_FAILURES = 2;
const MAX_LABELS = 20;

const labelList = (v: unknown, fallback: string[]): string[] =>
	Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 50))] : fallback; // at most MAX_LABELS: refused at the write
const intIn = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

/** The settings stored on the instance (`config.autoPickup`), each field defaulted. */
export function autoPickupFrom(config: unknown): AutoPickupSettings {
	const raw = (typeof config === "string" ? parseConfigBlob(config) : (config as Record<string, unknown> | null) ?? {}).autoPickup;
	const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		enabled: a.enabled === true,
		priorityLabels: labelList(a.priorityLabels, AUTO_PICKUP_DEFAULTS.priorityLabels),
		excludeLabels: labelList(a.excludeLabels, AUTO_PICKUP_DEFAULTS.excludeLabels),
		maxPerDay: intIn(a.maxPerDay, 1, 100, AUTO_PICKUP_DEFAULTS.maxPerDay),
		maxIterations: intIn(a.maxIterations, 1, 100, AUTO_PICKUP_DEFAULTS.maxIterations),
	};
}

/** What is wrong with a settings patch, or null. Validated at the boundary, so a stored value is always usable. */
export function autoPickupPatchProblem(patch: Record<string, unknown>): string | null {
	const known = new Set(["enabled", "priorityLabels", "excludeLabels", "maxPerDay", "maxIterations"]);
	const unknown = Object.keys(patch).filter((k) => !known.has(k));
	if (unknown.length) return `Unknown auto-pickup setting(s): ${unknown.join(", ")}.`;
	if ("enabled" in patch && typeof patch.enabled !== "boolean") return "enabled must be true or false.";
	for (const k of ["priorityLabels", "excludeLabels"] as const) {
		const v = patch[k];
		if (k in patch && (!Array.isArray(v) || v.length > MAX_LABELS || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 50))) return `${k} must be a list of at most ${MAX_LABELS} labels, each 1-50 characters.`;
	}
	if ("maxPerDay" in patch && intIn(patch.maxPerDay, 1, 100, -1) < 0) return "maxPerDay must be a whole number from 1 to 100.";
	if ("maxIterations" in patch && intIn(patch.maxIterations, 1, 100, -1) < 0) return "maxIterations must be a whole number from 1 to 100.";
	return null;
}

export async function readAutoPickup(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<AutoPickupSettings | null> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>();
	return row ? autoPickupFrom(row.config) : null;
}

export async function setAutoPickup(env: Env, instanceId: string, userId: string, patch: Record<string, unknown>): Promise<AutoPickupSettings> {
	const problem = autoPickupPatchProblem(patch);
	if (problem) throw new Error(problem);
	const current = await readAutoPickup(env, instanceId, userId);
	if (!current) throw new Error("instance not found");
	const next = autoPickupFrom({ autoPickup: { ...current, ...patch } });
	if (!(await patchInstanceConfig(env, instanceId, userId, "autoPickup", next))) throw new Error("instance not found");
	return next;
}

// ── Selection (pure) ────────────────────────────────────────────────────────────────────────────

export interface PickCandidate {
	repo: string;
	repoId: string;
	issue: IssueSummary;
	/** The issue card's board position (#1097), when the owner placed it. */
	boardPosition: number | null;
	/** Auto-picked runs on this issue that ended failed. */
	failures: number;
	/** Already queued or being worked on this instance. */
	inFlight: boolean;
}

export type PickVerdict = { pick: PickCandidate; skippedFailed: PickCandidate[] } | { pick: null; skippedFailed: PickCandidate[]; reason: string };

const lower = (s: string) => s.trim().toLowerCase();
function labelMatches(label: string, wanted: string): boolean {
	const l = lower(label);
	const w = lower(wanted);
	return l === w || (l.startsWith(w) && /[:\s-]/.test(l.charAt(w.length)));
}
/** Index of the best (highest) priority label on the issue; unprioritised issues sort after every listed one. */
export function priorityRank(labels: string[], priorityLabels: string[]): number {
	const i = priorityLabels.findIndex((p) => labels.some((l) => labelMatches(l, p)));
	return i < 0 ? priorityLabels.length : i;
}
/** `bug` before unlabelled before `enhancement`. */
export function kindRank(labels: string[]): number {
	if (labels.some((l) => labelMatches(l, "bug"))) return 0;
	if (labels.some((l) => labelMatches(l, "enhancement"))) return 2;
	return 1;
}

/** Why an issue is not eligible, or null when it is. */
export function exclusionReason(c: PickCandidate, settings: Pick<AutoPickupSettings, "excludeLabels">): string | null {
	const excluded = [...BUILTIN_EXCLUDE_LABELS, ...settings.excludeLabels].find((x) => c.issue.labels.some((l) => lower(l) === lower(x)));
	if (excluded) return `labelled \`${excluded}\``;
	const person = (c.issue.assignees ?? []).find((a) => !a.endsWith("[bot]"));
	if (person) return `assigned to ${person}`;
	if (c.inFlight) return "already queued or running";
	if (c.failures >= MAX_AUTO_FAILURES) return `${c.failures} auto-picked runs on it ended failed or needing a human`;
	return null;
}

/** The next issue to start, deterministically. Pure: every decision worth a test is here. */
export function pickNextIssue(candidates: PickCandidate[], settings: Pick<AutoPickupSettings, "priorityLabels" | "excludeLabels">): PickVerdict {
	const skippedFailed = candidates.filter((c) => exclusionReason(c, settings)?.includes("ended failed"));
	const eligible = candidates.filter((c) => exclusionReason(c, settings) === null);
	eligible.sort(
		(a, b) =>
			priorityRank(a.issue.labels, settings.priorityLabels) - priorityRank(b.issue.labels, settings.priorityLabels) ||
			kindRank(a.issue.labels) - kindRank(b.issue.labels) ||
			// Placed cards first, by position; unplaced after (#1097's reading of "never placed").
			(a.boardPosition === null ? 1 : 0) - (b.boardPosition === null ? 1 : 0) ||
			(a.boardPosition ?? 0) - (b.boardPosition ?? 0) ||
			a.issue.number - b.issue.number ||
			a.repo.localeCompare(b.repo),
	);
	if (eligible[0]) return { pick: eligible[0], skippedFailed };
	return { pick: null, skippedFailed, reason: candidates.length ? `none of the ${candidates.length} open issue(s) qualifies` : "there are no open issues" };
}

export function autoPickupObjective(repo: string, issue: Pick<IssueSummary, "number" | "title">): string {
	return `Implement GitHub issue #${issue.number} in ${repo}: ${issue.title}. Read the issue and all its comments first. Add tests. Commit and push to main with "closes #${issue.number}" in the commit message once it is fully resolved.`;
}

// ── The wake ────────────────────────────────────────────────────────────────────────────────────

export interface AutoPickupDeps {
	listOpenIssues?: (repo: string) => Promise<{ issues: IssueSummary[]; unreadable: boolean }>;
	postComment?: (repo: string, number: number, body: string) => Promise<boolean>;
	notify?: (title: string, body: string) => Promise<void>;
	startQueued?: (repoId: string) => Promise<unknown>;
}

export type AutoPickupResult = { started: false; reason: string } | { started: true; repo: string; issue: number; entryId: string };

type PickupOutcome = "started" | "none_eligible" | "skipped_failed" | "capped" | "skipped_gate" | "skipped_busy" | "error";

/** A skip repeated with the same reason is written once an hour, so a blocked coder leaves a row to read, not one per sweep (#1276). */
export const SKIP_LOG_DEBOUNCE_MS = 60 * 60_000;

async function log(env: Env, iid: string, uid: string, outcome: PickupOutcome, detail: string, repo: string | null = null, issue: number | null = null, now = Date.now()): Promise<void> {
	await env.DB.prepare("INSERT INTO auto_pickup_log (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
		.bind(crypto.randomUUID(), iid, uid, repo, issue, outcome, detail, now)
		.run();
}

/** Record a refusal with its reason (#1276), unless the same one was written within {@link SKIP_LOG_DEBOUNCE_MS}; true when a row was written. Never throws. */
async function logSkip(env: Env, iid: string, uid: string, outcome: "skipped_gate" | "skipped_busy" | "capped" | "error", reason: string, now: number): Promise<boolean> {
	try {
		const detail = clipMarked(reason, 300);
		const seen = await env.DB.prepare("SELECT 1 AS x FROM auto_pickup_log WHERE instance_id = ?1 AND outcome = ?2 AND detail = ?3 AND created_at > ?4 LIMIT 1").bind(iid, outcome, detail, now - SKIP_LOG_DEBOUNCE_MS).first<{ x: number }>();
		if (!seen) await log(env, iid, uid, outcome, detail, null, null, now);
		return !seen;
	} catch {
		// The log is a trace of the decision; failing to write it must not change the decision.
		return false;
	}
}

/** A wake that threw outside `runAutoPickup` (the sweeper's drain): written to the log when auto-pickup is on for the coder. */
export async function recordWakeError(env: Env, iid: string, uid: string, e: unknown, now = Date.now()): Promise<void> {
	const settings = await readAutoPickup(env, iid, uid).catch(() => null);
	if (settings?.enabled) await logSkip(env, iid, uid, "error", `the wake failed: ${e instanceof Error ? e.message : String(e)}`, now);
}

/**
 * #1314: the owner's provider account failed (credit/credentials) and its key has not succeeded since.
 * Recovery is read off the record, so there is no lockout to clear: the next successful call on the key
 * (a manual run, or `POST /v1/keys/anthropic/verify`) lifts the hold by itself. Never throws.
 */
async function providerHold(env: Env, uid: string): Promise<{ reason: string } | null> {
	const h = await readProviderAccountHealth(env, uid).catch(() => null);
	if (h?.state !== "failing") return null;
	const what = h.failureClass === "provider_credit" ? "its balance is empty" : "its credentials were rejected";
	return { reason: `the owner's AI provider account failed (${what}) at ${h.lastFailureAt ?? "an unknown time"} and has not succeeded since, so replacement runs would fail the same way. ${h.remedy ?? ""} Auto-pickup resumes once the key succeeds (${h.verify}).`.replace(/\s+/g, " ").trim() };
}

/** Issue numbers already queued or worked on this repo, read from the objectives the queue and the open runs carry. */
async function inFlightIssues(env: Env, iid: string, repoId: string): Promise<Set<number>> {
	const { results } = await env.DB.prepare(
		`SELECT objective FROM instance_objective_queue WHERE instance_id = ?1 AND status = 'pending' AND (repo_id = ?2 OR repo_id IS NULL)
		 UNION ALL
		 SELECT r.objective FROM agent_loop_runs r LEFT JOIN coding_sessions s ON s.id = r.session_id WHERE r.instance_id = ?1 AND r.status = 'running' AND (s.repo_id = ?2 OR s.repo_id IS NULL)`,
	)
		.bind(iid, repoId)
		.all<{ objective: string }>();
	return new Set((results ?? []).map((r) => referencedIssue(r.objective)).filter((n): n is number => n != null));
}

async function failuresByIssue(env: Env, iid: string, repo: string): Promise<Map<number, number>> {
	const { results } = await env.DB.prepare(
		`SELECT json_extract(q.metadata, '$.autoPickup.issue') AS issue, COUNT(*) AS n FROM agent_loop_runs r JOIN instance_objective_queue q ON q.id = r.queue_entry_id
		  WHERE q.instance_id = ?1 AND json_extract(q.metadata, '$.autoPickup.repo') = ?2 AND (r.status = 'failed' OR (r.status = 'needs_human' AND COALESCE(r.stop_reason, '') <> 'provider_credit')) GROUP BY issue`,
	)
		.bind(iid, repo)
		.all<{ issue: number | null; n: number }>();
	return new Map((results ?? []).filter((r) => r.issue != null).map((r) => [Number(r.issue), Number(r.n)] as const));
}

async function boardPositions(env: Env, iid: string): Promise<Map<string, number>> {
	const { results } = await env.DB.prepare("SELECT job_key, position FROM board_items WHERE instance_id = ?1 AND position IS NOT NULL AND job_key LIKE 'issue:%'").bind(iid).all<{ job_key: string; position: number }>();
	return new Map((results ?? []).map((r) => [r.job_key, r.position] as const));
}

/**
 * Start the coder's next eligible issue, if its queue is empty and auto-pickup is on. Never throws:
 * it runs on a finished run's terminal path, and every refusal is a reason.
 */
export async function runAutoPickup(env: Env, iid: string, uid: string, deps: AutoPickupDeps = {}, now = Date.now()): Promise<AutoPickupResult> {
	try {
		const settings = await readAutoPickup(env, iid, uid);
		if (!settings?.enabled) return { started: false, reason: "auto-pickup is off for this instance" };
		if (!(await coderIsIdle(env, iid))) {
			const reason = "the coder still has queued or running work";
			await logSkip(env, iid, uid, "skipped_busy", reason, now);
			return { started: false, reason };
		}
		const warn: { note?: string } = {};
		const gate = await queueGate(env, iid, uid, warn);
		if (gate) {
			await logSkip(env, iid, uid, "skipped_gate", gate, now);
			return { started: false, reason: gate };
		}
		const hold = await providerHold(env, uid);
		if (hold) {
			await logSkip(env, iid, uid, "skipped_gate", hold.reason, now);
			// One notice per failure episode: the sentence names the failure time, so a repeat of it is not news.
			const told = await env.DB.prepare("SELECT 1 AS x FROM auto_pickup_log WHERE instance_id = ?1 AND outcome = 'skipped_gate' AND detail = ?2 AND created_at < ?3 LIMIT 1").bind(iid, clipMarked(hold.reason, 300), now).first<{ x: number }>().catch(() => null);
			if (!told) await (deps.notify ?? defaultNotify(env, uid, iid))("Auto-pickup is paused", hold.reason).catch(() => undefined);
			return { started: false, reason: hold.reason };
		}
		const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM auto_pickup_log WHERE instance_id = ?1 AND outcome = 'started' AND created_at > ?2").bind(iid, now - 86_400_000).first<{ n: number }>();
		if ((today?.n ?? 0) >= settings.maxPerDay) {
			const reason = `the daily cap of ${settings.maxPerDay} auto-picked run(s) is reached`;
			await logSkip(env, iid, uid, "capped", reason, now);
			return { started: false, reason };
		}

		const listOpen = deps.listOpenIssues ?? (async (repo: string) => {
			const page = await listIssuesPage(env, uid, repo, { limit: 100, order: "oldest" });
			return { issues: page.issues, unreadable: !!page.unreadable };
		});
		const positions = await boardPositions(env, iid);
		const candidates: PickCandidate[] = [];
		const unreadable: string[] = [];
		for (const r of await listRepos(env, iid, uid)) {
			if (!r.githubRepo) continue;
			const listed = await listOpen(r.githubRepo);
			if (listed.unreadable) {
				unreadable.push(r.githubRepo);
				continue;
			}
			const [inFlight, failures] = await Promise.all([inFlightIssues(env, iid, r.id), failuresByIssue(env, iid, r.githubRepo)]);
			for (const issue of listed.issues) {
				candidates.push({ repo: r.githubRepo, repoId: r.id, issue, boardPosition: positions.get(issueJobKey(r.id, issue.number)) ?? null, failures: failures.get(issue.number) ?? 0, inFlight: inFlight.has(issue.number) });
			}
		}

		const verdict = pickNextIssue(candidates, settings);
		await commentOnFailedOnce(env, iid, uid, verdict.skippedFailed, deps, now);
		if (!verdict.pick) {
			const reason = `${verdict.reason}${unreadable.length ? ` (could not read ${unreadable.join(", ")})` : ""}`;
			const last = await env.DB.prepare("SELECT outcome FROM auto_pickup_log WHERE instance_id = ?1 AND outcome IN ('started', 'none_eligible') ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(iid).first<{ outcome: string }>();
			await log(env, iid, uid, "none_eligible", reason, null, null, now);
			// Told once: a coder idling with nothing to do does not ping on every empty queue.
			if (last?.outcome !== "none_eligible") await (deps.notify ?? defaultNotify(env, uid, iid))("Auto-pickup: nothing to start", `The queue is empty and ${reason}, so the coder is idle.`).catch(() => undefined);
			return { started: false, reason };
		}

		const { repo, repoId, issue } = verdict.pick;
		const entry = await enqueueObjective(env, { instanceId: iid, repoId, userId: uid, objective: autoPickupObjective(repo, issue), maxIterations: settings.maxIterations, metadata: JSON.stringify({ autoPickup: { repo, issue: issue.number } }) });
		await log(env, iid, uid, "started", `issue #${issue.number}: ${issue.title}${warn.note ? ` (${warn.note})` : ""}`, repo, issue.number, now);
		await (deps.startQueued ?? ((id: string) => tryDequeueAndStart(env, iid, id, uid)))(repoId);
		return { started: true, repo, issue: issue.number, entryId: entry.id };
	} catch (e) {
		const reason = `auto-pickup failed: ${e instanceof Error ? e.message : String(e)}`;
		await logSkip(env, iid, uid, "error", reason, now);
		return { started: false, reason };
	}
}

/** The first time an issue is passed over for repeated failures, say so on the issue — once. */
async function commentOnFailedOnce(env: Env, iid: string, uid: string, skipped: PickCandidate[], deps: AutoPickupDeps, now: number): Promise<void> {
	for (const c of skipped) {
		const seen = await env.DB.prepare("SELECT 1 AS x FROM auto_pickup_log WHERE instance_id = ?1 AND repo = ?2 AND issue_number = ?3 AND outcome = 'skipped_failed' LIMIT 1").bind(iid, c.repo, c.issue.number).first<{ x: number }>();
		if (seen) continue;
		await log(env, iid, uid, "skipped_failed", `${c.failures} auto-picked runs ended failed`, c.repo, c.issue.number, now);
		const body = `**Auto-pickup is passing over this issue.** ${c.failures} runs it started on it ended failed, so it will not start it again by itself. Add the missing detail and start it by hand, or remove the cause, and it becomes eligible once a run on it succeeds.`;
		await (deps.postComment ?? ((repo: string, n: number, b: string) => postIssueComment(env, uid, repo, n, b)))(c.repo, c.issue.number, body).catch(() => false);
	}
}

function defaultNotify(env: Env, uid: string, iid: string) {
	return async (title: string, body: string) => {
		await notifyUser(env, uid, "po_triage_digest", title, body, deepLinkFor({ kind: "coding-tab", instanceId: iid }), { kind: "update", instanceId: iid, key: `auto-pickup:${iid}:none` });
	};
}

/**
 * A coding run ended and nothing was queued behind it: wake whichever picker this coder uses (#1232,
 * #1233). Triage when the brain's product-owner layer is on, else the deterministic picker when
 * auto-pickup is on — never both. Never throws.
 */
export async function wakeIdleCoder(env: Env, iid: string, uid: string): Promise<string> {
	const triage = await wakePoTriageIfIdle(env, iid, uid);
	if (triage.woke || triage.reason !== PO_TRIAGE_OFF) return triage.woke ? "triage" : `triage: ${triage.reason}`;
	const picked = await runAutoPickup(env, iid, uid);
	return picked.started ? `auto-pickup: started #${picked.issue} in ${picked.repo}` : `auto-pickup: ${picked.reason}`;
}

/** Coders woken per timer sweep: a bound on GitHub reads, and the rest are reached on the next sweep. */
export const AUTO_PICKUP_SWEEP_LIMIT = 25;
/** A coder that found nothing to start is not asked again for this long. */
export const AUTO_PICKUP_IDLE_RECHECK_MS = 30 * 60_000;

/**
 * The timer behind auto-pickup (#1276). Waking on a run's end alone left a coder idle forever when
 * the wake was refused once (a gate, an error) and no run ever ended again. This looks, every few
 * minutes, for coders with auto-pickup on and nothing to do, and wakes each the same way a run's end
 * does — so every guard and every log row is the same. A coder whose last wake found nothing
 * eligible is left alone for {@link AUTO_PICKUP_IDLE_RECHECK_MS}. Never throws.
 */
export async function sweepAutoPickup(env: Env, now = Date.now(), wake: typeof wakeIdleCoder = wakeIdleCoder): Promise<{ woken: number }> {
	let woken = 0;
	try {
		const { results } = await env.DB.prepare(
			`SELECT i.id, i.user_id FROM agent_instances i
			  WHERE i.status = 'active' AND json_extract(i.config, '$.autoPickup.enabled') = 1
			    AND NOT EXISTS (SELECT 1 FROM auto_pickup_log l WHERE l.instance_id = i.id AND l.outcome = 'none_eligible' AND l.created_at > ?1)
			  ORDER BY i.id LIMIT ?2`,
		)
			.bind(now - AUTO_PICKUP_IDLE_RECHECK_MS, AUTO_PICKUP_SWEEP_LIMIT)
			.all<{ id: string; user_id: string }>();
		for (const r of results ?? []) {
			try {
				if (!(await coderIsIdle(env, r.id))) continue;
				await wake(env, r.id, r.user_id);
				woken++;
			} catch (e) {
				await recordWakeError(env, r.id, r.user_id, e, now);
			}
		}
	} catch {
		// The next sweep reads again; a failed read must not fail the cron.
	}
	return { woken };
}

/** What coding_loop_status says about auto-pickup (#1233): its settings, which picker an empty queue wakes, and its last decision. */
export async function autoPickupStatus(env: Env, iid: string, uid: string): Promise<AutoPickupSettings & { picker: "triage" | "auto_pickup" | "none"; last: { outcome: string; detail: string | null; at: number } | null }> {
	const [settings, brain, last] = await Promise.all([
		readAutoPickup(env, iid, uid),
		env.DB.prepare("SELECT 1 AS x FROM agent_triggers WHERE instance_id = ?1 AND user_id = ?2 AND action = 'run_po_triage' AND enabled = 1 LIMIT 1").bind(iid, uid).first<{ x: number }>(),
		env.DB.prepare("SELECT outcome, detail, created_at FROM auto_pickup_log WHERE instance_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(iid).first<{ outcome: string; detail: string | null; created_at: number }>(),
	]);
	const s = settings ?? AUTO_PICKUP_DEFAULTS;
	return { ...s, picker: brain ? "triage" : s.enabled ? "auto_pickup" : "none", last: last ? { outcome: last.outcome, detail: last.detail, at: last.created_at } : null };
}
