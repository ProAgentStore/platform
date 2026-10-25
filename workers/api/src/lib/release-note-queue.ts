/** Durable, fail-closed delivery for coder release notes with an exact-SHA workflow gate. */
import { resolveGithubRead } from "./github-cache.js";
import { clipMarked } from "./clip-marked.js";
import { logEvent } from "./events.js";
import { logError } from "./error-log.js";
import { recordAttempt } from "./release-note-attempts.js";
import { gateIsComplete, loadReleaseNotes, releaseGateState } from "./release-notes-settings.js";
import { liveDeliver, type Deliver, type ReleaseNoteContext } from "./release-notes.js";
import { collectWorkflowRuns, liveFetcher, type HoldCode, type PageFetcher } from "./github-evidence.js";
import { resolvePendingRange } from "./release-note-range.js";
import { safeFetch } from "./ssrf.js";
import { deepLinkFor } from "./console-links.js";
import { notifyUser } from "../routes/push.js";
import type { InstanceReleaseNotes } from "../agent-types.js";
import type { Env } from "../types.js";

type RequiredWorkflows = NonNullable<InstanceReleaseNotes["requiredWorkflows"]>;
type Run = { id?: number; path?: string; name?: string; head_sha?: string; head_branch?: string; status?: string; conclusion?: string | null; updated_at?: string; run_attempt?: number; html_url?: string };
export type Row = { id: string; user_id: string; instance_id: string; session_id: string; github_repo: string; default_branch: string; run_id: string; sha: string; grant_id: string; context_json: string; workflows_json: string; created_at: number };
type Step = { name?: string; number?: number; status?: string; conclusion?: string | null };
type Job = { id?: number; name?: string; status?: string; conclusion?: string | null; run_id?: number; run_attempt?: number; head_sha?: string; steps?: Step[] };
type JobsPage = { total_count?: number; jobs?: Job[] };
/** The deploy job and step that proved the production claim, bound to one run attempt and SHA. */
export interface DeployProof { runId: number; runAttempt: number; jobId: number; jobName: string; stepNumber: number; stepName: string; runUrl: string; jobUrl: string }
export interface ReleaseQueueDeps { readRuns?: (row: Row) => Promise<Run[]>; /** Paged GitHub reads (workflow runs, the compare, the repository). Live by default; injected in tests. */ fetchPage?: PageFetcher; readJobsPage?: (row: Row, run: Run, page: number) => Promise<JobsPage>; deliver?: (env: Env, userId: string) => Deliver }

/** The run-attempt jobs are read at most this many pages of 100; a run with more jobs is unreadable evidence. */
export const JOBS_PAGES_MAX = 5;
const JOBS_PER_PAGE = 100;

const normalPath = (path: string) => path.split("@")[0].replace(/^.*?(?=\.github\/workflows\/)/, "");

/** Null means keep waiting. A failed or missing required run can be rerun on the same SHA. */
export function completedReleaseEvidence(runs: Run[], sha: string, branch: string, required: RequiredWorkflows): Run[] | null {
	const evidence: Run[] = [];
	for (const item of required) {
		const matches = runs.filter((run) => run.head_sha === sha && run.head_branch === branch && normalPath(run.path ?? "") === item.path);
		matches.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || (b.id ?? 0) - (a.id ?? 0) || (b.run_attempt ?? 0) - (a.run_attempt ?? 0));
		const latest = matches[0];
		if (latest?.status !== "completed" || latest.conclusion !== "success" || !Number.isSafeInteger(latest.id) || (latest.id ?? 0) <= 0) return null;
		evidence.push(latest);
	}
	return evidence;
}

/**
 * Fetch the selected run's SPECIFIC attempt jobs and prove the named deploy job and step succeeded (#1346).
 * Anything but exact, unambiguous, successful, same-run/attempt/SHA evidence is a reason to hold; this
 * never throws, because an unreadable page is a hold too.
 */
