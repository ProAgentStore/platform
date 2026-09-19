import { logError } from "./error-log.js";
import { installationTokenForOwner } from "./github-app.js";
import { githubAuthContext, githubConditionalJson, invalidateGithubCache } from "./github-cache.js";
import { invalidateIssueCaches, readIssue } from "./github-issues.js";
import type { Env } from "../types.js";

/**
 * Close an issue named by a closing keyword in a commit pushed to a repo's default branch (#816).
 *
 * ── READ THIS FIRST: this sweep is expected to close nothing
 *
 * #816's premise is that "GitHub's native 'Closes #123' auto-close only fires when a pull request
 * carrying that keyword is merged — it never fires on a direct push, even to main". That is not
 * what GitHub does. Native auto-close fires on a direct push to the default branch with no pull
 * request anywhere. Verified 2026-09-19 against the two repos #816 itself names — every commit
 * below is on `main` with zero associated PRs (`GET /repos/{repo}/commits/{sha}/pulls` -> 0):
 *
 *   chess-academy `e9d065c2`  "…(closes #151)"        -> timeline `closed`, commit_id set
 *   chess-academy `603527c0`  body "Closes #141"      -> timeline `closed`, commit_id set
 *   this repo     `b47cf05e`  "…(closes #808)"        -> timeline `closed`, commit_id set
 *   chess-academy `47e9e2b8`  "…(#124)"   bare ref    -> timeline `referenced` only
 *   chess-academy `e81a1179`  "feat(#125):" bare ref  -> timeline `referenced` only
 *
 * Keyword -> closed by commit. No keyword -> referenced. GitHub behaved exactly as documented in
 * all five cases, and both keyword-less commits are ancestors of `main`
 * (`GET /compare/main...{sha}` -> "behind"), so "it never reached the default branch" is ruled out.
 *
 * So by the time this sweep reads a commit, GitHub has already closed whatever that commit named,
 * and {@link closeIssueForCommit} will return `already-closed`. The module is built because #816
 * was reaffirmed after that finding was filed on the issue. The reasoning is recorded here, in
 * migration `0153_commit_close_watch.sql` and in the commit message so that nobody has to
 * re-derive it — and so that a future reader who finds this sweep's closure count pinned at zero
 * knows that is the designed outcome, not a broken watcher.
 *
 * Because of that, every decision below is biased towards DOING NOTHING. The sweep re-derives a
 * result GitHub already delivered, so its only available failure mode is closing something GitHub
 * deliberately left open. `already-closed` is a skip, never a write; a bare `#123` is a reference
 * and is not matched; and first sight of a repo scans no history at all.
 *
 * ── Shape
 *
 * A per-minute cron sweep over `coding_repos`, modelled on `lib/deploy-watch.ts`, which is the
 * only other place in this Worker that tracks per-commit state against GitHub. It borrows that
 * module's three hard-won rules verbatim, because each of them was a defect there first:
 *
 *   • first sight seeds the watermark and acts on nothing (#359),
 *   • the watermark carries an INSTANT as well as an identity, so it can only move forward (#708),
 *   • a refusal is recorded rather than silent (#745).
 */

/** How many repos one sweep may poll. Bounded like `DEPLOY_WATCH_BATCH`, and rotating by staleness
 *  rather than trying to cover every repo every minute. */
export const COMMIT_CLOSE_BATCH = 20;

/** How many default-branch commits one repo's sweep reads. One page, newest first. */
export const COMMIT_CLOSE_COMMITS_PER_REPO = 20;

/**
 * How many issues one repo may have closed in a single sweep.
 *
 * A ceiling, not a target. The expected value is zero (see the module note); anything approaching
 * this bound means the watermark logic has gone wrong and the sweep is walking history, and the
 * damage of that is measured in other people's closed issues. Capping it turns a runaway into a
 * bounded, visible, repeatable event instead of a one-shot mass close.
 */
export const COMMIT_CLOSE_MAX_CLOSURES_PER_REPO = 5;

/**
 * How old the newest commit on a page may be before the sweep declines it, **when there is no
 * recorded order to compare against** (`lastAt === null`).
 *
 * The fallback arm of the monotonic guard, exactly as in `deploy-watch.ts`: where the order IS
 * known the comparison is exact and this horizon is not consulted. It covers the single window the
 * exact test cannot judge — the first sweep of a row whose instant is still NULL — where a stale
 * page would both act and record its own staleness.
 */
