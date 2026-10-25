/**
 * Release notes for a coder run that shipped to the trunk (#1216).
 *
 * At the end of a run that pushed to the repository's default branch (or merged a pull request into
 * it), ONE plain-language note goes to every selected messaging channel. An opt-in workflow gate
 * queues a direct push until the exact pushed SHA passes each required workflow. It covers the
 * delivered commit range and issues closed by those commits.
 *
 * Channels: the instance's granted Discord and Slack channels, filtered by its release-notes setting
 * (#1217, lib/release-notes-settings.ts) — off, or a chosen subset of the granted channels. A new
 * messaging connector is one entry in `RELEASE_NOTE_PROVIDERS` and one branch in {@link liveDeliver}.
 *
 * What the note claims:
 *   • The push is read from the run's own recorded acts (`act.consequential`, lib/engine-acts.ts),
 *     never inferred. A run with no trunk push or merge gets no note.
 *   • Ungated notes report CI/deploy as GitHub reports it at build time and never say the change
 *     is live. Gated notes claim production only after durable exact-SHA workflow verification.
 *   • No grant means no post, recorded as `release_note_skipped_no_grants`, and nothing fails.
 *   • A failed delivery is logged (`error_log`), traced (`release_note_failed`) and surfaced to the
 *     owner as an in-app alert. It never throws: one channel's failure does not stop the next.
 *
 * Deliveries run through `runStep`, so the workflow can journal each one under its own step name.
 * A replay then does not post twice to a channel that already received the note.
 */
import { clipMarked } from "./clip-marked.js";
import { deepLinkFor } from "./console-links.js";
import { getRepo } from "./coding-store.js";
import { HttpError } from "./auth.js";
import { connectorClient } from "./connectors/client.js";
import { DISCORD_NOT_CONNECTED, postDiscordMessage } from "./connectors/discord.js";
import { deriveAct } from "./engine-acts.js";
import { logError } from "./error-log.js";
import { logEvent } from "./events.js";
import { resolveGithubRead } from "./github-cache.js";
import { commandSchedulesMerge, isMergeUnverified, type MergeEvidence, parseMergeEvidence } from "./merge-evidence.js";
import { grantedReleaseChannels, loadReleaseNotes, releaseGateState, type ReleaseChannel } from "./release-notes-settings.js";
import type { RunStep } from "./runner-availability.js";
import { postSlackMessage, SLACK_NOT_CONNECTED } from "./slack.js";
import { safeFetch } from "./ssrf.js";
import { notifyUser } from "../routes/push.js";
import { getUserProviderKey } from "./user-ai.js";
import type { Env } from "../types.js";

export type { ReleaseChannel } from "./release-notes-settings.js";

/** Discord allows 2,000 characters. The note stays under this, cutting its lists visibly. */
export const RELEASE_NOTE_MAX_CHARS = 1_800;
/** How many commits one note reads. A run that pushed more says so. */
export const RELEASE_NOTE_MAX_COMMITS = 50;

export type CiStatus = "pending" | "success" | "failure" | "unknown";

export interface ReleaseNoteContext {
	instanceId: string;
	runId: string;
	/** `owner/name` on GitHub, or the repo's display label when it is not a GitHub repo. */
	repo: string;
	defaultBranch: string;
	/** `abc1234…def5678 (3 commits)`; null when GitHub could not be read. */
	commitRange: string | null;
	/** Commit subjects, newest first. */
	changes: string[];
	/** True when the run pushed more than {@link RELEASE_NOTE_MAX_COMMITS} commits and only those were read. */
	changesCapped: boolean;
	closedIssues: { number: number; title: string | null }[];
	ciStatus: CiStatus;
	/** The head commit CI was read for, when there is one. */
	headSha: string | null;
	pushedAt: string;
	/** Gated notes: subjects left out of `changes` because the verified range was longer than the rendered summary (#1349). */
	changesOmitted?: number;
	/**
	 * Gated notes (#1349): the runner-recorded range, not yet read from GitHub. Present until the queue tick has paged the
	 * whole `base...head` compare, verified it, and replaced this with the real commits; absent afterwards.
	 */
	pendingRange?: { base: string; head: string; branch: string; /** Synchronous PR merges inside the range, re-verified against GitHub by the tick (#1350). */ merges?: MergeEvidence[] };
}

