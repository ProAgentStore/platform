/**
 * Resume a coding run parked on CI (#1325).
 *
 * A coder waiting on CI used to have one move: tell the orchestrator "wait, then check", which the
 * repeat detector (`coding-repetition.ts`) reads as a loop, so the run parked on a question — and
 * nothing re-checked CI afterwards. Now GitHub tells us. A `workflow_run` `completed` delivery names a
 * repository and a head commit; if a run of ours is parked on an open question that mentions that
 * commit, and every workflow run for the commit has finished, the CI result is written as the answer
 * to that question and the run is woken. It re-reads the answer from D1 like any other (#1076), so a
 * duplicate delivery finds an answered question and does nothing.
 *
 * The delivery is only a nudge: it is signed, but the verdict is read back from the GitHub API with
 * the owner's installation token, never taken from the payload.
 */
import type { Env } from "../types.js";
import { recordAnswer } from "./coder-question-store.js";
import { clipMarked } from "./clip-marked.js";
import { fetchWorkflowJobs, fetchWorkflowRuns } from "./github-actions.js";
import { installationTokenForOwner } from "./github-app.js";
import { wakeParkedRun } from "./coding-park.js";

/** Shortest commit prefix a question must contain to be taken as waiting on that commit. */
export const CI_SHA_PREFIX = 7;

const encoder = new TextEncoder();

/** GitHub's `X-Hub-Signature-256` (`sha256=<hex>` over the raw body), compared in constant time. */
export async function verifyGithubSignature(body: string, header: string | null | undefined, secret: string): Promise<boolean> {
	const m = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
	if (!m || !secret) return false;
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
	const expected = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
	const given = m[1].toLowerCase();
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
	return diff === 0;
}

interface WaitingRun {
	runId: string;
	userId: string;
	instanceId: string;
	sessionId: string;
	taskId: string | null;
}

