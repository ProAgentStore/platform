/**
 * "Ask this repo's HOST about it" — one dispatcher for issues and builds, over any provider
 * (#221, phase 3).
 *
 * ── The question this answers, and the one it refuses to
 *
 * Five call sites used to open with the same line — `if (!repo.githubRepo?.includes("/"))` —
 * and then call a GitHub client. That single expression was carrying three different claims at
 * once: *is this repo hosted*, *do we know its coordinate*, and *is its host one we can drive*.
 * Fusing them is why a correctly-added GitLab repo was told it "isn't connected to GitHub": the
 * only false thing about it was the third claim, and the sentence reported the second.
 *
 * So the dispatcher separates them. `hostedReadRefusal` answers "can this repo be asked at
 * all", and returns the ONE sentence explaining why not; the readers answer "what did the host
 * say". A surface that has a refusal never reaches a client, and a client never has to invent a
 * reason for an empty result.
 *
 * ── What is abstracted, and what deliberately is not
 *
 * The OUTPUT is: `IssueSummary` / `IssueDetail` / `BuildRun`, unchanged, so the console, the
 * build history in KV and the Co-pilot's issue tools read one shape whatever the host is. The
 * INPUT is not: `github-issues.ts` still takes `owner/repo` and still mints an installation
 * token bound to a verified installation; `gitlab-api.ts` takes a nested project path and reads
 * a user-scoped PAT. `git-providers.ts` sets out at length why generalising GitHub's
 * owner-scoped grant model into the interface would force every other provider to lie to it —
 * that argument applies here unchanged, which is why this module dispatches between two clients
 * rather than parameterising one.
 *
 * ── Nothing about GitHub changes
 *
 * Every GitHub branch below is the code that was inline at its call site, moved: the same
 * `resolveGithubRead` that keeps the conditional cache's identity and the token it was minted
 * under from the SAME resolution (#401/#418), the same unauthenticated fallback for a public
 * repo's Actions runs, the same `{available:false}` degradation. GitHub is the only provider in
 * production use, and this is a re-route, not a rewrite.
 */
import { githubAppConfigured, installationTokenForOwner } from "./github-app.js";
import { resolveGithubRead } from "./github-cache.js";
import { fetchWorkflowRuns, mapWorkflowRun } from "./github-actions.js";
import { listIssues, readIssue, type IssueDetail, type IssueSummary, type ListIssuesOpts } from "./github-issues.js";
import { listGitlabIssues, listGitlabPipelines, readGitlabIssue } from "./gitlab-api.js";
import { gitProviderFor, hostedFeatureUnavailable, supportsHostedFeature, type HostedFeature } from "./git-providers.js";
import type { BuildRun } from "./build-history.js";
import type { Env } from "../types.js";

/** The fields of a `coding_repos` row a hosted read needs — nothing else. */
export interface HostedRepoRef {
	provider?: string | null;
	/** GitHub's `owner/name`. Still the compatibility identity for rows written before 0097. */
	githubRepo?: string | null;
	/** The provider-neutral slug (`group/subgroup/project` on GitLab). */
	repoSlug?: string | null;
}

/**
 * A repo with no stored `provider` still has to resolve — the same back-compatibility rule
 * `git-credentials.ts` applies, for the same rows. `github_repo` present means GitHub; that is
 * the only thing the column could ever have meant.
 */
function providerOf(repo: HostedRepoRef) {
	if (repo.provider) return gitProviderFor(repo.provider);
	return gitProviderFor(repo.githubRepo ? "github" : "local");
}

/**
 * The coordinate to ask the host about.
 *
 * `repoSlug` first, `githubRepo` as the fallback: migration 0097 backfilled the slug from the
 * column, but a row inserted by an older code path (or a test fixture) can still carry only the
 * legacy one, and a GitHub repo that silently stopped answering because its slug column was
 * null would be exactly the regression this whole change must not cause.
 */
export function hostedCoordinate(repo: HostedRepoRef): string {
	return String(repo.repoSlug || repo.githubRepo || "").trim();
}

/**
 * Can this repo be asked about `feature`? `null` means yes; a string is the one sentence to
 * show the owner, already phrased for the actual reason.
 *
 * The `includes("/")` check is kept, not tightened: it is the exact guard the five call sites
 * had, it is what distinguishes a coordinate from the bare name add-repo accepts on trust, and
 * every provider's coordinate has at least one separator.
 */
