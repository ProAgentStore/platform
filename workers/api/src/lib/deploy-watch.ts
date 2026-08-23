import { codingBuildsLink } from "./console-links.js";
import { logError } from "./error-log.js";
import { fetchWorkflowRuns, mapWorkflowRun } from "./github-actions.js";
import { resolveGithubRead } from "./github-cache.js";
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
	/**
	 * ISO. Orders runs newest-first without trusting the API's order — and since #708 it is also
	 * the watermark's second half, which is what makes the watcher's progress MONOTONIC. Read the
	 * note on `decideDeployNotification`.
	 */
	updatedAt: string;
}

/**
 * What the watcher already knows about this repo, and when "now" is.
 *
 * Grouped rather than passed as four positional arguments because the three pieces of state
 * have to move TOGETHER: `lastNotified` without `lastDeployAt` is exactly the watcher that had
 * no notion of forward (#708), and a decision that advanced one without the other would
 * reintroduce it a different way.
 */
export interface DeployWatchState {
	/** The watermark — `sha:<commit>` of the last deploy announced, or `null`/legacy run id. */
	lastNotified: string | null;
	/**
	 * `updated_at` of the run that watermark was taken from. `null` means UNKNOWN — a row written
	 * before this column existed, or one that has not been swept since. Unknown must mean "allow
	 * and then record", never "block": treating it as a floor would silence every repo's next
	 * deploy exactly once, which is the same class of bug as the one being fixed.
	 */
	lastDeployAt: string | null;
	/** ms epoch. Injected so the age floor below is testable rather than clock-dependent. */
	now: number;
}

export type DeployNotifyDecision =
	| {
			notify: false;
			seenId: string | null;
			seenAt: string | null;
			reason: "no-run" | "still-running" | "already-notified" | "first-sight" | "stale-page";
	  }
	/** `seenAt` is nullable on this arm too: a run whose `updated_at` we cannot parse is still a
	 *  real deploy worth announcing, it just leaves the order unknown for one more sweep. */
	| { notify: true; seenId: string; seenAt: string | null; title: string; body: string; url: string };

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

/**
 * The identity of the EVENT a deploy notification is about, for the #361 floor.
 *
 * The repository, not the `coding_repos` row (#709). A repo is attached PER WORKSPACE, and
 * attaching one repository to a Coder and to a tmux Coder is a supported shape — `createRepo`
 * does not de-duplicate by `github_repo` and should not. But the deploy is ONE event in the
 * world, and keying on the row made four workspaces watching `ProAgentStore/platform` look like
 * four unrelated events: one push buzzed four times in 39 seconds, 0.3–1.0 minutes apart, well
 * inside the floor's ten-minute window, which never got the chance to collapse them.
 *
 * The prose fallback would not have saved it either: each row's sweep reads the page seconds
 * apart and names a different subset of the workflows ("Deploy MCP Worker" vs "Deploy Host
 * Worker" vs all three), so a `title|body` key sees three distinct events. That is exactly the
 * failure `lib/notifications.ts` documents and the reason an explicit event key exists. The
 * reasoning was right; the key just stopped one level too low.
 *
 * Each row still WRITES its own notification row with its own deep link, so the bell list still
 * says which workspace it came from and #338's link is untouched. Only the interruption
 * collapses — which is precisely the split #360/#361 made.
 *
 * Lower-cased for the same reason `lib/github-cache.ts` normalises: GitHub is case-insensitive
 * about `owner/name` and two rows can spell one repository differently.
 */
export function deployEventKey(githubRepo: string, seenId: string): string {
	return `deploy:${githubRepo.toLowerCase()}:${seenId}`;
}

/** The watermark's format. A stored value that is not one of these predates #359 — see below. */
const SHA_WATERMARK = "sha:";