export interface ReleaseNoteInput {
	env: Env;
	userId: string;
	instanceId: string;
	/** The loop run id. Its acts are recorded under it as the trace id. */
	runId: string;
	/** The run's `coding_repos` row: its GitHub `owner/name` and branch are read from it. */
	repoId: string;
	/** The label the run reports the repo under, used when there is no GitHub repo. */
	repoLabel: string;
	runStartedAt: number;
	sessionId: string;
}

export type Deliver = (channel: ReleaseChannel, text: string) => Promise<{ ok: true; permalink?: string } | { ok: false; error: string }>;

const slackPermalink = (channelId: string, ts: string | null): string | undefined => ts && /^\d+\.\d+$/.test(ts) ? `https://app.slack.com/archives/${channelId}/p${ts.replace(".", "")}` : undefined;

export interface ReleaseNoteDeps {
	/** GET a GitHub REST path (`/repos/…`). Null when it cannot be read. */
	githubGet: (path: string) => Promise<unknown>;
	deliver: Deliver;
	now: () => number;
}


export interface ReleaseNoteOutcome {
	status: "not_shipped" | "disabled" | "no_channels" | "posted" | "queued" | "unverified";
	sent: string[];
	failed: { grantId: string; error: string }[];
}

/** Why a run's delivery cannot be turned into one exact range. A code means a typed, owner-visible hold (#1350). */
export type DeliveredRange =
	| { ok: true; base: string; head: string; branch: string; merges: MergeEvidence[] }
	| { ok: false; code: PrHoldCode | null; reason: string };
export type PrHoldCode = "pr_merge_auto" | "pr_merge_old_runner" | "pr_merge_unverified" | "pr_range_not_contiguous";

type Segment = { before: string; after: string; branch: string; merge: MergeEvidence | null };

/** `a` and `b` name the same commit when one is a prefix of the other (a push prints abbreviations, a merge full SHAs). */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

const MERGE_UNVERIFIED_WORDS: Record<string, string> = {
	auto: "the merge was only requested (--auto or the merge queue), not completed",
	scheduled: "the merge was only scheduled, not completed",
	unrecognized_output: "the merge command's output does not say the pull request was merged",
	not_merged: "GitHub says the pull request is not merged",
	wrong_branch: "the pull request did not merge into the repository's default branch",
	method_unknown: "the merge method could not be read from the command",
	method_mismatch: "the merge result is not what the stated merge method produces",
	actor_mismatch: "the pull request was not merged by this run's account during this command",
	unreadable: "GitHub could not be read to prove the merge",
	malformed: "the runner's merge evidence is not valid for this contract version",
};

/**
 * The contiguous range this run delivered to the trunk, from its own recorded acts: direct pushes (their printed
 * `old..new`) and synchronous PR merges (the runner's v1 `merge` evidence), chained newest to oldest. Each boundary
 * must meet the next: a gap or overlap is an intervening update this run did not make, and is held rather than
 * summarized as one release. Never the branch HEAD, never inferred later.
 */