export const COMMIT_CLOSE_MAX_UNORDERED_AGE_MS = 6 * 60 * 60 * 1000;

/** An issue a commit message asked to close. `repo` is non-null only for a cross-repo reference. */
export interface ClosingRef {
	/** `owner/name` when the reference named one, else null meaning "this repo". */
	repo: string | null;
	number: number;
}

/**
 * GitHub's closing-keyword grammar, mirrored.
 *
 * The keyword set and the three reference forms are GitHub's documented ones: `close`/`closes`/
 * `closed`, `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`, followed by `#123`, `GH-123`
 * or `owner/repo#123`, with an optional colon after the keyword. Case-insensitive.
 *
 * Three properties are load-bearing, and each one is why a naive `/#(\d+)/` would be wrong:
 *
 *   • **A bare `#123` is NOT a match.** `fix: clock-guard hotfix … (#124)` and `feat(#125): …` are
 *     the two real commits from #816's own incident, and GitHub recorded both as `referenced`
 *     rather than `closed` — correctly, because a conventional-commit type or scope is not a
 *     closing keyword. A scanner that treated a bare reference as closing would be MORE aggressive
 *     than GitHub and would close every issue a commit merely mentions. That is the single most
 *     damaging thing this module could do, and the leading `\s+` after the keyword is what stops
 *     it: in both commits the character after `fix` is `:` or `(` followed by prose, never a ref.
 *   • **The keyword must be a whole word.** The lookbehind stops `prefixes #12` matching on `fixes`
 *     and `postfix #12` on `fix`.
 *   • **The whole message is scanned, subject and body.** `603527c0` above carries a bare `(#141)`
 *     in its subject and `Closes #141` on the last line of its body; GitHub closed it on the body.
 *     Scanning the subject alone would have missed a real, verified close.
 *
 * Inherited from GitHub, deliberately and with a known cost: this matches inside ordinary prose, so
 * a commit whose body says "this does not close #99's second half" closes #99. That has already
 * happened in this repo. It is GitHub's behaviour and #816 asked for a mirror of it, so it is
 * mirrored rather than corrected — `refs #99` is the form that does not close.
 */