/**
 * How old the newest deploy run on a page may be before the watcher declines to speak about it,
 * **when it has no recorded order to compare against** (`lastDeployAt === null`).
 *
 * This is the fallback arm of #708's fix, not the main one. Where the order IS known the
 * comparison is exact and this horizon is deliberately NOT consulted: a run newer than the one
 * we already announced is a deploy we have not announced, and announcing it late is right even
 * if the sweep fell hours behind. Applying an age floor there could only silence a real deploy,
 * which is the regression #708 names.
 *
 * It earns its place in the one window the exact test cannot judge: the first sweep of a row
 * whose `last_deploy_at` is still NULL. A stale page read in that window would both misfire and
 * record its own staleness, so something has to hold the line, and "a deploy that finished six
 * hours ago is not news" is true independent of any watermark — a deploy notification exists to
 * answer *is it green yet*, and one arriving six hours later has no reader.
 *
 * Six hours: the sweep is bounded at `DEPLOY_WATCH_BATCH` per minute across ALL users' repos, so
 * its rotation period grows with the table and is not a per-user guarantee. Six hours is three
 * orders of magnitude below the weeks-old snapshots actually observed and far above any
 * plausible rotation lag.
 */
export const DEPLOY_MAX_UNORDERED_AGE_MS = 6 * 60 * 60 * 1000;

/** ms epoch, or `null` when the value is missing or not a date we can order by. */
function instant(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}

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
 *
 * **And the watermark only ever moves FORWARD** — #708, the fifth defect here and the first that
 * is not about an event's identity. GitHub's runs list occasionally answers an identical request
 * with a weeks-old snapshot (measured: ~1 in 290), and the cache serves a stored page when GitHub
 * is unreachable. Against a watermark compared only for EQUALITY, an older commit is simply "not
 * the one I last said" and therefore news; the sweep then wrote that older commit back as the
 * watermark, so the next correct read differed from it and fired again. One bad read cost exactly
 * two notifications a minute apart and left the state clean enough to do it again forever — 82
 * rows in 52 hours for a repository nobody had pushed to in five days.
 *
 * So the decision now carries `seenAt` beside `seenId`, and a page whose newest deploy run
 * predates the recorded one is refused: no notification, **and the watermark is returned
 * unmoved**. Both halves are needed. Refusing to speak while still rolling the watermark back
 * would leave the second buzz of the pair exactly where it was.
 *
 * `seenAt` advances on `already-notified` too, on purpose: an idle repo sits on that branch every
 * minute, and it is the only path by which a row whose `last_deploy_at` is NULL ever acquires
 * one. Without it the guard would stay dormant for precisely the repos that flap the most.
 */
export function decideDeployNotification(
	runs: WatchedRun[],
	state: DeployWatchState,
	repoName: string,
	/** Same-origin click target — see `deployDeepLink`. The GitHub run URL is NOT usable here. */
	deepLink: string,
): DeployNotifyDecision {
	const { lastNotified, lastDeployAt, now } = state;
	/** Neither half of the watermark moves. The shape every refusal returns. */
	const hold = (reason: "no-run" | "still-running" | "stale-page"): DeployNotifyDecision => ({
		notify: false,
		seenId: lastNotified,
		seenAt: lastDeployAt,
		reason,
	});

	const deploys = runs.filter((r) => isDeployWorkflow(r.workflowName, r.workflowPath) && r.sha);
	if (!deploys.length) return hold("no-run");

	// `completed` is the only state worth interrupting someone for, and only some conclusions
	// are evidence of anything. queued/in_progress/cancelled come back round on a later sweep.
	const reportable = newestFirst(
		deploys.filter((r) => r.status === "completed" && REPORTABLE.has(r.conclusion ?? "")),
	);
	if (!reportable.length) return hold("still-running");

	const newest = reportable[0];
	const sha = newest.sha;
	const seenId = `${SHA_WATERMARK}${sha}`;
	// Fall back to the recorded instant when the run carries no usable timestamp, so a malformed
	// `updated_at` cannot erase a good one.
	const seenAt = newest.updatedAt || lastDeployAt;
	if (lastNotified === seenId) return { notify: false, seenId, seenAt, reason: "already-notified" };
	if (!lastNotified?.startsWith(SHA_WATERMARK)) {
		// Seed the watermark, say nothing. See the note above.
		return { notify: false, seenId, seenAt, reason: "first-sight" };
	}

	const at = instant(newest.updatedAt);
	const recorded = instant(lastDeployAt);
	if (recorded !== null) {
		// The exact test. This commit differs from the watermark AND its run is older than the one
		// the watermark was taken from, so this page is a snapshot from before we last spoke.
		if (at !== null && at < recorded) return hold("stale-page");
	} else if (at !== null && now - at > DEPLOY_MAX_UNORDERED_AGE_MS) {
		// No recorded order to compare against — the one window where the age floor is the only
		// thing standing between a stale snapshot and someone's phone.
		return hold("stale-page");
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
			seenAt,
			title: `❌ Deploy failed ${short}`,
			body: `${repoName} — ${what} ${failed[0].conclusion || "failed"}. Open Builds to see why.`,
			url: deepLink,
		};
	}
	const what = label(forCommit);
	return {
		notify: true,
		seenId,
		seenAt,
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
	/**
	 * The watermark's other half (#708): `updated_at` of the run `last_deploy_run_id` was taken
	 * from. It is what makes the watermark ORDERED rather than merely an identity — see
	 * `decideDeployNotification`. NULL means unknown, which allows and then records.
	 */
	last_deploy_at: string | null;
}

