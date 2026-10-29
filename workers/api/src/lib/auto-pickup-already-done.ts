/**
 * An `already_done` issue that is still OPEN must not sit forever as a "passed over" log row (#1407):
 * close it, citing the run that finished it, when CI is green on what that run delivered — else flag
 * it for a human, so the picker's cycle stops re-trying it every sweep.
 *
 * ── Why this is additive to the start guard, not a change to it
 *
 * `checkStartIdempotency` already refuses a start on an issue a run finished `done` within
 * {@link RECENTLY_DONE_DAYS} (`start-idempotency.ts`). That refusal is correct and untouched — the
 * gap #1407 names is what happens AFTER it: nothing closed the issue, so every later sweep reaches
 * the identical refusal and the picker's log fills with the same "passed over" row forever while the
 * issue sits open, unresolved, for anyone reading the repo's issue list.
 *
 * ── Why CLOSE needs a commit and flag does not
 *
 * Closing is irreversible from the picker's own authority — it is justified only by PROOF that the
 * work landed and CI is green on it. A run ending `done` is the Pilot's OWN verdict on itself, not
 * evidence of either fact: #522/#1391's whole history is the Pilot being wrong about what it shipped.
 * So the commit the run actually delivered is read from its own recorded acts (`push.trunk` / verified
 * `pr.merge`, the same source `release-notes.ts`'s delivery evidence reads), and CI for THAT commit is
 * read live from GitHub. No commit, or CI not green: flagged, not closed — a human decides from there.
 *
 * ── Why flagging means `needs-human`, not a new label
 *
 * `needs-human` already means exactly this ("a person has to act") and is already a BUILTIN_EXCLUDE
 * label `exclusionReason` honours — so flagging with it is what stops the picker re-trying the issue
 * next sweep, with no new state to track or new exclusion rule to add and keep in sync.
 */
import { installationTokenForOwner } from "./github-app.js";
import { invalidateIssueCaches, postIssueComment, readIssue } from "./github-issues.js";
import { parseMergeEvidence } from "./merge-evidence.js";
import type { Env } from "../types.js";

const SHA = /^[0-9a-f]{7,40}$/;
const GH_HEADERS = (token: string) => ({ Authorization: `token ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "proagentstore-auto-pickup/1.0" });
const FETCH_TIMEOUT_MS = 15_000;

/** The commit a run actually delivered, read from its own recorded acts — the newest successful `push.trunk` or verified `pr.merge`, else null. */
export async function runDeliveredSha(env: Pick<Env, "DB">, input: { instanceId: string; userId: string; runId: string }): Promise<string | null> {
	const { results } = await env.DB.prepare("SELECT context FROM agent_events WHERE instance_id = ?1 AND user_id = ?2 AND trace_id = ?3 AND event = 'act.consequential' ORDER BY ts DESC, rowid DESC")
		.bind(input.instanceId, input.userId, input.runId)
		.all<{ context: string | null }>();
	for (const row of results ?? []) {
		let act: { act?: unknown; ok?: unknown; pushedSha?: unknown; merge?: unknown };
		try {
			act = JSON.parse(row.context ?? "{}");
		} catch {
			continue; // an unreadable act is no evidence of a delivered commit
		}
		if (act.ok !== true) continue;
		if (act.act === "push.trunk" && typeof act.pushedSha === "string" && SHA.test(act.pushedSha)) return act.pushedSha.toLowerCase();
		if (act.act === "pr.merge") {
			const evidence = parseMergeEvidence(act.merge);
			if (evidence) return evidence.afterSha;
		}
	}
	return null;
}

export type CiStatus = "pending" | "success" | "failure" | "unknown";

/** The same judgment `release-notes.ts` uses for a commit's CI: any completed non-passing run fails it; else green once everything that ran has finished. */
export function ciStatusFromRuns(raw: unknown): CiStatus {
	const runs = (raw as { workflow_runs?: Array<{ status?: unknown; conclusion?: unknown }> } | null)?.workflow_runs;
	if (!Array.isArray(runs)) return "unknown";
	if (!runs.length) return "pending";
	if (runs.some((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral")) return "failure";
	return runs.every((r) => r.status === "completed") ? "success" : "pending";
}

/** CI for one commit, read live. `unknown` on anything that is not a clean 2xx JSON answer — never thrown, never guessed green. */
export async function ciStatusForCommit(env: Pick<Env, "DB">, userId: string, githubRepo: string, sha: string): Promise<CiStatus> {
	const owner = githubRepo.split("/")[0] ?? "";
	const token = await installationTokenForOwner(env as Env, userId, owner).catch(() => null);
	if (!token) return "unknown";
	const res = await fetch(`https://api.github.com/repos/${githubRepo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=30`, {
		headers: GH_HEADERS(token),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	}).catch(() => null);
	if (!res?.ok) return "unknown";
	return ciStatusFromRuns(await res.json().catch(() => null));
}

/** Close the issue, citing the run and commit, then comment the evidence. Never reopens, never acts on an issue already not open. */
async function closeCitingRun(env: Env, args: { userId: string; githubRepo: string; issue: number; runId: string; sha: string }): Promise<boolean> {
	const token = await installationTokenForOwner(env, args.userId, args.githubRepo.split("/")[0] ?? "").catch(() => null);
	if (!token) return false;
	const res = await fetch(`https://api.github.com/repos/${args.githubRepo}/issues/${args.issue}`, {
		method: "PATCH",
		headers: GH_HEADERS(token),
		body: JSON.stringify({ state: "closed", state_reason: "completed" }),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	}).catch(() => null);
	if (!res?.ok) return false;
	await postIssueComment(
		env,
		args.userId,
		args.githubRepo,
		args.issue,
		`Closed automatically by ProAgentStore (#1407): run \`${args.runId}\` finished this issue and CI is green on the commit it delivered, \`${args.sha.slice(0, 7)}\`.`,
	).catch(() => false);
	await invalidateIssueCaches(env, args.userId, args.githubRepo).catch(() => undefined);
	return true;
}

