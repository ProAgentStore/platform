import { codingBuildsLink } from "./console-links.js";
import { fetchWorkflowRuns, mapWorkflowRun } from "./github-actions.js";
import { installationTokenForOwner } from "./github-app.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

/**
 * Tell the user when a deploy finishes, whether or not they are watching (#6).
 *
 * The console polls GitHub Actions for the deploy badge, but only while it is open — so the
 * one moment you actually want to know ("is it green yet?") is the moment you have closed the
 * tab and gone to do something else. This is the server-side half: a cron sweep that notices a
 * run reaching `completed` and fires the existing `notifyUser` (in-app + web push), deep-linked
 * to the run.
 */

/** How many repos one sweep may poll. GitHub is rate-limited per installation and this runs on
 *  the per-minute cron, so the sweep is bounded and rotates by staleness rather than trying to
 *  cover everything every minute. */
export const DEPLOY_WATCH_BATCH = 20;

/** The completed run a sweep found, reduced to what the decision needs. */
export interface WatchedRun {
	id: string;
	status: string;
	conclusion: string | null;
	runNumber: number | null;
	url: string;
	/** The COMMIT this run built. The unit of a deploy — see `decideDeployNotification`. */
	sha: string;
	/** Workflow display name, e.g. "Deploy API Worker". */
	workflowName: string;
	/** Workflow file path, e.g. `.github/workflows/deploy-api.yml`. */
	workflowPath: string;
	/** ISO — used only to order runs newest-first without trusting the API's order. */
	updatedAt: string;
}

export type DeployNotifyDecision =
	| { notify: false; seenId: string | null; reason: "no-run" | "still-running" | "already-notified" | "first-sight" }
	| { notify: true; seenId: string; title: string; body: string; url: string };

/**
 * How many recent runs one repo's sweep reads.
 *
 * `perPage: 1` was the bug's other half: with seven workflows in the repo, the single newest run
 * is a coin toss between CI, a deploy, and an npm publish. A page has to be big enough to hold
 * every workflow of the most recent push or two, and small enough to stay one cheap request.
 */
export const DEPLOY_WATCH_RUNS_PER_REPO = 20;

/**
 * Which conclusions are worth speaking about.
 *
 * `cancelled` is the important omission (#359). `ok = conclusion === "success"` sent
 * *"❌ Build failed #N — cancelled"* for a run that did not fail — concurrency groups cancel a
 * superseded run routinely, so pushing twice in quick succession raised a false alarm about a
 * build that was merely replaced. A cancelled run is not evidence of anything, and neither is
 * `skipped`/`neutral`/`stale`: they are silent, and they do not move the watermark, so the
 * commit can still be reported when a real deploy for it concludes.
 */
const REPORTABLE = new Set(["success", "failure", "timed_out", "action_required", "startup_failure"]);

/**
 * Is this workflow the thing that puts something live?
 *
 * The root error in #359 was treating *any completed workflow run* as *a deploy that put
 * something live*: a green `ci.yml` produced "✅ Deployed #412 — PAGS is live", when nothing was
 * deployed and nothing went live — typecheck passed. That is a notification claiming an outcome
 * it has no evidence for, which is the same honesty rule the platform holds its agents to.
 *
 * Matched on the workflow FILE first (`deploy-api.yml`, `deploy.yml` — what the scaffolded agent
 * repos and this monorepo both use) and its display name second. A repo whose deploy workflow is
 * named something else gets silence rather than a lie; silence is the failure mode to prefer
 * here, and naming the workflow explicitly on `coding_repos` is the escape hatch to add when a
 * real repo needs it.
 */
export function isDeployWorkflow(name: string, path: string): boolean {
	const file = path.split("/").pop() || "";
	return /(^|[^a-z])deploy/i.test(file) || /(^|[^a-z])deploy/i.test(name);
}

/**
 * Where a deploy notification sends you — the repo's Builds view in the console (#338).
 *
 * It used to be `run.url`, the GitHub Actions run. That is cross-origin, and a notification
 * click hands its target to an already-open tab via `WindowClient.navigate()`, which is
 * same-origin ONLY by spec. So with the console open the navigate rejected, the service worker
 * swallowed it, and the click just focused a tab that had not moved — while with the console
 * CLOSED the same click reached `openWindow()` and did open GitHub. Same click, two outcomes,
 * differing by whether the app was already running.
 *
 * There is no per-deploy page in the product to aim at, and deferring the notification until
 * one existed would not help: the only per-run artifact is GitHub's own, which is exactly the
 * thing we cannot navigate to. So this links the stable parent that is already there when the
 * sweep runs — the repo — and the Builds view inside it carries the run, its history, and a
 * one-click "View run" out to GitHub for the CI log itself.
 *
 * Consumer: `deepLinkedBuildsRepo` in store/console/src/lib/deepLink.ts. The URL itself is built
 * by `codingBuildsLink` with every other console link this Worker emits, so it is checked against
 * the router (#344); this stays as the name the deploy sweep and its tests already know it by.
 */