/** Runs parked on an open, unanswered question that names this commit, in a repo bound to this GitHub repository. */
export async function runsWaitingOnCommit(env: Pick<Env, "DB">, fullName: string, sha: string): Promise<WaitingRun[]> {
	const prefix = sha.slice(0, CI_SHA_PREFIX).toLowerCase();
	if (prefix.length < CI_SHA_PREFIX || !/^[0-9a-f]+$/.test(prefix)) return [];
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT r.run_id AS run_id, r.user_id AS user_id, r.instance_id AS instance_id, r.session_id AS session_id, q.task_id AS task_id
		   FROM agent_loop_runs r
		   JOIN coder_questions q ON q.run_id = r.run_id
		   JOIN coding_sessions s ON s.id = r.session_id
		   JOIN coding_repos cr ON cr.id = s.repo_id
		  WHERE lower(cr.github_repo) = lower(?1)
		    AND r.status = 'running' AND r.waiting_reason = 'decision' AND r.workflow_instance_id IS NOT NULL
		    AND q.state IN ('waiting_human', 'brain_deciding', 'escalated') AND q.applied_at IS NULL AND q.answered_at IS NULL
		    AND instr(lower(q.question || ' ' || COALESCE(q.why, '')), ?2) > 0
		  LIMIT 25`,
	)
		.bind(fullName, prefix)
		.all<{ run_id: string; user_id: string; instance_id: string; session_id: string; task_id: string | null }>();
	return (results ?? []).map((r) => ({ runId: r.run_id, userId: r.user_id, instanceId: r.instance_id, sessionId: r.session_id, taskId: r.task_id }));
}

const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

/** One line per workflow run, then the failed jobs (and the step that failed) of each failing run. */
async function describeCi(fullName: string, sha: string, token: string | undefined, runs: Array<Record<string, unknown>>): Promise<string> {
	const lines = runs.map((r) => `- ${String(r.name ?? "workflow")}: ${String(r.conclusion ?? "unknown")}${typeof r.html_url === "string" ? ` (${r.html_url})` : ""}`);
	const allFailed = runs.filter((r) => FAILING.has(String(r.conclusion)));
	const failed = allFailed.slice(0, 3);
	const details: string[] = [];
	if (allFailed.length > failed.length) details.push(`- ${allFailed.length - failed.length} more failed workflow run(s) not itemised`);
	for (const run of failed) {
		const jobs = typeof run.id === "number" ? await fetchWorkflowJobs(fullName, token, run.id) : { status: null };
		if (!("jobs" in jobs)) continue;
		const failedJobs = jobs.jobs.filter((j) => j.conclusion && FAILING.has(j.conclusion));
		if (failedJobs.length > 5) details.push(`- ${run.name ?? "workflow"}: ${failedJobs.length - 5} more failed job(s) not itemised`);
		for (const job of failedJobs.slice(0, 5)) {
			const step = job.steps.find((s) => s.conclusion && FAILING.has(s.conclusion));
			details.push(`- ${String(run.name ?? "workflow")} / ${job.name}: ${job.conclusion}${step ? `, failed at step "${step.name}"` : ""}${job.url ? ` (${job.url})` : ""}`);
		}
	}
	const verdict = failed.length ? "CI FAILED" : "CI PASSED";
	return clipMarked(
		`${verdict} for ${fullName}@${sha.slice(0, 8)} (reported by GitHub; resumed automatically, not answered by a person).\n${lines.join("\n")}${details.length ? `\nFailed jobs:\n${details.join("\n")}` : ""}\nCheck the result yourself before relying on it, then carry on.`,
		3000,
		{ within: true },
	);
}

export type CiResumeResult = { ignored: string } | { pending: number } | { resumed: string[] };

/**
 * Handle one verified `workflow_run` delivery. Returns what it did; never throws for a state it can
 * simply ignore (no parked run, CI still running, GitHub unreadable — a later delivery tries again).
 */
export async function resumeRunsOnCiCompletion(env: Env, payload: unknown): Promise<CiResumeResult> {
	const p = payload as { action?: unknown; workflow_run?: { head_sha?: unknown; status?: unknown; conclusion?: unknown; name?: unknown; id?: unknown; html_url?: unknown }; repository?: { full_name?: unknown } };
	const fullName = typeof p?.repository?.full_name === "string" ? p.repository.full_name : "";
	const sha = typeof p?.workflow_run?.head_sha === "string" ? p.workflow_run.head_sha : "";
	if (p?.action !== "completed" || !/^[\w.-]+\/[\w.-]+$/.test(fullName) || !/^[0-9a-f]{40}$/i.test(sha)) return { ignored: "not a completed workflow_run for a commit" };
	const waiting = await runsWaitingOnCommit(env, fullName, sha);
	if (!waiting.length) return { ignored: "no parked run is waiting on this commit" };

	const resumed: string[] = [];
	for (const w of waiting) {
		const token = (await installationTokenForOwner(env, w.userId, fullName.split("/")[0]).catch(() => null)) ?? undefined;
		const read = await fetchWorkflowRuns(fullName, token, { headSha: sha, perPage: 100 });
		let runs: Array<Record<string, unknown>>;
		if ("runs" in read && read.runs.length) runs = read.runs;
		else if (p.workflow_run?.conclusion) runs = [p.workflow_run as Record<string, unknown>]; // GitHub unreadable: the delivery's own run
		else continue;
		const open = runs.filter((r) => r.status !== "completed").length;
		if (open) return { pending: open }; // the last workflow to finish resumes it
		const value = await describeCi(fullName, sha, token, runs);
		const recorded = await recordAnswer(env, { instanceId: w.instanceId, userId: w.userId, taskId: w.taskId, sessionId: w.sessionId, value, via: "console" });
		if (recorded && (recorded.outcome === "answered" || recorded.outcome === "revised")) {
			await wakeParkedRun(env, w.runId, "answer");
			resumed.push(w.runId);
		}
	}
	return { resumed };
}