const CLOSING_REF =
	/(?<![A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#|gh-|#)(\d{1,9})(?![0-9])/gi;

/**
 * Every issue a commit message asks to close, deduplicated, in the order they appear.
 *
 * Pure, and exported for its own tests: this function decides whether somebody else's issue gets
 * closed, and it is the one part of the feature that can be checked exhaustively without touching
 * GitHub. The fixtures in `commit-close-watch.test.ts` include the five real commits traced above.
 */
export function parseClosingRefs(message: string): ClosingRef[] {
	const out: ClosingRef[] = [];
	const seen = new Set<string>();
	// A fresh regex per call: CLOSING_REF is global, and a shared `lastIndex` across calls makes
	// the result depend on what was parsed before it — the classic sticky-state bug, which here
	// would silently skip refs on every other commit.
	const re = new RegExp(CLOSING_REF.source, CLOSING_REF.flags);
	for (const m of String(message || "").matchAll(re)) {
		const number = Number(m[2]);
		if (!Number.isFinite(number) || number <= 0) continue;
		const repo = m[1] ? m[1].toLowerCase() : null;
		const key = `${repo ?? ""}#${number}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ repo, number });
	}
	return out;
}

/** One default-branch commit, reduced to what the decision needs. */
export interface ScannedCommit {
	sha: string;
	/** Subject and body, exactly as GitHub returns it — see `CLOSING_REF` on why both matter. */
	message: string;
	/** ISO committer date. The watermark's second half; `""` when GitHub returned none. */
	committedAt: string;
}

/** What the sweep already knows about this repo, and when "now" is. */
export interface CommitScanState {
	/** The newest default-branch commit already scanned, or null for a repo never swept. */
	lastSha: string | null;
	/** The committer date `lastSha` was taken from. NULL means UNKNOWN: allow, then record. */
	lastAt: string | null;
	/** ms epoch, injected so the age floor is testable rather than clock-dependent. */
	now: number;
}

export type CommitScanDecision =
	| {
			scan: false;
			seenSha: string | null;
			seenAt: string | null;
			reason: "no-commits" | "already-scanned" | "first-sight" | "stale-page";
	  }
	| {
			scan: true;
			seenSha: string;
			seenAt: string | null;
			/** The unscanned commits, OLDEST first, so issues close in the order they were fixed. */
			commits: ScannedCommit[];
			/** True when the watermark was not on the page — older commits may have been skipped. */
			gap: boolean;
	  };

/** ms epoch, or null when the value is missing or not a date we can order by. */
function instant(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}

/**
 * Which commits on this page have not been scanned, and where the watermark should land.
 *
 * Pure, because the dangerous cases are all decisions rather than requests, and each of them is a
 * defect `deploy-watch.ts` shipped before it was fixed there:
 *
 *   • **First sight scans nothing.** Every repo already has history behind it, most of it referring
 *     to issues a human has since closed, reopened or deliberately left open. A sweep that acted on
 *     whatever it found first would, on the deploy after this ships, walk backwards through every
 *     watched repo and close issues on the strength of commits from months ago. It seeds and stays
 *     silent instead — one wasted sweep per repo, and no writes.
 *   • **The watermark only moves FORWARD.** GitHub's list endpoints occasionally answer an identical
 *     request with an old snapshot (measured at ~1 in 290 on the runs list, #708) and the
 *     conditional cache serves a stored page when GitHub is unreachable. Against an equality-only
 *     watermark an older commit is simply "not the one I last saw" and therefore new, and writing
 *     it back rolls the watermark BACKWARDS — which on this sweep does not merely re-notify, it
 *     re-walks commits. Both halves matter: a page older than the recorded instant is refused AND
 *     the watermark is returned unmoved.
 *   • **The watermark falling off the page is reported, not hidden.** `gap` is true when the sweep
 *     has fallen further behind than one page. Re-scanning is harmless (a closed issue is skipped),
 *     but commits older than the page are gone, and the caller records that rather than leaving a
 *     silent hole in a feature whose whole job is to stop the tracker drifting silently.
 */
export function decideCommitScan(commits: ScannedCommit[], state: CommitScanState): CommitScanDecision {
	const { lastSha, lastAt, now } = state;
	/** Neither half of the watermark moves. The shape every refusal returns. */
	const hold = (reason: "no-commits" | "stale-page"): CommitScanDecision => ({
		scan: false,
		seenSha: lastSha,
		seenAt: lastAt,
		reason,
	});

	const usable = commits.filter((c) => c.sha);
	if (!usable.length) return hold("no-commits");

	const newest = usable[0];
	const seenSha = newest.sha;
	// Fall back to the recorded instant when the commit carries no usable date, so a malformed
	// `committer.date` cannot erase a good one.
	const seenAt = newest.committedAt || lastAt;

	if (lastSha === seenSha) return { scan: false, seenSha, seenAt, reason: "already-scanned" };
	if (!lastSha) return { scan: false, seenSha, seenAt, reason: "first-sight" };

	const at = instant(newest.committedAt);
	const recorded = instant(lastAt);
	if (recorded !== null) {
		// The exact test: this page's newest commit predates the one the watermark was taken from,
		// so the page is a snapshot from before the last sweep.
		if (at !== null && at < recorded) return hold("stale-page");
	} else if (at !== null && now - at > COMMIT_CLOSE_MAX_UNORDERED_AGE_MS) {
		// No recorded order to compare against — the one window where the age floor is all there is.
		return hold("stale-page");
	}

	const idx = usable.findIndex((c) => c.sha === lastSha);
	const fresh = idx === -1 ? usable.slice() : usable.slice(0, idx);
	if (!fresh.length) return { scan: false, seenSha, seenAt, reason: "already-scanned" };
	// Oldest first: if two commits in one push both name issues, they should close in the order
	// they were written, and a bounded sweep should spend its budget on the oldest unscanned work.
	return { scan: true, seenSha, seenAt, commits: fresh.reverse(), gap: idx === -1 };
}

/** What happened to one reference. Every value except `closed` is a deliberate no-op. */
export type CloseOutcome = "closed" | "already-closed" | "not-an-issue" | "cross-repo" | "failed";

/**
 * How long either GitHub write may hang.
 *
 * Both calls below go to a compile-time-constant host, so they are not required to route through
 * `safeFetch` — but "fixed host" is not "bounded", and `fetch-deadline.test.ts` pins the number of
 * call sites in this Worker that can hang forever precisely so the count can only fall. This sweep
 * runs on the per-minute cron behind `ctx.waitUntil`, where an unbounded request does not fail
 * loudly; it just holds the isolate. Matched to `SAFE_FETCH_TIMEOUT_MS` so there is one answer in
 * this Worker to "how long do we wait for someone else's API".
 */
const COMMIT_CLOSE_FETCH_TIMEOUT_MS = 30_000;

const GH_HEADERS = (token: string) => ({
	Authorization: `token ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"Content-Type": "application/json",
	"User-Agent": "proagentstore-commit-close/1.0",
});

/**
 * Close one issue named by one commit, or explain why nothing was done.
 *
 * The state is READ before it is written, which on this sweep is the whole safety story rather
 * than an optimisation. GitHub has almost certainly closed the issue already (see the module
 * note), so `already-closed` is the expected outcome and it must be a skip: a blind PATCH would
 * be indistinguishable from a real close in the timeline, and a `state: "open"` request would
 * REOPEN an issue somebody closed on purpose. This function never sends `state: "open"` at all.
 *
 * A cross-repo reference is parsed but not acted on. `owner/repo#123` is part of GitHub's grammar
 * and dropping it silently would be a lie about what was scanned, but closing an issue in a
 * DIFFERENT repository from the one whose commit we read widens the blast radius past anything
 * #816 asked for, and the installation token may not even cover that owner. It is reported as
 * `cross-repo` and left alone.
 */
export async function closeIssueForCommit(
	env: Env,
	args: { userId: string; githubRepo: string; token: string; ref: ClosingRef; sha: string },
): Promise<CloseOutcome> {
	const { userId, githubRepo, token, ref, sha } = args;
	if (ref.repo && ref.repo !== githubRepo.toLowerCase()) return "cross-repo";

	const issue = await readIssue(env, userId, githubRepo, ref.number);
	// `readIssue` returns null for a pull request as well as for a missing number, which is the
	// behaviour wanted here: #816 is about issues, and a PR is closed by merging it.
	if (!issue) return "not-an-issue";
	if (issue.state !== "open") return "already-closed";

	const short = sha.slice(0, 7);
	const res = await fetch(`https://api.github.com/repos/${githubRepo}/issues/${ref.number}`, {
		method: "PATCH",
		headers: GH_HEADERS(token),
		body: JSON.stringify({ state: "closed", state_reason: "completed" }),
		signal: AbortSignal.timeout(COMMIT_CLOSE_FETCH_TIMEOUT_MS),
	}).catch(() => null);
	if (!res?.ok) {
		await logError(env, {
			source: "commit-close-watch",
			level: "warn",
			message: `could not close ${githubRepo}#${ref.number} for commit ${short}: GitHub returned ${res?.status ?? "no response"}`,
			userId,
			status: res?.status,
			context: { githubRepo, issue: ref.number, sha },
		}).catch(() => undefined);
		return "failed";
	}

	// The close is the deliverable and it has already landed; the comment is the audit trail, so it
	// is attempted afterwards and its failure does not undo or downgrade the close. Without it the
	// issue's timeline would show a close by an app with no statement of why — which is the silent
	// drift #816 is about, pointed the other way. Worded to carry no closing keyword of its own.
	await fetch(`https://api.github.com/repos/${githubRepo}/issues/${ref.number}/comments`, {
		method: "POST",
		headers: GH_HEADERS(token),
		body: JSON.stringify({
			body: `Closed automatically by ProAgentStore: commit \`${short}\` on the default branch of \`${githubRepo}\` names this issue with a closing keyword (#816).`,
		}),
		signal: AbortSignal.timeout(COMMIT_CLOSE_FETCH_TIMEOUT_MS),
	}).catch(() => {
		// Swallowed on purpose: the close succeeded, and reporting a failure here would be a
		// report about the wrong event. A missing comment costs an explanation, not a result.
		return null;
	});

	await invalidateIssueCaches(env, userId, githubRepo).catch(() => undefined);
	return "closed";
}

interface RepoRow {
	id: string;
	instance_id: string;
	user_id: string;
	github_repo: string;
	last_scanned_commit_sha: string | null;
	last_scanned_commit_at: string | null;
}

/** GitHub's commit list shape, reduced to the two fields this sweep reads. */
interface RawCommit {
	sha?: unknown;
	commit?: { message?: unknown; committer?: { date?: unknown } | null } | null;
}

/** The cache resource this module owns. */
export const COMMITS_RESOURCE = "commits";

/**
 * Persist the watermark and stamp the rotation key in one statement.
 *
 * Written together on every path, including the ones that advance neither, for the reason
 * `deploy-watch.ts` records: a sha with a mismatched instant is worse than either alone.
 */
async function writeWatermark(env: Env, repoId: string, seenSha: string | null, seenAt: string | null): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_repos
		    SET last_scanned_commit_sha = ?1, last_scanned_commit_at = ?2, last_commit_scan_at = datetime('now')
		  WHERE id = ?3`,
	)
		.bind(seenSha, seenAt, repoId)
		.run()
		.catch(() => undefined);
}

/** A sweep declined to act on what it read. Record it, rotate on, move no watermark. */
async function recordDeclined(env: Env, repo: RepoRow, why: string): Promise<void> {
	await logError(env, {
		source: "commit-close-watch",
		level: "warn",
		message: `declined a commits page for ${repo.github_repo}: ${why}`,
		userId: repo.user_id,
		context: {
			repoId: repo.id,
			instanceId: repo.instance_id,
			githubRepo: repo.github_repo,
			lastSha: repo.last_scanned_commit_sha,
			lastAt: repo.last_scanned_commit_at,
		},
	}).catch(() => undefined);
	await env.DB.prepare("UPDATE coding_repos SET last_commit_scan_at = datetime('now') WHERE id = ?1")
		.bind(repo.id)
		.run()
		.catch(() => undefined);
}

/** Scan one repo's unscanned default-branch commits. Extracted so the sweep's loop stays readable. */
async function sweepRepo(env: Env, repo: RepoRow): Promise<void> {
	const owner = repo.github_repo.split("/")[0] ?? "";
	// A WRITE token, not a read one. `deploy-watch` can fall back to unauthenticated reads because
	// it only ever reads; this sweep exists to close issues, and without an installation token it
	// cannot. Reading the page anyway would spend GitHub's shared 60/hr cap to compute a list of
	// things it is not able to do.
	const token = await installationTokenForOwner(env, repo.user_id, owner).catch(() => null);
	if (!token) {
		await recordDeclined(env, repo, "no GitHub App installation token for this owner — cannot close issues");
		return;
	}

	// No `sha` parameter: GitHub's commits endpoint defaults to the repository's DEFAULT BRANCH,
	// which is exactly the scope #816 specifies. Asking for the branch by name would mean a second
	// request per repo per minute to discover it, and would go wrong the moment a repo renames it.
	const qs = new URLSearchParams({ per_page: String(COMMIT_CLOSE_COMMITS_PER_REPO) }).toString();
	const res = await githubConditionalJson<RawCommit[]>(env, {
		identity: { userId: repo.user_id, authContext: await githubAuthContext(env, repo.user_id, owner, token) },
		repo: repo.github_repo,
		resource: COMMITS_RESOURCE,
		variant: qs,
		url: `https://api.github.com/repos/${repo.github_repo}/commits?${qs}`,
		headers: { ...GH_HEADERS(token) },
	});
	if (!res.ok) {
		await recordDeclined(env, repo, `GitHub returned ${res.status ?? "no status"} for the commits page`);
		return;
	}
	if (res.stale) {
		// GitHub was unreachable and the conditional cache served its stored copy. A stored page can
		// name commits that are no longer the newest, and acting on it would close issues from a
		// snapshot. Stamp the rotation key, touch neither half of the watermark.
		await recordDeclined(env, repo, "github unreachable — served a stored commits page");
		return;
	}

	const commits: ScannedCommit[] = (Array.isArray(res.data) ? res.data : []).map((raw) => ({
		sha: typeof raw?.sha === "string" ? raw.sha : "",
		message: typeof raw?.commit?.message === "string" ? raw.commit.message : "",
		committedAt: typeof raw?.commit?.committer?.date === "string" ? raw.commit.committer.date : "",
	}));

	const decision = decideCommitScan(commits, {
		lastSha: repo.last_scanned_commit_sha,
		lastAt: repo.last_scanned_commit_at,
		now: Date.now(),
	});
	if (!decision.scan) {
		if (decision.reason === "stale-page") {
			await recordDeclined(env, repo, "commits page is older than the commit already scanned");
			return;
		}
		await writeWatermark(env, repo.id, decision.seenSha, decision.seenAt);
		return;
	}
	if (decision.gap) {
		await recordDeclined(env, repo, `watermark ${repo.last_scanned_commit_sha ?? "?"} was not on the page — older commits were not scanned`);
		// Deliberately NOT a `return`: the commits on this page are still real and unscanned, and
		// refusing them would turn "we fell behind" into "we stopped". The gap is recorded, the
		// page is scanned, and the watermark catches up.
	}

	let closures = 0;
	for (const commit of decision.commits) {
		for (const ref of parseClosingRefs(commit.message)) {
			if (closures >= COMMIT_CLOSE_MAX_CLOSURES_PER_REPO) {
				await recordDeclined(env, repo, `hit the ${COMMIT_CLOSE_MAX_CLOSURES_PER_REPO}-closure ceiling for one sweep`);
				// The watermark is still advanced below. The alternative — holding it — would
				// re-present the same commits next tick and close the next five, walking history five
				// issues per minute. A ceiling that a retry defeats is not a ceiling.
				await writeWatermark(env, repo.id, decision.seenSha, decision.seenAt);
				return;
			}
			const outcome = await closeIssueForCommit(env, {
				userId: repo.user_id,
				githubRepo: repo.github_repo,
				token,
				ref,
				sha: commit.sha,
			});
			if (outcome === "closed") closures += 1;
		}
	}
	await writeWatermark(env, repo.id, decision.seenSha, decision.seenAt);
	// The commit list for this repo has moved on, so the cached page is now the previous answer.
	// Left in place it would be re-served on the next 304 and the watermark comparison would run
	// against a page that no longer contains the newest commit.
	await invalidateGithubCache(env, repo.user_id, repo.github_repo, COMMITS_RESOURCE).catch(() => undefined);
}