export function deployDeepLink(instanceId: string, repoId: string): string {
	return codingBuildsLink(instanceId, repoId);
}

/** The watermark's format. A stored value that is not one of these predates #359 — see below. */
const SHA_WATERMARK = "sha:";

/** Runs, newest first, without trusting the API's ordering. */
function newestFirst(runs: WatchedRun[]): WatchedRun[] {
	return [...runs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/**
 * Should this sweep produce a notification, and what should the new watermark be?
 *
 * **The event is a COMMIT's deploy, not a workflow run** — the correction #359 is really about.
 * The old watermark was a single run id (`coding_repos.last_deploy_run_id`) compared against
 * "the newest run in the repo", and this repo has seven workflows: one push to `main` starts two
 * to four of them, they finish at different times, so successive per-minute sweeps each saw a
 * different newest run id and each fired. It could never settle — no amount of dedup on a run id
 * can, because the run id was never the thing the user cares about. They pushed once; they should
 * be told once. So the runs for one `head_sha` are collapsed into one notification, and the
 * watermark is the commit.
 *
 * It also drops the per-workflow run number from the title. `#412` from CI and `#88` from Deploy
 * API arrive for the same commit and carry no meaning across notifications; the short sha does,
 * and it is the same string the user sees in `git log`.
 *
 * Pure so the one genuinely dangerous case stays testable: **first sight of a repo must never
 * notify**. Every repo that already exists has a completed run behind it, so a watcher that
 * notified on whatever it found first would, on the deploy after this ships, tell every user
 * about a build they ran days ago — arriving as a push notification. That now covers one more
 * case: a watermark written by the PREVIOUS format is a run id, which can never equal a commit
 * sha, so it is treated as first sight and re-seeded silently rather than announcing a deploy
 * that already happened.
 */
export function decideDeployNotification(
	runs: WatchedRun[],
	lastNotified: string | null,
	repoName: string,
	/** Same-origin click target — see `deployDeepLink`. The GitHub run URL is NOT usable here. */
	deepLink: string,
): DeployNotifyDecision {
	const deploys = runs.filter((r) => isDeployWorkflow(r.workflowName, r.workflowPath) && r.sha);
	if (!deploys.length) return { notify: false, seenId: lastNotified, reason: "no-run" };

	// `completed` is the only state worth interrupting someone for, and only some conclusions
	// are evidence of anything. queued/in_progress/cancelled come back round on a later sweep.
	const reportable = newestFirst(
		deploys.filter((r) => r.status === "completed" && REPORTABLE.has(r.conclusion ?? "")),
	);
	if (!reportable.length) return { notify: false, seenId: lastNotified, reason: "still-running" };

	const sha = reportable[0].sha;
	const seenId = `${SHA_WATERMARK}${sha}`;
	if (lastNotified === seenId) return { notify: false, seenId, reason: "already-notified" };
	if (!lastNotified?.startsWith(SHA_WATERMARK)) {
		// Seed the watermark, say nothing. See the note above.
		return { notify: false, seenId, reason: "first-sight" };
	}

	// Everything this sweep can see about THIS commit — several deploy workflows for one push is
	// one deploy with several parts, so the body names the parts instead of arriving N times.
	const forCommit = reportable.filter((r) => r.sha === sha);
	const short = sha.slice(0, 7);
	const failed = forCommit.filter((r) => r.conclusion !== "success");
	const label = (list: WatchedRun[]) => [...new Set(list.map((r) => r.workflowName).filter(Boolean))].join(", ");

	if (failed.length) {
		const what = label(failed) || "a deploy workflow";
		return {
			notify: true,
			seenId,
			title: `❌ Deploy failed ${short}`,
			body: `${repoName} — ${what} ${failed[0].conclusion || "failed"}. Open Builds to see why.`,
			url: deepLink,
		};
	}
	const what = label(forCommit);
	return {
		notify: true,
		seenId,
		title: `✅ Deployed ${short}`,
		body: what ? `${repoName} is live — ${what}.` : `${repoName} is live.`,
		url: deepLink,
	};
}

interface RepoRow {
	id: string;
	instance_id: string;
	user_id: string;
	name: string;
	github_repo: string;
	/**
	 * The watermark. Since #359 it holds `sha:<commit>`, NOT a run id — the column keeps its
	 * legacy name (like `coding_sessions.tmux_session`, which has held an engine label since
	 * #247) because renaming a column to match a decision is a migration, and the decision is
	 * what changed: one commit is one deploy, however many workflows built it. A stored value in
	 * the old format is handled as first sight rather than migrated, which is one silent re-seed
	 * per repo and no notification for a build that already went out.
	 */
	last_deploy_run_id: string | null;
}

/**
 * One sweep. Never throws — a broken watcher must not take the cron down with it, and the
 * other sweeps sharing that handler are independent failure domains.
 */
export async function runDeployWatch(env: Env): Promise<void> {
	let repos: RepoRow[] = [];
	try {
		// Oldest-checked first, so a bounded batch still rotates over every repo instead of
		// starving the tail.
		const { results } = await env.DB.prepare(
			`SELECT id, instance_id, user_id, name, github_repo, last_deploy_run_id
			   FROM coding_repos
			  WHERE github_repo IS NOT NULL AND github_repo <> ''
			  ORDER BY COALESCE(last_deploy_checked_at, '') ASC
			  LIMIT ?1`,
		)
			.bind(DEPLOY_WATCH_BATCH)
			.all<RepoRow>();
		repos = results ?? [];
	} catch {
		return; // table/columns not migrated yet — nothing to do
	}

	for (const repo of repos) {
		try {
			const owner = repo.github_repo.split("/")[0] ?? "";
			// Private repos need the installation token; public ones work unauthenticated but
			// burn the shared 60/hr cap, so use the token whenever there is one.
			const token = (await installationTokenForOwner(env, repo.user_id, owner).catch(() => null)) ?? undefined;
			// `event=push` + `status=completed` at the API, deploy-vs-CI in `decideDeployNotification`.
			// Filtering here rather than only in the decision keeps the page useful: an unfiltered
			// page of 20 on a busy repo can be entirely PR runs and in-progress churn, leaving the
			// decision nothing to look at.
			const res = await fetchWorkflowRuns(repo.github_repo, token, {
				perPage: DEPLOY_WATCH_RUNS_PER_REPO,
				event: "push",
				status: "completed",
			});
			const runs: WatchedRun[] = ("runs" in res ? res.runs : []).map((raw) => {
				const mapped = mapWorkflowRun(raw);
				return {
					id: String((raw as { id?: unknown }).id ?? ""),
					status: String(mapped.status ?? ""),
					conclusion: (mapped.conclusion as string | null) ?? null,
					runNumber: mapped.runNumber ?? null,
					url: mapped.url ?? "",
					// The FULL sha off the raw run — `mapped.sha` is truncated for display, and this
					// one is the watermark.
					sha: typeof raw.head_sha === "string" ? raw.head_sha : "",
					workflowName: String(mapped.name ?? ""),
					workflowPath: typeof raw.path === "string" ? raw.path : "",
					updatedAt: mapped.updatedAt ?? "",
				};
			});

			const decision = decideDeployNotification(
				runs,
				repo.last_deploy_run_id,
				repo.name,
				deployDeepLink(repo.instance_id, repo.id),
			);
			if (decision.notify) {
				// The event is the commit, declared to the notification floor (#361) so that even if
				// the watermark above were wrong again, one commit's deploy can buzz once per window.
				// Belt and braces on purpose: this is the fourth defect in this area.
				await notifyUser(env, repo.user_id, "deploy", decision.title, decision.body, decision.url, {
					key: `deploy:${repo.id}:${decision.seenId}`,
				}).catch(() => undefined);
			}
			// Always stamp the check, even when nothing happened — it is the rotation key, and
			// leaving it unset would pin the batch to the same repos forever.
			await env.DB.prepare(
				"UPDATE coding_repos SET last_deploy_run_id = ?1, last_deploy_checked_at = datetime('now') WHERE id = ?2",
			)
				.bind(decision.seenId, repo.id)
				.run()
				.catch(() => undefined);
		} catch {
			// One repo's failure must not end the sweep for the rest.
		}
	}
}