export function hostedReadRefusal(repo: HostedRepoRef, feature: HostedFeature): string | null {
	const provider = providerOf(repo);
	if (!supportsHostedFeature(provider, feature)) return hostedFeatureUnavailable(provider, feature);
	if (!hostedCoordinate(repo).includes("/")) return hostedFeatureUnavailable(provider, feature);
	return null;
}

/** Shorthand for the surfaces that only need the boolean (the Builds panel's `available`). */
export function canReadHosted(repo: HostedRepoRef, feature: HostedFeature): boolean {
	return hostedReadRefusal(repo, feature) === null;
}

/** List the repo's issues. `[]` for anything unreadable — never throws (both clients degrade). */
export async function listHostedIssues(env: Env, userId: string, repo: HostedRepoRef, opts: ListIssuesOpts = {}): Promise<IssueSummary[]> {
	if (!canReadHosted(repo, "issues")) return [];
	const slug = hostedCoordinate(repo);
	switch (providerOf(repo).id) {
		case "github":
			return listIssues(env, userId, slug, opts);
		case "gitlab":
			return listGitlabIssues(env, userId, slug, opts);
		default:
			return [];
	}
}

/** Read one issue by the number a human sees (`iid` on GitLab). `null` when absent. */
export async function readHostedIssue(env: Env, userId: string, repo: HostedRepoRef, number: number): Promise<IssueDetail | null> {
	if (!canReadHosted(repo, "issues")) return null;
	const slug = hostedCoordinate(repo);
	switch (providerOf(repo).id) {
		case "github":
			return readIssue(env, userId, slug, number);
		case "gitlab":
			return readGitlabIssue(env, userId, slug, number);
		default:
			return null;
	}
}

/**
 * The latest build for a repo, for the Builds panel and the aggregate `/builds` fan-out.
 *
 * `available:false` is the answer to "we could not ask" — a missing installation, a host with
 * no client, a GitHub error. `{available:true, run:null}` is the different and useful answer
 * "asked, and there are no builds yet". Never throws, because `/builds` fans this out per repo
 * and one repo's failure must not fail the response.
 */
export async function latestHostedBuild(env: Env, userId: string, repo: HostedRepoRef): Promise<{ available: boolean; run: BuildRun | null }> {
	if (!canReadHosted(repo, "builds")) return { available: false, run: null };
	const slug = hostedCoordinate(repo);
	switch (providerOf(repo).id) {
		case "github": {
			if (!githubAppConfigured(env)) return { available: false, run: null };
			// The token AND the cache identity come from ONE resolution (#418): an identity picked
			// up from the surrounding request is precisely the cross-tenant read the cache is
			// written to prevent, and an unnameable installation resolves to `authContext:null`,
			// which means "do not cache" rather than "use someone else's entry".
			const { token, authContext } = await resolveGithubRead(env, userId, slug.split("/")[0] ?? "");
			if (!token) return { available: false, run: null };
			const res = await fetchWorkflowRuns(slug, token, { perPage: 1 }, { env, identity: { userId, authContext } });
			if ("status" in res) return { available: false, run: null };
			return { available: true, run: res.runs[0] ? mapWorkflowRun(res.runs[0]) : null };
		}
		case "gitlab": {
			const runs = await listGitlabPipelines(env, userId, slug, { perPage: 1 });
			if (!runs) return { available: false, run: null };
			return { available: true, run: runs[0] ?? null };
		}
		default:
			return { available: false, run: null };
	}
}

/**
 * A page of build history, newest first — the Builds panel's drill-down. `null` means "could not
 * ask" so the route can answer `{available:false}` without inventing an empty history.
 */
export async function listHostedBuilds(env: Env, userId: string, repo: HostedRepoRef, opts: { page: number; perPage: number }): Promise<BuildRun[] | null> {
	if (!canReadHosted(repo, "builds")) return null;
	const slug = hostedCoordinate(repo);
	switch (providerOf(repo).id) {
		case "github": {
			// The unauthenticated fallback is deliberate and stays (CODER-010, #121): a public
			// repo's Actions runs are readable without the App installed, which is the difference
			// between this per-repo route and the `/builds` fan-out that must not burn the shared
			// anonymous budget.
			const owner = slug.split("/")[0] ?? "";
			const token = githubAppConfigured(env) ? await installationTokenForOwner(env, userId, owner).catch(() => null) : null;
			const res = await fetchWorkflowRuns(slug, token ?? undefined, { perPage: opts.perPage, page: opts.page });
			if ("status" in res) return null;
			return res.runs.map(mapWorkflowRun);
		}
		case "gitlab":
			return listGitlabPipelines(env, userId, slug, { perPage: opts.perPage, page: opts.page });
		default:
			return null;
	}
}
