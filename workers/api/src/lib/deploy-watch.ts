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
}

export type DeployNotifyDecision =
	| { notify: false; seenId: string | null; reason: "no-run" | "still-running" | "already-notified" | "first-sight" }
	| { notify: true; seenId: string; title: string; body: string; url: string };

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

/**
 * Should this run produce a notification, and what should the new watermark be?
 *
 * Pure so the one genuinely dangerous case is testable: **first sight of a repo must never
 * notify**. Every repo that already exists has a completed run behind it, so a watcher that
 * notified on whatever it found first would, on the deploy after this ships, tell every user
 * about a build they ran days ago — arriving as a push notification. It records the watermark
 * silently instead and speaks only for the NEXT one.
 */
export function decideDeployNotification(
	run: WatchedRun | null,
	lastNotifiedRunId: string | null,
	repoName: string,
	/** Same-origin click target — see `deployDeepLink`. The GitHub run URL is NOT usable here. */
	deepLink: string,
): DeployNotifyDecision {
	if (!run) return { notify: false, seenId: lastNotifiedRunId, reason: "no-run" };
	// `completed` is the only state worth interrupting someone for. queued/in_progress will
	// come back round on a later sweep.
	if (run.status !== "completed") return { notify: false, seenId: lastNotifiedRunId, reason: "still-running" };
	if (lastNotifiedRunId === run.id) return { notify: false, seenId: lastNotifiedRunId, reason: "already-notified" };
	if (lastNotifiedRunId === null) {
		// Seed the watermark, say nothing. See the note above.
		return { notify: false, seenId: run.id, reason: "first-sight" };
	}
	const ok = run.conclusion === "success";
	const n = run.runNumber != null ? ` #${run.runNumber}` : "";
	return {
		notify: true,
		seenId: run.id,
		title: ok ? `✅ Deployed${n}` : `❌ Build failed${n}`,
		body: ok ? `${repoName} is live.` : `${repoName} — ${run.conclusion || "failed"}. Open the run to see why.`,
		url: deepLink,
	};
}

interface RepoRow {
	id: string;
	instance_id: string;
	user_id: string;
	name: string;
	github_repo: string;
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
			const res = await fetchWorkflowRuns(repo.github_repo, token, { perPage: 1 });
			const raw = "runs" in res ? res.runs[0] : undefined;
			const mapped = raw ? mapWorkflowRun(raw) : null;
			const run: WatchedRun | null =
				raw && mapped
					? {
							id: String((raw as { id?: unknown }).id ?? ""),
							status: String(mapped.status ?? ""),
							conclusion: (mapped.conclusion as string | null) ?? null,
							runNumber: mapped.runNumber ?? null,
							url: mapped.url ?? "",
						}
					: null;

			const decision = decideDeployNotification(
				run,
				repo.last_deploy_run_id,
				repo.name,
				deployDeepLink(repo.instance_id, repo.id),
			);
			if (decision.notify) {
				await notifyUser(env, repo.user_id, "deploy", decision.title, decision.body, decision.url).catch(() => undefined);
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