/** Add `needs-human` (if not already there) and explain why, so the picker stops retrying it and a person decides. */
async function flagForReview(env: Env, args: { userId: string; githubRepo: string; issue: number; labels: readonly string[]; reason: string }): Promise<boolean> {
	let labelled = args.labels.some((l) => l.trim().toLowerCase() === "needs-human");
	if (!labelled) {
		const token = await installationTokenForOwner(env, args.userId, args.githubRepo.split("/")[0] ?? "").catch(() => null);
		if (token) {
			const res = await fetch(`https://api.github.com/repos/${args.githubRepo}/issues/${args.issue}/labels`, {
				method: "POST",
				headers: GH_HEADERS(token),
				body: JSON.stringify({ labels: ["needs-human"] }),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			}).catch(() => null);
			labelled = !!res?.ok;
		}
	}
	const posted = await postIssueComment(
		env,
		args.userId,
		args.githubRepo,
		args.issue,
		`**Auto-pickup flagged this issue for review (#1407).** A run reported it done, but ${args.reason} — labelled \`needs-human\` so it is not retried automatically; remove the label once it is confirmed resolved (or reopen the work) and it becomes eligible again.`,
	).catch(() => false);
	if (labelled) await invalidateIssueCaches(env, args.userId, args.githubRepo).catch(() => undefined);
	return labelled || posted;
}

export type AlreadyDoneHandling = { action: "closed"; runId: string; sha: string } | { action: "flagged"; reason: string } | { action: "skipped"; reason: string };

/**
 * The GitHub-touching steps, swappable for a test — the same shape `AutoPickupDeps` injects its own
 * GitHub calls with. Each defaults to the real implementation above; a test replaces one directly
 * rather than faking a GitHub App installation to reach it through `fetch`.
 */
export interface AlreadyDoneDeps {
	readIssueState?: (githubRepo: string, issue: number) => Promise<{ state: string } | null>;
	ciStatusForCommit?: (githubRepo: string, sha: string) => Promise<CiStatus>;
	close?: (args: { githubRepo: string; issue: number; runId: string; sha: string }) => Promise<boolean>;
	flag?: (args: { githubRepo: string; issue: number; labels: readonly string[]; reason: string }) => Promise<boolean>;
}

/**
 * Handle one `already_done`-refused, still-open candidate: close it when CI is green on what the
 * finishing run delivered, else flag it for a human. Never throws — this runs inside the picker's
 * best-effort fall-through loop, and a GitHub hiccup here must cost one skip, not the whole wake.
 */
export async function handleAlreadyDoneOpenIssue(
	env: Env,
	input: { userId: string; instanceId: string; githubRepo: string; issue: number; issueLabels: readonly string[]; runId: string },
	deps: AlreadyDoneDeps = {},
): Promise<AlreadyDoneHandling> {
	const readIssueState = deps.readIssueState ?? ((repo, issue) => readIssue(env, input.userId, repo, issue));
	const checkCi = deps.ciStatusForCommit ?? ((repo, sha) => ciStatusForCommit(env, input.userId, repo, sha));
	const close = deps.close ?? ((args) => closeCitingRun(env, { userId: input.userId, ...args }));
	const flag = deps.flag ?? ((args) => flagForReview(env, { userId: input.userId, ...args }));
	try {
		// The guard's own refusal is cache-derived; GitHub's live state may already have moved (a human closed it by hand).
		const live = await readIssueState(input.githubRepo, input.issue).catch(() => null);
		if (live && live.state !== "open") return { action: "skipped", reason: "already closed on GitHub" };

		const sha = await runDeliveredSha(env, { instanceId: input.instanceId, userId: input.userId, runId: input.runId });
		if (!sha) {
			const flagged = await flag({ githubRepo: input.githubRepo, issue: input.issue, labels: input.issueLabels, reason: "no delivered commit could be found for the run that finished it" });
			return { action: flagged ? "flagged" : "skipped", reason: "no delivered commit could be found for the finishing run" };
		}
		const ci = await checkCi(input.githubRepo, sha);
		if (ci === "success") {
			const closed = await close({ githubRepo: input.githubRepo, issue: input.issue, runId: input.runId, sha });
			if (closed) return { action: "closed", runId: input.runId, sha };
			// The close attempt itself failed (GitHub refused the write): flag rather than leave it unexplained.
			const flagged = await flag({ githubRepo: input.githubRepo, issue: input.issue, labels: input.issueLabels, reason: `CI is green on \`${sha.slice(0, 7)}\` but closing it failed` });
			return { action: flagged ? "flagged" : "skipped", reason: "CI is green but closing the issue failed" };
		}
		const reason = ci === "failure" ? `CI failed on the commit it delivered, \`${sha.slice(0, 7)}\`` : ci === "pending" ? `CI has not finished on the commit it delivered, \`${sha.slice(0, 7)}\`` : `CI could not be read for the commit it delivered, \`${sha.slice(0, 7)}\``;
		const flagged = await flag({ githubRepo: input.githubRepo, issue: input.issue, labels: input.issueLabels, reason });
		return { action: flagged ? "flagged" : "skipped", reason };
	} catch (e) {
		return { action: "skipped", reason: `could not handle the already-done issue: ${e instanceof Error ? e.message : String(e)}` };
	}
}