export async function verifyDeployProof(row: Row, run: Run, item: RequiredWorkflows[number], readPage: (page: number) => Promise<JobsPage>): Promise<{ ok: true; proof: DeployProof } | { ok: false; reason: string }> {
	const fail = (reason: string) => ({ ok: false as const, reason });
	if (!item.jobName || !item.stepName) return fail("The release gate has no deploy jobName and stepName");
	const runId = run.id;
	const attempt = run.run_attempt;
	if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt) || (attempt ?? 0) < 1) return fail("The deploy workflow run has no readable attempt number, so its jobs cannot be proven");
	const jobs: Job[] = [];
	try {
		for (let page = 1; ; page++) {
			if (page > JOBS_PAGES_MAX) return fail(`The deploy run attempt has more than ${JOBS_PAGES_MAX * JOBS_PER_PAGE} jobs; the deploy job cannot be proven`);
			const body = await readPage(page);
			if (!Array.isArray(body.jobs)) return fail("GitHub returned no jobs list for the deploy run attempt");
			jobs.push(...body.jobs);
			if (body.jobs.length < JOBS_PER_PAGE || (Number.isSafeInteger(body.total_count) && jobs.length >= (body.total_count ?? 0))) break;
		}
	} catch (error) {
		return fail(`The deploy run attempt's jobs could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const named = jobs.filter((job) => job.name === item.jobName);
	if (!named.length) return fail(`No job named "${item.jobName}" in the deploy run attempt`);
	if (named.length > 1) return fail(`${named.length} jobs are named "${item.jobName}" in the deploy run attempt; the deploy job is ambiguous`);
	const job = named[0];
	if (job.run_id !== runId || job.run_attempt !== attempt || job.head_sha !== row.sha) return fail(`Job "${item.jobName}" does not belong to the selected run attempt and commit`);
	if (!Number.isSafeInteger(job.id) || (job.id ?? 0) <= 0) return fail(`Job "${item.jobName}" has no usable id`);
	if (job.status !== "completed" || job.conclusion !== "success") return fail(`Job "${item.jobName}" is ${job.status === "completed" ? job.conclusion ?? "unknown" : job.status ?? "unknown"}, not a completed success`);
	const steps = (job.steps ?? []).filter((step) => step.name === item.stepName);
	if (!steps.length) return fail(`No step named "${item.stepName}" in job "${item.jobName}"`);
	if (steps.length > 1) return fail(`${steps.length} steps are named "${item.stepName}" in job "${item.jobName}"; the deploy step is ambiguous`);
	const step = steps[0];
	if (!Number.isSafeInteger(step.number) || (step.number ?? 0) < 1) return fail(`Step "${item.stepName}" has no usable number`);
	if (step.status !== "completed" || step.conclusion !== "success") return fail(`Step "${item.stepName}" in job "${item.jobName}" is ${step.status === "completed" ? step.conclusion ?? "unknown" : step.status ?? "unknown"}, not a completed success`);
	const runUrl = `https://github.com/${row.github_repo}/actions/runs/${runId}`;
	return { ok: true, proof: { runId: runId as number, runAttempt: attempt as number, jobId: job.id as number, jobName: item.jobName, stepNumber: step.number as number, stepName: item.stepName, runUrl, jobUrl: `${runUrl}/job/${job.id}` } };
}

export function verifiedReleaseText(ctx: ReleaseNoteContext, required: RequiredWorkflows, runs: Run[], proof?: DeployProof): string {
	const lines = [`🚀 Production release: ${ctx.repo}`, `Commit: ${ctx.headSha}`, `Environment: production`, `Run: ${ctx.runId}`, "", "Checks for this commit:"];
	for (const [index, item] of required.entries()) lines.push(`• ${item.role === "production_deploy" ? "Production deploy" : "Check"}: ${item.path} — https://github.com/${ctx.repo}/actions/runs/${runs[index].id}`);
	if (proof) lines.push(`• Deploy proof: job ${proof.jobName}, step ${proof.stepNumber} ${proof.stepName} — ${proof.jobUrl}`);
	if (ctx.changes.length) {
		lines.push("", "What changed:", ...ctx.changes.filter((_x, index) => index < 8).map((x) => `• ${clipMarked(x, 160, { within: true })}`));
		// The summary is a window on a verified range that can be longer: say how many subjects are not shown (#1349).
		const total = ctx.changes.length + (ctx.changesOmitted ?? 0);
		if (total > 8) lines.push(`…and ${total - 8} more changes`);
	}
	if (ctx.closedIssues.length) {
		lines.push("", "Issues:", ...ctx.closedIssues.filter((_x, index) => index < 8).map((x) => `• #${x.number} ${clipMarked(x.title ?? "", 160, { within: true })}`));
		if (ctx.closedIssues.length > 8) lines.push(`…and ${ctx.closedIssues.length - 8} more issues`);
	}
	const text = lines.join("\n");
	return clipMarked(text, 1800, { within: true });
}

/** Hold a row for good: its evidence is permanently incomplete or inconsistent. Visible to the owner with a typed code. */
async function holdRow(env: Env, row: Row, code: HoldCode, message: string): Promise<void> {
	const held = await env.DB.prepare("UPDATE release_note_queue SET status='held', hold_code=?1, reason=?2, updated_at=?3 WHERE id=?4 AND status IN ('pending','configuration_required')").bind(code, message, Date.now(), row.id).run();
	if (!held.meta.changes) return;
	await logEvent(env, { source: "coding", userId: row.user_id, instanceId: row.instance_id, traceId: row.run_id, event: "release_note_evidence_held", level: "warn", message: `Release note held for ${row.sha}: ${message}`, context: { queueId: row.id, holdCode: code, sha: row.sha } });
	await notifyUser(env, row.user_id, "coding", "⚠️ Release note held", `${row.github_repo}: ${message}`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-held:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
}

/** A transient GitHub failure: the row stays as it is and the next tick tries again; the owner can see why it waits. */
const waitRow = (env: Env, row: Row, reason: string) => env.DB.prepare("UPDATE release_note_queue SET reason=?1, updated_at=?2 WHERE id=?3 AND status='pending'").bind(reason, Date.now(), row.id).run();

/** Same workflow files and roles, ignoring the deploy selectors the owner has since added. */
const sameGateShape = (a: RequiredWorkflows, b: RequiredWorkflows) => a.length === b.length && a.every((x, i) => x.path === b[i].path && x.role === b[i].role);

export async function liveJobsPage(env: Env, row: Row, run: Run, page: number): Promise<JobsPage> {
	const { token } = await resolveGithubRead(env, row.user_id, row.github_repo.split("/")[0]);
	const response = await safeFetch(`https://api.github.com/repos/${row.github_repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=${JOBS_PER_PAGE}&page=${page}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ProAgentStore", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
	if (!response.ok) throw new Error(`GitHub job read returned ${response.status}`);
	return await response.json() as JobsPage;
}

const setStatus = (env: Env, id: string, status: string, reason: string | null = null, permalink: string | null = null) => env.DB.prepare("UPDATE release_note_queue SET status=?1, reason=?2, permalink=?3, updated_at=?4 WHERE id=?5").bind(status, reason, permalink, Date.now(), id).run();

/** One bounded cron tick. An uncertain Slack send remains `sending`; it is never posted twice. */
export async function runReleaseNoteQueue(env: Env, deps: ReleaseQueueDeps = {}): Promise<void> {
	const rows = (await env.DB.prepare("SELECT * FROM release_note_queue WHERE status IN ('pending','configuration_required') ORDER BY updated_at, created_at LIMIT 20").all<Row>()).results ?? [];
	for (const row of rows) {
		let claimed = false;
		try {
			if (Date.now() - row.created_at > 48 * 60 * 60_000) {
				await setStatus(env, row.id, "expired", "Required workflows did not all succeed within 48 hours");
				await logEvent(env, { source: "coding", userId: row.user_id, instanceId: row.instance_id, traceId: row.run_id, event: "release_note_expired", level: "warn", message: `Release note held for ${row.sha}: required workflows did not all succeed within 48 hours.` });
				await notifyUser(env, row.user_id, "coding", "⚠️ Release note held", `${row.github_repo}: required workflows did not all succeed for ${row.sha}.`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-expired:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
				continue;
			}
			const settings = await loadReleaseNotes(env, row.instance_id, row.user_id);
			let required = JSON.parse(row.workflows_json) as RequiredWorkflows;
			const channel = settings?.effective.channels.find((c) => c.grantId === row.grant_id && c.selected);
			if (!gateIsComplete(required) && settings?.effective.enabled && channel) {
				// An old gate (no deploy job/step) never makes the production claim (#1346): the row is held, not dropped.
				const current = settings.instance.requiredWorkflows;
				if (gateIsComplete(current) && sameGateShape(required, current ?? [])) {
					// The owner completed this very gate: the held note resumes on the stronger proof.
					const resumed = await env.DB.prepare("UPDATE release_note_queue SET workflows_json=?1, status='pending', reason=NULL, updated_at=?2 WHERE id=?3 AND status IN ('pending','configuration_required')").bind(JSON.stringify(current), Date.now(), row.id).run();
					if (!resumed.meta.changes) continue;
					required = current ?? required;
				} else if (JSON.stringify(current) === JSON.stringify(required)) {
					const gate = releaseGateState(required);
					const held = await env.DB.prepare("UPDATE release_note_queue SET status='configuration_required', reason=?1, updated_at=?2 WHERE id=?3 AND status='pending'").bind(gate.message ?? null, Date.now(), row.id).run();
					if (held.meta.changes) {
						await logEvent(env, { source: "coding", userId: row.user_id, instanceId: row.instance_id, traceId: row.run_id, event: "release_note_configuration_required", level: "warn", message: `Release note held for ${row.sha}: the release gate has no deploy job and step. ${gate.message}` });
						await notifyUser(env, row.user_id, "coding", "⚠️ Release note held", `${row.github_repo}: set the production deploy job and step on the release gate to release ${row.sha}.`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-config:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
					} else await env.DB.prepare("UPDATE release_note_queue SET updated_at=?1 WHERE id=?2 AND status='configuration_required'").bind(Date.now(), row.id).run();
					continue;
				}
			}
			if (!settings?.effective.enabled || !channel || JSON.stringify(settings.instance.requiredWorkflows) !== JSON.stringify(required)) { await setStatus(env, row.id, "cancelled", "Release note setting or channel grant changed"); continue; }
			const fetchPage = deps.fetchPage ?? liveFetcher(env, row.user_id, row.github_repo.split("/")[0]);
			// A gated push is recorded at run end as base/head only. The whole compare is paged and verified here, where a
			// rate limit just means "try again next tick" (#1349).
			let ctxNow = JSON.parse(row.context_json) as ReleaseNoteContext;
			if (ctxNow.pendingRange) {
				const range = await resolvePendingRange(fetchPage, ctxNow);
				if (!range.ok && range.kind === "transient") { await waitRow(env, row, range.message); continue; }
				if (!range.ok) { await holdRow(env, row, range.code, range.message); continue; }
				try {
					const upgraded = await env.DB.prepare("UPDATE release_note_queue SET sha=?1, context_json=?2, reason=NULL, updated_at=?3 WHERE id=?4 AND status='pending'").bind(range.value.sha, JSON.stringify(range.value.context), Date.now(), row.id).run();
					if (!upgraded.meta.changes) continue;
				} catch {
					await setStatus(env, row.id, "cancelled", "A release note for this exact commit and channel already exists");
					continue;
				}
				row.sha = range.value.sha;
				row.context_json = JSON.stringify(range.value.context);
				ctxNow = range.value.context;
			}
			let runs: Run[];
			if (deps.readRuns) runs = await deps.readRuns(row);
			else {
				const collected = await collectWorkflowRuns(fetchPage, row.github_repo, row.sha);
				if (!collected.ok && collected.kind === "transient") { await waitRow(env, row, collected.message); continue; }
				if (!collected.ok) { await holdRow(env, row, collected.code, collected.message); continue; }
				runs = collected.value;
			}
			const evidence = completedReleaseEvidence(runs, row.sha, row.default_branch, required);
			if (!evidence) { await env.DB.prepare("UPDATE release_note_queue SET updated_at=?1 WHERE id=?2 AND status='pending'").bind(Date.now(), row.id).run(); continue; }
			const deployIndex = required.findIndex((item) => item.role === "production_deploy");
			const deploy = await verifyDeployProof(row, evidence[deployIndex], required[deployIndex], (page) => deps.readJobsPage ? deps.readJobsPage(row, evidence[deployIndex], page) : liveJobsPage(env, row, evidence[deployIndex], page));
			if (!deploy.ok) { await env.DB.prepare("UPDATE release_note_queue SET reason=?1, updated_at=?2 WHERE id=?3 AND status='pending'").bind(`Production deploy not proven: ${deploy.reason}`, Date.now(), row.id).run(); continue; }
			// Claim BEFORE the external write. If a worker dies during Slack's response, a second tick never guesses it failed.
			const claim = await env.DB.prepare("UPDATE release_note_queue SET status='sending', reason=NULL, evidence_json=?1, updated_at=?2 WHERE id=?3 AND status='pending'").bind(JSON.stringify(deploy.proof), Date.now(), row.id).run();
			if (!claim.meta.changes) continue;
			claimed = true;
			// The receipt trail is best effort around the send: it must never turn a claim into a failure, or stop the post.
			const claimAttemptId = crypto.randomUUID();
			const runUrls = evidence.map((run) => `https://github.com/${row.github_repo}/actions/runs/${run.id}`);
			await recordAttempt(env, { id: claimAttemptId, queueId: row.id, userId: row.user_id, instanceId: row.instance_id, kind: "send", outcome: "claimed", evidence: { channel: { provider: channel.provider, name: channel.name, channelId: channel.channelId }, workflowRuns: runUrls, deployJob: deploy.proof.jobUrl, deployProof: deploy.proof }, key: `send:${claimAttemptId}:claimed` }).catch(() => undefined);
			const ctx = ctxNow;
			const result = await (deps.deliver ?? liveDeliver)(env, row.user_id)(channel, verifiedReleaseText(ctx, required, evidence, deploy.proof));
			await setStatus(env, row.id, result.ok ? "sent" : "failed", result.ok ? null : result.error, result.ok ? result.permalink ?? null : null);
			const resultAttemptId = crypto.randomUUID();
			await recordAttempt(env, { id: resultAttemptId, queueId: row.id, userId: row.user_id, instanceId: row.instance_id, kind: "send", outcome: result.ok ? "sent" : "failed", reason: result.ok ? null : result.error, permalink: result.ok ? result.permalink ?? null : null, key: `send:${claimAttemptId}:result` }).catch(() => undefined);
			await logEvent(env, { source: "coding", userId: row.user_id, instanceId: row.instance_id, traceId: row.run_id, event: result.ok ? "release_note_sent" : "release_note_failed", level: result.ok ? "info" : "error", message: result.ok ? `Verified release note posted to ${channel.provider} ${channel.name} for ${row.sha}` : `Verified release note failed: ${result.error}`, context: { sha: row.sha, grantId: row.grant_id, queueId: row.id, attemptId: resultAttemptId, evidence: evidence.map((run) => `https://github.com/${row.github_repo}/actions/runs/${run.id}`), deployProof: deploy.proof, ...(result.ok && result.permalink ? { permalink: result.permalink } : {}) } });
			if (!result.ok) await notifyUser(env, row.user_id, "coding", "⚠️ Release note not delivered", `${row.github_repo}: ${result.error}`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-failed:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
		} catch (error) {
			await logError(env, { source: "release-note-queue", userId: row.user_id, message: `Release note ${row.id}: ${error instanceof Error ? error.message : String(error)}`, context: { instanceId: row.instance_id, sha: row.sha } }).catch(() => undefined);
			if (!claimed) await env.DB.prepare("UPDATE release_note_queue SET updated_at=?1 WHERE id=?2 AND status='pending'").bind(Date.now(), row.id).run().catch(() => undefined);
			if (claimed) await notifyUser(env, row.user_id, "coding", "⚠️ Release note outcome unknown", `${row.github_repo}: the Slack send for ${row.sha} may have succeeded. Check the channel before retrying.`, deepLinkFor({ kind: "coding-session", instanceId: row.instance_id, sessionId: row.session_id }), { key: `release-note-unknown:${row.id}`, kind: "alert", instanceId: row.instance_id }).catch(() => undefined);
		}
	}
}