async function runDeliveredRange(env: Env, input: { instanceId: string; userId: string; runId: string }): Promise<DeliveredRange> {
	const rows = await env.DB.prepare("SELECT context FROM agent_events WHERE instance_id = ?1 AND user_id = ?2 AND trace_id = ?3 AND event = 'act.consequential' ORDER BY ts DESC, rowid DESC")
		.bind(input.instanceId, input.userId, input.runId).all<{ context: string | null }>();
	const segments: Segment[] = [];
	const merges: MergeEvidence[] = [];
	let sawMerge = false;
	const hold = (code: PrHoldCode | null, reason: string): DeliveredRange => ({ ok: false, code: code && (sawMerge || code.startsWith("pr_merge")) ? code : null, reason });
	for (const row of rows.results ?? []) {
		let act: { act?: unknown; ok?: unknown; pushedSha?: unknown; pushedFromSha?: unknown; command?: unknown; target?: unknown; merge?: unknown; mergeUnverified?: unknown; mergeDetail?: unknown };
		try { act = JSON.parse(row.context ?? "{}"); } catch { return hold(null, "An unreadable act cannot authorize a release."); }
		if (act.act !== "push.trunk" && act.act !== "pr.merge") continue;
		if (act.ok === false) continue; // A refused push or a failed merge changed no remote ref.
		if (act.act === "pr.merge") {
			sawMerge = true;
			if (act.ok !== true) return hold("pr_merge_unverified", "A pull request merge was started but never observed to finish, so what it delivered is unknown.");
			// The command line alone says it only asked for a merge later; no attached evidence overrides that.
			if (commandSchedulesMerge(String(act.command ?? ""))) return hold("pr_merge_auto", MERGE_UNVERIFIED_WORDS.auto);
			const evidence = parseMergeEvidence(act.merge);
			if (!evidence) {
				if (isMergeUnverified(act.mergeUnverified)) {
					const code = act.mergeUnverified === "auto" || act.mergeUnverified === "scheduled" ? "pr_merge_auto" : "pr_merge_unverified";
					return hold(code, `${MERGE_UNVERIFIED_WORDS[act.mergeUnverified]}${typeof act.mergeDetail === "string" && act.mergeDetail ? ` (${act.mergeDetail})` : ""}`);
				}
				return hold("pr_merge_old_runner", "This pull request merge was recorded by a runner older than CLI 0.4.180, which does not report what a merge delivered. Update the runner (pags update); the merge cannot be proved from the branch head.");
			}
			segments.push({ before: evidence.beforeSha, after: evidence.afterSha, branch: evidence.baseRef, merge: evidence });
			merges.push(evidence);
			continue;
		}
		// An unknown push cannot be attributed to a range.
		if (act.ok !== true || deriveAct("push.trunk", String(act.command ?? "")).phrase !== "pushed directly to the trunk") return hold(null, "A trunk push was not observed to finish.");
		const parts = typeof act.target === "string" ? act.target.split(/\s+/) : [];
		const branch = parts[1]?.replace(/^HEAD:/, "").replace(/^refs\/heads\//, "");
		if (parts[0] !== "origin" || !branch || typeof act.pushedSha !== "string" || !/^[0-9a-f]{7,40}$/.test(act.pushedSha) || typeof act.pushedFromSha !== "string" || !/^[0-9a-f]{7,40}$/.test(act.pushedFromSha)) return hold(null, "The push result did not identify its new commit.");
		segments.push({ before: act.pushedFromSha, after: act.pushedSha, branch, merge: null });
	}
	if (!segments.length) return hold(null, "The push result did not identify its new commit.");
	for (let i = 1; i < segments.length; i++) {
		const newer = segments[i - 1];
		const older = segments[i];
		if (older.branch !== newer.branch) return hold("pr_range_not_contiguous", `This run delivered to ${older.branch} and ${newer.branch}; separate releases are not summarized as one.`);
		if (!sameCommit(older.after, newer.before)) return hold("pr_range_not_contiguous", `The delivered ranges are not contiguous: one ends at ${shortSha(older.after)} but the next starts at ${shortSha(newer.before)}, so another update landed between them and they are not one release.`);
	}
	return { ok: true, base: segments[segments.length - 1].before, head: segments[0].after, branch: segments[0].branch, merges: merges.reverse() };
}

const SHA = /^[0-9a-f]{7}/;
const shortSha = (sha: string) => SHA.exec(sha)?.[0] ?? sha;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** The issue numbers a set of commit messages close, in first-seen order. */
export function closedIssueNumbers(messages: readonly string[]): number[] {
	const seen = new Set<number>();
	for (const m of messages) for (const hit of m.matchAll(CLOSING)) seen.add(Number(hit[1]));
	return [...seen];
}

/** Did this run push to the trunk, or merge into it? Read from its own recorded acts. */
export async function runShippedToTrunk(env: Env, input: { instanceId: string; userId: string; runId: string }, mode: "attempted" | "completed" = "completed"): Promise<boolean> {
	const rows = await env.DB.prepare("SELECT context FROM agent_events WHERE instance_id = ?1 AND user_id = ?2 AND trace_id = ?3 AND event = 'act.consequential'")
		.bind(input.instanceId, input.userId, input.runId)
		.all<{ context: string | null }>();
	return (rows.results ?? []).some((r) => {
		let c: { act?: unknown; command?: unknown; ok?: unknown };
		try {
			c = JSON.parse(r.context ?? "{}") as typeof c;
		} catch {
			return false; // an unreadable act row is no evidence of a push
		}
		if (c.ok === false || typeof c.act !== "string") return false;
		// A merge counts as shipped only when it is known to have completed: observed to succeed, and not a request that
		// is merely scheduled (--auto, the merge queue) or that GitHub says did not merge (#1350).
		if (c.act === "pr.merge") {
			// "attempted" is the gated path's question: did the run try to deliver by merge? An unproved merge must then become
			// a visible HELD row, not silence. "completed" is the status note's: only a merge known to have happened announces.
			if (mode === "attempted") return true;
			const m = c as { mergeUnverified?: unknown };
			return c.ok === true && !commandSchedulesMerge(String(c.command ?? "")) && m.mergeUnverified !== "auto" && m.mergeUnverified !== "scheduled" && m.mergeUnverified !== "not_merged";
		}
		return c.act === "push.trunk" && deriveAct(c.act, String(c.command ?? "")).phrase === "pushed directly to the trunk";
	});
}

function ciFrom(raw: unknown): CiStatus {
	const runs = (raw as { workflow_runs?: Array<{ status?: unknown; conclusion?: unknown }> } | null)?.workflow_runs;
	if (!Array.isArray(runs)) return "unknown";
	if (!runs.length) return "pending";
	if (runs.some((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral")) return "failure";
	return runs.every((r) => r.status === "completed") ? "success" : "pending";
}

/** Gather what the note says: the commits this run put on the branch, the issues they close, CI for the head. */
export async function collectReleaseNoteContext(input: ReleaseNoteInput, deps: ReleaseNoteDeps): Promise<ReleaseNoteContext> {
	const row = await getRepo(input.env, input.instanceId, input.userId, input.repoId).catch(() => null);
	const githubRepo = row?.githubRepo ?? null;
	// `branch` '' is the repository's default branch (migration 0020): ask GitHub for its name.
	let branch = row?.branch ?? "";
	if (!branch && githubRepo) {
		const meta = (await deps.githubGet(`/repos/${githubRepo}`)) as { default_branch?: unknown } | null;
		branch = typeof meta?.default_branch === "string" ? meta.default_branch : "";
	}
	const base: ReleaseNoteContext = {
		instanceId: input.instanceId,
		runId: input.runId,
		repo: githubRepo ?? input.repoLabel,
		defaultBranch: branch || "default branch",
		commitRange: null,
		changes: [],
		changesCapped: false,
		closedIssues: [],
		ciStatus: "unknown",
		headSha: null,
		pushedAt: new Date(deps.now()).toISOString(),
	};
	if (!githubRepo) return base;
	const repo = githubRepo;
	const since = new Date(input.runStartedAt).toISOString();
	const raw = await deps.githubGet(`/repos/${repo}/commits?${branch ? `sha=${encodeURIComponent(branch)}&` : ""}since=${encodeURIComponent(since)}&per_page=${RELEASE_NOTE_MAX_COMMITS}`);
	const commits = Array.isArray(raw) ? (raw as Array<{ sha?: unknown; commit?: { message?: unknown } }>).filter((c) => typeof c.sha === "string") : null;
	if (!commits?.length) return base;
	const messages = commits.map((c) => String(c.commit?.message ?? ""));
	const head = String(commits[0].sha);
	const oldest = String(commits[commits.length - 1].sha);
	const closedIssues = await Promise.all(
		closedIssueNumbers(messages).map(async (number) => {
			const issue = (await deps.githubGet(`/repos/${repo}/issues/${number}`)) as { title?: unknown } | null;
			return { number, title: typeof issue?.title === "string" ? issue.title : null };
		}),
	);
	return {
		...base,
		commitRange: commits.length === 1 ? `${shortSha(head)} (1 commit)` : `${shortSha(oldest)}…${shortSha(head)} (${commits.length} commits)`,
		changes: messages.map((m) => m.split("\n")[0].trim()).filter(Boolean),
		changesCapped: commits.length >= RELEASE_NOTE_MAX_COMMITS,
		closedIssues,
		headSha: head,
		ciStatus: ciFrom(await deps.githubGet(`/repos/${repo}/actions/runs?head_sha=${head}&per_page=30`)),
	};
}

function ciLine(ctx: ReleaseNoteContext): string {
	const at = ctx.headSha ? ` for ${shortSha(ctx.headSha)}` : "";
	switch (ctx.ciStatus) {
		case "success":
			return `CI/deploy: ✅ every workflow run${at} passed`;
		case "failure":
			return `CI/deploy: ❌ a workflow run${at} failed`;
		case "pending":
			return `CI/deploy: ⏳ pending${at} — not yet verified`;
		default:
			return "CI/deploy: unknown — not verified";
	}
}

/** Fit `items` into `budget` characters, saying how many were left out. */
function fitList(items: readonly string[], budget: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (const [i, item] of items.entries()) {
		const more = `  …and ${items.length - i} more`;
		if (used + item.length + 1 + more.length + 1 > budget) {
			out.push(more);
			return out;
		}
		out.push(item);
		used += item.length + 1;
	}
	return out;
}

/** The note: plain text, no markdown headings, at most {@link RELEASE_NOTE_MAX_CHARS} characters. */
export function buildReleaseNoteText(ctx: ReleaseNoteContext): string {
	const head = [`🚀 Shipped to ${ctx.repo} (${ctx.defaultBranch})`, `Run ${ctx.runId} · ${ctx.pushedAt}`, "", `Commits: ${ctx.commitRange ?? "could not be read from GitHub"}`];
	const ci = ["", ciLine(ctx)];
	const issues = ctx.closedIssues.map((i) => clipMarked(`  • #${i.number} ${i.title ?? "(title could not be read)"}`, 200));
	const changes = ctx.changes.map((c) => clipMarked(`  • ${c}`, 200));
	if (ctx.changesCapped) changes.push(`  (only the newest ${RELEASE_NOTE_MAX_COMMITS} commits were read)`);
	const fixed = [...head, ...ci].join("\n").length + 40; // headings and blank lines
	const budget = RELEASE_NOTE_MAX_CHARS - fixed;
	const issueLines = issues.length ? fitList(issues, Math.floor(budget / 2)) : [];
	const usedByIssues = issueLines.join("\n").length;
	const changeLines = changes.length ? fitList(changes, budget - usedByIssues) : [];
	const body = [...(changeLines.length ? ["", "What changed:", ...changeLines] : []), ...(issueLines.length ? ["", "Closed issues:", ...issueLines] : [])];
	return [...head, ...body, ...ci].join("\n");
}

/** Post the run's release note to every granted channel. Never throws. */
export async function postReleaseNotes(input: ReleaseNoteInput, deps: ReleaseNoteDeps = liveDeps(input), runStep: RunStep = (_n, fn) => fn()): Promise<ReleaseNoteOutcome> {
	const { env, userId, instanceId, runId } = input;
	const trace = { source: "coding", userId, instanceId, traceId: runId };
	const plan = (await runStep("release-notes-plan", async () => {
		if (!(await runShippedToTrunk(env, { instanceId, userId, runId }, "attempted"))) return null;
		const settings = await loadReleaseNotes(env, instanceId, userId);
		// Without a gate the note is a status note: it announces only a delivery that is known to have completed.
		if (!settings?.instance.requiredWorkflows?.length && !(await runShippedToTrunk(env, { instanceId, userId, runId }))) return null;
		if (!settings?.effective.enabled) return { disabled: true, channels: [], repo: input.repoLabel, text: "" };
		const channels: ReleaseChannel[] = settings.effective.channels.filter((c) => c.selected).map(({ selected: _s, ...c }) => c);
		if (!channels.length) return { channels, repo: input.repoLabel, text: "" };
		if (settings.instance.requiredWorkflows?.length) {
			const delivered = await runDeliveredRange(env, { instanceId, userId, runId });
			if (!delivered.ok && !delivered.code) return { channels, repo: input.repoLabel, text: "", unverified: delivered.reason };
			// The range itself is read, paged and verified by the queue tick (#1349), where a rate limit can be waited out. Here
			// we only record what the runner proved: the repository, the branch it delivered to, and the old and new commits.
			const repoRow = await getRepo(env, instanceId, userId, input.repoId).catch(() => null);
			if (!repoRow?.githubRepo) return { channels, repo: input.repoLabel, text: "", unverified: "This repository is not a GitHub repository, so the delivered commit cannot be verified." };
			const empty: ReleaseNoteContext = { instanceId, runId, repo: repoRow.githubRepo, defaultBranch: repoRow.branch || "default branch", commitRange: null, changes: [], changesCapped: false, closedIssues: [], ciStatus: "pending", headSha: null, pushedAt: new Date(deps.now()).toISOString() };
			// A PR merge outcome that cannot be proved is held as a visible row, not just an event (#1350).
			if (!delivered.ok) return { channels, repo: empty.repo, text: "", unverified: delivered.reason, held: { code: delivered.code, context: empty, workflows: settings.instance.requiredWorkflows } };
			if (repoRow.branch && repoRow.branch !== delivered.branch) return { channels, repo: input.repoLabel, text: "", unverified: "The run delivered to a branch other than the repository's configured default branch." };
			const ctx: ReleaseNoteContext = { ...empty, defaultBranch: delivered.branch, pendingRange: { base: delivered.base, head: delivered.head, branch: delivered.branch, ...(delivered.merges.length ? { merges: delivered.merges } : {}) } };
			return { channels, repo: ctx.repo, text: "", queued: { context: ctx, workflows: settings.instance.requiredWorkflows } };
		}
		const ctx = await collectReleaseNoteContext(input, deps);
		return { channels, repo: ctx.repo, text: buildReleaseNoteText(ctx) };
	})) as { disabled?: true; channels: ReleaseChannel[]; repo: string; text: string; unverified?: string; held?: { code: PrHoldCode; context: ReleaseNoteContext; workflows: NonNullable<import("../agent-types.js").InstanceReleaseNotes["requiredWorkflows"]> }; queued?: { context: ReleaseNoteContext; workflows: NonNullable<import("../agent-types.js").InstanceReleaseNotes["requiredWorkflows"]> } } | null;
	if (!plan) return { status: "not_shipped", sent: [], failed: [] };
	if (plan.disabled) {
		await logEvent(env, { ...trace, event: "release_note_skipped_disabled", message: "Release note not posted: release notes are turned off for this instance." }).catch(() => undefined);
		return { status: "disabled", sent: [], failed: [] };
	}
	if (!plan.channels.length) {
		await logEvent(env, { ...trace, event: "release_note_skipped_no_grants", message: "Release note not posted: no messaging channel is granted to this instance, or none is chosen to receive release notes." }).catch(() => undefined);
		return { status: "no_channels", sent: [], failed: [] };
	}
	if (plan.unverified) {
		for (const channel of plan.held ? plan.channels : []) {
			await runStep(`release-note-held:${channel.grantId}`, async () => {
				if (!plan.held) return;
				const now = Date.now();
				await env.DB.prepare(`INSERT OR IGNORE INTO release_note_queue
					(id,user_id,instance_id,repo_id,github_repo,default_branch,run_id,session_id,sha,grant_id,context_json,workflows_json,status,hold_code,reason,created_at,updated_at)
					VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'held',?13,?14,?15,?15)`)
					.bind(crypto.randomUUID(), userId, instanceId, input.repoId, plan.held.context.repo, plan.held.context.defaultBranch, runId, input.sessionId, `unverified:${runId}`, channel.grantId, JSON.stringify(plan.held.context), JSON.stringify(plan.held.workflows), plan.held.code, plan.unverified, now).run();
			});
		}
		await logEvent(env, { ...trace, event: "release_note_unverified", level: "warn", message: `Release note held: ${plan.unverified}` }).catch(() => undefined);
		await notifyUser(env, userId, "coding", "⚠️ Release note held", `${plan.repo}: ${plan.unverified}`, deepLinkFor({ kind: "coding-session", instanceId, sessionId: input.sessionId }), { key: `release-note-unverified:${runId}`, kind: "alert", instanceId }).catch(() => undefined);
		return { status: "unverified", sent: [], failed: [] };
	}
	if (plan.queued) {
		for (const channel of plan.channels) {
			await runStep(`release-note-queue:${channel.grantId}`, async () => {
				const ctx = plan.queued?.context;
				// Until the tick has read the range the row is keyed by the pushed prefix; it takes the full SHA once verified.
				const rowSha = ctx?.headSha ?? ctx?.pendingRange?.head;
				if (!ctx || !rowSha) return;
				const now = Date.now();
				// An old gate (no deploy job/step) is queued HELD, never `pending`: it may not make the production claim (#1346).
				const gate = releaseGateState(plan.queued?.workflows);
				const ready = gate.state === "ready";
				await env.DB.prepare(`INSERT OR IGNORE INTO release_note_queue
					(id,user_id,instance_id,repo_id,github_repo,default_branch,run_id,session_id,sha,grant_id,context_json,workflows_json,status,reason,created_at,updated_at)
					VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)`)
					.bind(crypto.randomUUID(), userId, instanceId, input.repoId, ctx.repo, ctx.defaultBranch, runId, input.sessionId, rowSha, channel.grantId, JSON.stringify(ctx), JSON.stringify(plan.queued?.workflows), ready ? "pending" : "configuration_required", ready ? null : gate.message ?? null, now).run();
			});
		}
		const held = releaseGateState(plan.queued.workflows).state !== "ready";
		await logEvent(env, { ...trace, event: held ? "release_note_configuration_required" : "release_note_queued", ...(held ? { level: "warn" as const } : {}), message: held ? `Release note held for ${plan.queued.context.pendingRange?.head}: the release gate has no deploy job and step. ${releaseGateState(plan.queued.workflows).message}` : `Release note queued for ${plan.queued.context.pendingRange?.head}: its commit range and required GitHub workflows are read by the release queue.` }).catch(() => undefined);
		return { status: "queued", sent: [], failed: [] };
	}
	const outcome: ReleaseNoteOutcome = { status: "posted", sent: [], failed: [] };
	for (const channel of plan.channels) {
		const result = (await runStep(`release-note:${channel.grantId}`, async () => {
			try {
				return await deps.deliver(channel, plan.text);
			} catch (e) {
				return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
			}
		})) as Awaited<ReturnType<Deliver>>;
		if (result.ok) {
			outcome.sent.push(channel.grantId);
			await logEvent(env, { ...trace, event: "release_note_sent", message: `Release note posted to ${channel.provider} ${channel.name}`, context: { provider: channel.provider, grantId: channel.grantId, channelId: channel.channelId } }).catch(() => undefined);
			continue;
		}
		outcome.failed.push({ grantId: channel.grantId, error: result.error });
		const message = `Release note could not be posted to ${channel.provider} ${channel.name}: ${result.error}`;
		const context = { provider: channel.provider, grantId: channel.grantId, channelId: channel.channelId, instanceId, runId };
		await logError(env, { source: "release-notes", message, userId, context }).catch(() => undefined);
		await logEvent(env, { ...trace, event: "release_note_failed", level: "error", message, context }).catch(() => undefined);
	}
	if (outcome.failed.length) {
		await notifyUser(
			env,
			userId,
			"coding",
			"⚠️ Release note not delivered",
			`${plan.repo}: ${outcome.failed.length} of ${plan.channels.length} channel(s) did not receive this run's release note. ${outcome.failed[0].error}`,
			deepLinkFor({ kind: "coding-session", instanceId, sessionId: input.sessionId }),
			{ key: `release-note-failed:${runId}`, kind: "alert", instanceId },
		).catch(() => undefined);
	}
	return outcome;
}

function liveDeps(input: ReleaseNoteInput): ReleaseNoteDeps {
	const { env, userId } = input;
	const tokens = new Map<string, Promise<string | null>>();
	/** An installation token for the path's owner (`/repos/<owner>/…`), minted once. */
	const githubToken = (path: string) => {
		const owner = path.split("/")[2] ?? "";
		if (!tokens.has(owner)) tokens.set(owner, resolveGithubRead(env, userId, owner).then((r) => r.token, () => null));
		return tokens.get(owner) ?? Promise.resolve(null);
	};
	return {
		now: Date.now,
		githubGet: async (path) => {
			const t = await githubToken(path);
			const res = await safeFetch(`https://api.github.com${path}`, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": "ProAgentStore", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
			}).catch(() => null);
			return res?.ok ? res.json().catch(() => null) : null;
		},
		deliver: liveDeliver(env, userId),
	};
}

/** Is the owner's bot for this provider connected? A lookup, never a post: the retry recheck (#1348) must not send anything. */
export async function deliveryBotConnected(env: Env, userId: string, provider: ReleaseChannel["provider"]): Promise<boolean> {
	if (provider === "slack") return !!(await getUserProviderKey(env, userId, "slack").catch(() => null));
	return !!(await connectorClient(env, "discord", { userId }).token().catch(() => null));
}

/** Post to a granted channel with the owner's own bot for that provider. */
export function liveDeliver(env: Env, userId: string): Deliver {
	return async (channel, text) => {
		if (channel.provider === "slack") {
			const bot = await getUserProviderKey(env, userId, "slack");
			if (!bot) return { ok: false, error: SLACK_NOT_CONNECTED };
			const sent = await postSlackMessage(bot, channel.channelId, text);
			return sent.ok ? { ok: true, ...(slackPermalink(channel.channelId, sent.ts) ? { permalink: slackPermalink(channel.channelId, sent.ts) } : {}) } : { ok: false, error: sent.message };
		}
		const bot = await connectorClient(env, "discord", { userId }).token().catch(() => null);
		if (!bot) return { ok: false, error: DISCORD_NOT_CONNECTED };
		const sent = await postDiscordMessage(bot, channel.channelId, text);
		return sent.ok ? { ok: true } : { ok: false, error: sent.message };
	};
}

/**
 * Send a TEST release note to one channel granted to this instance (#1217) — the way to check a
 * channel works before a run depends on it. Sent whether or not release notes are on, and whether
 * or not the channel is chosen: it tests the channel, not the setting. Refused (404) for a grant
 * this instance does not hold; a failed post is a 502 with the provider's reason.
 */
export async function sendTestReleaseNote(env: Env, userId: string, instanceId: string, grantId: string, deliver: Deliver = liveDeliver(env, userId)): Promise<{ sent: true; channel: ReleaseChannel; permalink?: string }> {
	const channel = (await grantedReleaseChannels(env, instanceId, userId)).find((c) => c.grantId === grantId);
	if (!channel) throw new HttpError(404, `This instance holds no Discord or Slack grant "${grantId}" — it was revoked or belongs to another instance. GET /v1/instances/${instanceId}/release-notes lists its channels.`);
	const text = `🧪 Test release note from ProAgentStore\n\nThis channel (${channel.name}) is set up to receive release notes. When a coder run on this agent ships to its repository's default branch, one note per run arrives here: what changed, the issues it closed, and CI/deploy status.`;
	let result: Awaited<ReturnType<Deliver>>;
	try {
		result = await deliver(channel, text);
	} catch (e) {
		result = { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	const context = { provider: channel.provider, grantId, channelId: channel.channelId };
	await logEvent(env, { source: "coding", event: result.ok ? "release_note_test_sent" : "release_note_test_failed", level: result.ok ? "info" : "warn", userId, instanceId, message: `Test release note to ${channel.provider} ${channel.name}: ${result.ok ? "sent" : result.error}`, context: { ...context, ...(result.ok && result.permalink ? { permalink: result.permalink } : {}) } }).catch(() => undefined);
	if (!result.ok) throw new HttpError(502, `The test release note was not delivered to ${channel.provider} ${channel.name}: ${result.error}`);
	return { sent: true, channel, ...(result.permalink ? { permalink: result.permalink } : {}) };
}