/**
 * One sweep. Never throws — a broken watcher must not take the cron down with it, and the other
 * sweeps sharing that handler are independent failure domains.
 */
export async function runCommitCloseWatch(env: Env): Promise<void> {
	let repos: RepoRow[] = [];
	try {
		// Oldest-checked first, so a bounded batch still rotates over every repo instead of
		// starving the tail.
		const { results } = await env.DB.prepare(
			`SELECT id, instance_id, user_id, github_repo, last_scanned_commit_sha, last_scanned_commit_at
			   FROM coding_repos
			  WHERE github_repo IS NOT NULL AND github_repo <> ''
			  ORDER BY COALESCE(last_commit_scan_at, '') ASC
			  LIMIT ?1`,
		)
			.bind(COMMIT_CLOSE_BATCH)
			.all<RepoRow>();
		repos = results ?? [];
	} catch (err) {
		// Split by cause, as `deploy-watch` learned in #745: a missing column on a fresh or
		// mid-migration environment is expected and settles itself, a failing SELECT on a migrated
		// one does not. Both write a row — the defect that guard fixed is the silence, not the level.
		const detail = err instanceof Error ? err.message : String(err);
		const notMigrated = /no such (table|column)/i.test(detail);
		await logError(env, {
			source: "commit-close-watch",
			level: notMigrated ? "warn" : "error",
			message: notMigrated
				? `commit-close sweep skipped: coding_repos not migrated to 0153 yet (${detail})`
				: `commit-close sweep could not read coding_repos, so NO repo was scanned this tick: ${detail}`,
			context: { query: "SELECT coding_repos FOR commit close watch", batch: COMMIT_CLOSE_BATCH },
		}).catch(() => undefined);
		return;
	}

	for (const repo of repos) {
		try {
			await sweepRepo(env, repo);
		} catch (err) {
			// One repo's failure must not end the sweep for the rest — and must not be free either.
			// `logError` collapses repeats into one row with a count, so a permanently broken repo is
			// a rising number rather than 1,440 rows a day.
			await logError(env, {
				source: "commit-close-watch",
				level: "warn",
				message: `commit-close skipped ${repo.github_repo}: ${err instanceof Error ? err.message : String(err)}`,
				userId: repo.user_id,
				context: { repoId: repo.id, instanceId: repo.instance_id, githubRepo: repo.github_repo },
			}).catch(() => undefined);
		}
	}
}