/**
 * Persist the watermark and stamp the rotation key, in one statement.
 *
 * The two columns are written together everywhere, including on the paths that advance neither,
 * because the decision already computed what each should be. Splitting them into "sometimes we
 * update the id, sometimes the instant" is how they would drift apart, and a `sha:` with a
 * mismatched instant is worse than either alone.
 */
async function writeWatermark(env: Env, repoId: string, seenId: string | null, seenAt: string | null): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_repos
		    SET last_deploy_run_id = ?1, last_deploy_at = ?2, last_deploy_checked_at = datetime('now')
		  WHERE id = ?3`,
	)
		.bind(seenId, seenAt, repoId)
		.run()
		.catch(() => undefined);
}

/**
 * A sweep declined to act on what it read. Record it, and rotate on without moving the watermark.
 *
 * `warn`, not `error`: nothing is broken here — this is the guard doing its job, and GitHub
 * serving an old snapshot is not a fault of ours to page anyone about. But it must be COUNTABLE.
 * `logError` collapses repeats into one row with a count, so a watcher quietly refusing a repo's
 * every sweep shows up as a rising number in the admin Errors view instead of as silence.
 */
async function recordDeclined(
	env: Env,
	repo: Pick<RepoRow, "id" | "user_id" | "github_repo" | "instance_id">,
	why: string,
	state: { lastNotified: string | null; lastDeployAt: string | null },
): Promise<void> {
	await logError(env, {
		source: "deploy-watch",
		level: "warn",
		message: `declined a stale runs page for ${repo.github_repo}: ${why}`,
		userId: repo.user_id,
		context: {
			repoId: repo.id,
			instanceId: repo.instance_id,
			githubRepo: repo.github_repo,
			lastNotified: state.lastNotified,
			lastDeployAt: state.lastDeployAt,
		},
	}).catch(() => undefined);
	// The rotation key still moves — a declined repo must not pin the batch to itself.
	await env.DB.prepare("UPDATE coding_repos SET last_deploy_checked_at = datetime('now') WHERE id = ?1")
		.bind(repo.id)
		.run()
		.catch(() => undefined);
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
			`SELECT id, instance_id, user_id, name, github_repo, last_deploy_run_id, last_deploy_at
			   FROM coding_repos
			  WHERE github_repo IS NOT NULL AND github_repo <> ''
			  ORDER BY COALESCE(last_deploy_checked_at, '') ASC
			  LIMIT ?1`,
		)
			.bind(DEPLOY_WATCH_BATCH)
			.all<RepoRow>();
		repos = results ?? [];
	} catch (err) {
		// This `catch` used to be bare, with a comment naming ONE cause ("table/columns not
		// migrated yet") while taking EVERY cause: a D1 outage, a partial migration, a
		// Worker/migration ordering skew. Any of them ended the sweep for ALL repos, silently, on
		// every cron tick — so "no errors" and "dead every minute" were the same observation
		// (#745). An audit of #708 hit exactly that ambiguity: `/v1/admin/errors?source=
		// deploy-watch` returned count 0 over 27 hours and could not say whether the decline path
		// had never been reached or the sweep had never got past this line.
		//
		// The reported LEVEL separates the two causes the comment used to conflate, because they
		// need different reactions: a missing table on a fresh environment is expected and settles
		// itself, a failing SELECT on a migrated one does not. Both write a row — the defect being
		// fixed is the silence, not the severity.
		const detail = err instanceof Error ? err.message : String(err);
		const notMigrated = /no such (table|column)/i.test(detail);
		await logError(env, {
			source: "deploy-watch",
			level: notMigrated ? "warn" : "error",
			message: notMigrated
				? `deploy-watch sweep skipped: coding_repos not migrated yet (${detail})`
				: `deploy-watch sweep could not read coding_repos, so NO repo was checked this tick: ${detail}`,
			context: { query: "SELECT coding_repos FOR deploy watch", batch: DEPLOY_WATCH_BATCH },
		}).catch(() => undefined);
		return;
	}

	for (const repo of repos) {
		try {
			const owner = repo.github_repo.split("/")[0] ?? "";
			// Private repos need the installation token; public ones work unauthenticated but
			// burn the shared 60/hr cap, so use the token whenever there is one.
			//
			// `resolveGithubRead` (#418) yields the token AND the auth context it was minted under
			// in one call, so the conditional cache's identity comes from the same resolution as
			// the credential — never a `user_id` read off the row separately. This is a per-minute
			// cron over every watched repo, so it is a per-repo-per-minute Actions request; on an
			// unchanged repo it now costs a 304 and no primary rate limit. `listUserInstallations`
			// is a D1 read, so establishing the context spends no GitHub budget of its own.
			const { token: tok, authContext } = await resolveGithubRead(env, repo.user_id, owner);
			const token = tok ?? undefined;
			// `event=push` + `status=completed` at the API, deploy-vs-CI in `decideDeployNotification`.
			// Filtering here rather than only in the decision keeps the page useful: an unfiltered
			// page of 20 on a busy repo can be entirely PR runs and in-progress churn, leaving the
			// decision nothing to look at.
			const res = await fetchWorkflowRuns(
				repo.github_repo,
				token,
				{ perPage: DEPLOY_WATCH_RUNS_PER_REPO, event: "push", status: "completed" },
				{ env, identity: { userId: repo.user_id, authContext } },
			);
			if ("runs" in res && res.stale) {
				// GitHub was unreachable and the conditional cache served its stored copy (#708).
				// A panel should render that rather than nothing; a notification must not fire from
				// it, because the stored page can name a run that is no longer the newest. Stamp the
				// rotation key so the batch still moves on, and touch neither half of the watermark.
				await recordDeclined(env, repo, "github unreachable — served a stored runs page", {
					lastNotified: repo.last_deploy_run_id,
					lastDeployAt: repo.last_deploy_at,
				});
				continue;
			}
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
				{ lastNotified: repo.last_deploy_run_id, lastDeployAt: repo.last_deploy_at, now: Date.now() },
				repo.name,
				deployDeepLink(repo.instance_id, repo.id),
			);
			if (decision.notify) {
				// The event is the commit, declared to the notification floor (#361) so that even if
				// the watermark above were wrong again, one commit's deploy can buzz once per window.
				// Belt and braces on purpose: this is the fourth defect in this area.
				await notifyUser(env, repo.user_id, "deploy", decision.title, decision.body, decision.url, {
					key: deployEventKey(repo.github_repo, decision.seenId),
				}).catch(() => undefined);
			} else if (decision.reason === "stale-page") {
				// The rejection has to leave a trace somewhere other than the owner's phone. This
				// failure mode survived four fixes precisely because it was invisible from the
				// inside: every component reported success and the only evidence was the buzzing.
				await recordDeclined(env, repo, "runs page is older than the deploy already reported", {
					lastNotified: repo.last_deploy_run_id,
					lastDeployAt: repo.last_deploy_at,
				});
				continue;
			}
			// Always stamp the check, even when nothing happened — it is the rotation key, and
			// leaving it unset would pin the batch to the same repos forever. Both halves of the
			// watermark are written together (#708): an id without its instant is the watcher that
			// could not tell forward from backward.
			await writeWatermark(env, repo.id, decision.seenId, decision.seenAt);
		} catch (err) {
			// One repo's failure must not end the sweep for the rest — but it must not be free
			// either. Before #745 a repo that failed every tick was invisible: the isolation was
			// right and the silence was the bug. `logError` collapses repeats into one row with a
			// count, so a permanently-broken repo is a rising number rather than 1,440 rows a day.
			await logError(env, {
				source: "deploy-watch",
				level: "warn",
				message: `deploy-watch skipped ${repo.github_repo}: ${err instanceof Error ? err.message : String(err)}`,
				userId: repo.user_id,
				context: { repoId: repo.id, instanceId: repo.instance_id, githubRepo: repo.github_repo },
			}).catch(() => undefined);
		}
	}
}
